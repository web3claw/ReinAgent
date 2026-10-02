/**
 * 会话导入器（移植自 PI-Desktop importers/{claude,opencode,codex,pi}.ts）。
 *
 * 四家格式 → 统一 ImportedSession：
 * - Claude Code：逐行 JSON；只取 user/assistant 非 sidechain 行；tool_use 与后续
 *   user 行里的 tool_result 按 tool_use_id 配对；`<` 开头的合成用户行过滤。
 * - OpenCode：session/message/part 三层目录；text part 拼正文（synthetic 跳过）、
 *   tool part 的 state.input/output 映射工具消息。
 * - Codex：兼容新旧两种 jsonl；新格式 {timestamp,type,payload}（session_meta +
 *   response_item），旧格式裸 header + 裸行；function_call ↔ output 按 call_id
 *   配对；合成前缀白名单过滤；大文件采样扫描（头 1MB/尾 256KB + 顺序续读找标题）。
 * - Pi：首行 session header + message 条目；toolCall 块与 toolResult 按 id 配对。
 */

import {
  importedSessionId,
  toIso,
  truncateTitle,
  type ExternalSessionSummary,
  type ImportedSession,
  type ImportedUiMessage,
  type SessionImporter,
} from "./types.ts";
import { homeJoin, type ImportFs } from "./fsApi.ts";

const CODEX_SCAN_FULL_PARSE_MAX_BYTES = 5 * 1024 * 1024;
/** ~/.codex/sessions/YYYY/MM/DD 目录名倒序 ≈ 日期倒序的创建时间代理。 */
export const CODEX_SCAN_MAX_FILES = 250;
const CODEX_SCAN_HEAD_BYTES = 1024 * 1024;
const CODEX_SCAN_TAIL_BYTES = 256 * 1024;
/** 采样继续找标题时的顺序续读上限（PI 为流式直至找到；这里按块续读封顶）。 */
const CODEX_SCAN_CONTINUE_MAX_BYTES = 8 * 1024 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;

function uuid(): string {
  return crypto.randomUUID();
}

// ==================== Claude Code ====================

interface ClaudeLine {
  type?: string;
  isSidechain?: boolean;
  timestamp?: string;
  cwd?: string;
  message?: {
    role?: string;
    model?: string;
    content?: string | Array<Record<string, any>>;
  };
}

function parseJsonLines<T>(raw: string): T[] {
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // 跳过残行
    }
  }
  return out;
}

function isConversationLine(line: ClaudeLine): boolean {
  return (
    (line.type === "user" || line.type === "assistant") &&
    line.isSidechain !== true &&
    !!line.message
  );
}

function blockText(content: string | Array<Record<string, any>> | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// Claude Code 会注入合成用户行（命令 caveat、system-reminder、斜杠命令转录），都以 XML 风格标签开头。
function isSyntheticUserText(text: string): boolean {
  return text.startsWith("<");
}

export function createClaudeImporter(fs: ImportFs, home: string): SessionImporter {
  const PROJECTS_DIR = homeJoin(home, ".claude", "projects");
  return {
    source: "claude-code",

    async scan(): Promise<ExternalSessionSummary[]> {
      let projectDirs: string[] = [];
      try {
        projectDirs = await fs.listDir(PROJECTS_DIR);
      } catch {
        return [];
      }
      const summaries: ExternalSessionSummary[] = [];
      for (const dir of projectDirs) {
        const dirPath = homeJoin(PROJECTS_DIR, dir);
        let files: string[] = [];
        try {
          files = (await fs.listDir(dirPath)).filter((f) => f.endsWith(".jsonl"));
        } catch {
          continue;
        }
        for (const file of files) {
          const filePath = homeJoin(dirPath, file);
          try {
            const raw = await fs.readText(filePath);
            if (raw == null) continue;
            const convo = parseJsonLines<ClaudeLine>(raw).filter(isConversationLine);
            if (convo.length === 0) continue;
            const firstUser = convo.find((l) => {
              if (l.type !== "user") return false;
              const text = blockText(l.message?.content);
              return !!text && !isSyntheticUserText(text);
            });
            const model =
              convo.find((l) => l.type === "assistant" && l.message?.model)?.message?.model ??
              null;
            summaries.push({
              source: "claude-code",
              externalId: file.replace(/\.jsonl$/, ""),
              title:
                truncateTitle(blockText(firstUser?.message?.content) || "") ||
                file.replace(/\.jsonl$/, ""),
              projectPath: convo[0]?.cwd ?? null,
              model,
              createdAt: toIso(convo[0]?.timestamp),
              updatedAt: toIso(convo[convo.length - 1]?.timestamp),
              messageCount: convo.length,
              filePath,
            });
          } catch {
            // 不可读的会话文件——跳过
          }
        }
      }
      return summaries;
    },

    async convert(summary: ExternalSessionSummary): Promise<ImportedSession> {
      const raw = await fs.readText(summary.filePath);
      const lines = parseJsonLines<ClaudeLine>(raw ?? "").filter(isConversationLine);
      const messages: ImportedUiMessage[] = [];
      const pendingTools = new Map<string, { name: string; args: unknown; createdAt: string }>();

      for (const line of lines) {
        const createdAt = toIso(line.timestamp);
        const content = line.message?.content;
        const blocks = Array.isArray(content) ? content : null;

        if (line.type === "assistant") {
          const text = blockText(content);
          if (text) {
            messages.push({ id: uuid(), role: "assistant", content: text, createdAt, status: "complete" });
          }
          for (const b of blocks ?? []) {
            if (b.type === "tool_use" && b.id) {
              pendingTools.set(b.id, { name: b.name, args: b.input, createdAt });
            }
          }
        } else if (line.type === "user") {
          const toolResults = (blocks ?? []).filter((b) => b.type === "tool_result");
          if (toolResults.length > 0) {
            for (const b of toolResults) {
              const pending = pendingTools.get(b.tool_use_id);
              pendingTools.delete(b.tool_use_id);
              const resultText = typeof b.content === "string" ? b.content : blockText(b.content);
              messages.push({
                id: uuid(),
                role: "tool",
                content: resultText,
                createdAt,
                toolName: pending?.name,
                toolCallId: b.tool_use_id,
                toolStatus: b.is_error ? "error" : "success",
                toolArgs: pending?.args,
                toolResult: resultText,
                isError: b.is_error === true || undefined,
                status: "complete",
              });
            }
          } else {
            const text = blockText(content);
            if (text && !isSyntheticUserText(text)) {
              messages.push({ id: uuid(), role: "user", content: text, createdAt });
            }
          }
        }
      }

      return {
        session: {
          id: importedSessionId("claude-code", summary.externalId),
          title: summary.title,
          projectPath: summary.projectPath,
          modelId: summary.model,
          providerId: null,
          mode: "agent",
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
        },
        messages,
      };
    },
  };
}

// ==================== OpenCode ====================

interface OpenCodeSession {
  id: string;
  title?: string;
  directory?: string;
  projectID?: string;
  time?: { created?: number; updated?: number };
}

interface OpenCodeMessage {
  id: string;
  sessionID: string;
  role?: string;
  modelID?: string;
  providerID?: string;
  time?: { created?: number; completed?: number };
}

interface OpenCodePart {
  id: string;
  type?: string;
  text?: string;
  synthetic?: boolean;
  tool?: string;
  callID?: string;
  state?: { input?: unknown; output?: unknown; status?: string };
}

export function createOpencodeImporter(fs: ImportFs, home: string): SessionImporter {
  const STORAGE_DIR = homeJoin(home, ".local", "share", "opencode", "storage");
  return {
    source: "opencode",

    async scan(): Promise<ExternalSessionSummary[]> {
      const sessionRoot = homeJoin(STORAGE_DIR, "session");
      let projectDirs: string[] = [];
      try {
        projectDirs = await fs.listDir(sessionRoot);
      } catch {
        return [];
      }
      const summaries: ExternalSessionSummary[] = [];
      for (const dir of projectDirs) {
        const dirPath = homeJoin(sessionRoot, dir);
        let files: string[] = [];
        try {
          files = (await fs.listDir(dirPath)).filter((f) => f.endsWith(".json")).sort();
        } catch {
          continue;
        }
        for (const file of files) {
          const filePath = homeJoin(dirPath, file);
          let session: OpenCodeSession | null = null;
          try {
            const raw = await fs.readText(filePath);
            session = raw ? (JSON.parse(raw) as OpenCodeSession) : null;
          } catch {
            session = null;
          }
          if (!session?.id) continue;
          let messageCount = 0;
          try {
            messageCount = (await fs.listDir(homeJoin(STORAGE_DIR, "message", session.id))).filter(
              (f) => f.endsWith(".json"),
            ).length;
          } catch {
            continue;
          }
          if (messageCount === 0) continue;
          summaries.push({
            source: "opencode",
            externalId: session.id,
            title: truncateTitle(session.title ?? "") || session.id,
            projectPath: session.directory ?? null,
            model: null,
            createdAt: toIso(session.time?.created),
            updatedAt: toIso(session.time?.updated, toIso(session.time?.created)),
            messageCount,
            filePath,
          });
        }
      }
      return summaries;
    },

    async convert(summary: ExternalSessionSummary): Promise<ImportedSession> {
      const messageDir = homeJoin(STORAGE_DIR, "message", summary.externalId);
      const files = (await fs.listDir(messageDir)).filter((f) => f.endsWith(".json")).sort();
      const ocMessages: OpenCodeMessage[] = [];
      for (const file of files) {
        try {
          const raw = await fs.readText(homeJoin(messageDir, file));
          if (raw) ocMessages.push(JSON.parse(raw) as OpenCodeMessage);
        } catch {
          // 跳过坏文件
        }
      }
      ocMessages.sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));

      const messages: ImportedUiMessage[] = [];
      let modelId: string | null = null;
      let providerId: string | null = null;

      for (const msg of ocMessages) {
        if (msg.role === "assistant") {
          modelId = msg.modelID ?? modelId;
          providerId = msg.providerID ?? providerId;
        }
        const createdAt = toIso(msg.time?.created);
        const partDir = homeJoin(STORAGE_DIR, "part", msg.id);
        const partFiles = (await fs.listDir(partDir)).filter((f) => f.endsWith(".json")).sort();
        const texts: string[] = [];
        const toolMessages: ImportedUiMessage[] = [];
        for (const file of partFiles) {
          let part: OpenCodePart | null = null;
          try {
            const raw = await fs.readText(homeJoin(partDir, file));
            part = raw ? (JSON.parse(raw) as OpenCodePart) : null;
          } catch {
            part = null;
          }
          if (!part) continue;
          if (part.type === "text" && part.text && part.synthetic !== true) {
            texts.push(part.text);
          } else if (part.type === "tool") {
            const output = part.state?.output;
            const outputText =
              typeof output === "string" ? output : output ? JSON.stringify(output) : "";
            toolMessages.push({
              id: uuid(),
              role: "tool",
              content: outputText,
              createdAt,
              toolName: part.tool,
              toolCallId: part.callID,
              toolStatus: part.state?.status === "error" ? "error" : "success",
              toolArgs: part.state?.input,
              toolResult: outputText,
              isError: part.state?.status === "error" || undefined,
              status: "complete",
            });
          }
        }
        const text = texts.join("\n").trim();
        if (text) {
          messages.push({
            id: uuid(),
            role: msg.role === "user" ? "user" : "assistant",
            content: text,
            createdAt,
            status: msg.role === "assistant" ? "complete" : undefined,
          });
        }
        messages.push(...toolMessages);
      }

      return {
        session: {
          id: importedSessionId("opencode", summary.externalId),
          title: summary.title,
          projectPath: summary.projectPath,
          modelId,
          providerId,
          mode: "agent",
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
        },
        messages,
      };
    },
  };
}

// ==================== Codex CLI ====================

interface CodexItem {
  type?: string;
  role?: string;
  content?: Array<Record<string, any>>;
  name?: string;
  arguments?: string;
  call_id?: string;
  output?: string;
}

function itemText(item: CodexItem): string {
  if (!Array.isArray(item.content)) return "";
  return item.content
    .filter(
      (c) =>
        (c.type === "input_text" || c.type === "output_text" || c.type === "text") &&
        typeof c.text === "string",
    )
    .map((c) => c.text)
    .join("\n")
    .trim();
}

// Codex 会在开头注入携带仓库说明/IDE 上下文/工具状态的合成用户消息，扫描标题必须
// 跳过它们。清单按真实归档证据维护（真实用户消息也可能以 "# " 开头——粘贴的
// markdown——所以按精确前缀匹配而不是一刀切的 "#" 规则）。
const SYNTHETIC_USER_PREFIXES = [
  "<",
  "# AGENTS.md",
  "# Context from my IDE setup",
  "# In app browser:",
  "# Browser comments:",
  "# Files mentioned by the user:",
  "# Diff comments:",
  "# Selected text:",
  "# Review findings:",
  "You are Codex",
];

function isCodexSyntheticUserText(text: string): boolean {
  return SYNTHETIC_USER_PREFIXES.some((prefix) => text.startsWith(prefix));
}

interface CodexScanMeta {
  externalId: string;
  cwd: string | null;
  startedAt: string | null;
  lastAt: string | null;
  mtimeMs: number | null;
  /** 精确条目数；文件过大走采样时为 null。 */
  itemCount: number | null;
  sawItem: boolean;
  firstUserText: string | null;
}

function newScanMeta(): CodexScanMeta {
  return { externalId: "", cwd: null, startedAt: null, lastAt: null, mtimeMs: null, itemCount: 0, sawItem: false, firstUserText: null };
}

/** 与完整解析逐行语义一致的扫描字段提取。 */
function applyCodexLine(line: string, meta: CodexScanMeta): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let obj: Record<string, any>;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return;
  }
  // 新格式：所有行都包在 {timestamp, type, payload} 里。
  if (obj.type === "session_meta" && obj.payload) {
    meta.externalId = obj.payload.id ?? meta.externalId;
    meta.cwd = obj.payload.cwd ?? meta.cwd;
    meta.startedAt = obj.payload.timestamp ?? obj.timestamp ?? meta.startedAt;
    return;
  }
  if (obj.type === "response_item" && obj.payload) {
    if (meta.itemCount !== null) meta.itemCount += 1;
    meta.sawItem = true;
    if (obj.timestamp) meta.lastAt = obj.timestamp;
    if (meta.firstUserText === null) {
      const item = obj.payload as CodexItem;
      if (item.type === "message" && item.role === "user") {
        const text = itemText(item);
        if (text && !isCodexSyntheticUserText(text)) meta.firstUserText = text;
      }
    }
    return;
  }
  // 旧格式：首行是裸 session header，条目是裸行。
  if (!meta.externalId && obj.id && obj.timestamp && !obj.type) {
    meta.externalId = obj.id;
    meta.startedAt = obj.timestamp;
    meta.cwd = obj.cwd ?? null;
    return;
  }
  if (obj.type === "message" || obj.type === "function_call" || obj.type === "function_call_output") {
    if (meta.itemCount !== null) meta.itemCount += 1;
    meta.sawItem = true;
    if (obj.timestamp) meta.lastAt = obj.timestamp;
    if (meta.firstUserText === null && obj.type === "message" && obj.role === "user") {
      const text = itemText(obj as CodexItem);
      if (text && !isCodexSyntheticUserText(text)) meta.firstUserText = text;
    }
  }
}

interface ParsedCodexFile {
  externalId: string;
  cwd: string | null;
  startedAt: string | null;
  lastAt: string | null;
  items: Array<{ item: CodexItem; timestamp: string | null }>;
}

async function parseCodexFile(fs: ImportFs, filePath: string): Promise<ParsedCodexFile | null> {
  const raw = await fs.readText(filePath);
  if (raw == null) return null;
  const parsed: ParsedCodexFile = { externalId: "", cwd: null, startedAt: null, lastAt: null, items: [] };
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, any>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj.type === "session_meta" && obj.payload) {
      parsed.externalId = obj.payload.id ?? parsed.externalId;
      parsed.cwd = obj.payload.cwd ?? parsed.cwd;
      parsed.startedAt = obj.payload.timestamp ?? obj.timestamp ?? parsed.startedAt;
      continue;
    }
    if (obj.type === "response_item" && obj.payload) {
      parsed.items.push({ item: obj.payload, timestamp: obj.timestamp ?? null });
      if (obj.timestamp) parsed.lastAt = obj.timestamp;
      continue;
    }
    if (!parsed.externalId && obj.id && obj.timestamp && !obj.type) {
      parsed.externalId = obj.id;
      parsed.startedAt = obj.timestamp;
      parsed.cwd = obj.cwd ?? null;
      continue;
    }
    if (obj.type === "message" || obj.type === "function_call" || obj.type === "function_call_output") {
      parsed.items.push({ item: obj, timestamp: obj.timestamp ?? null });
      if (obj.timestamp) parsed.lastAt = obj.timestamp;
    }
  }
  if (!parsed.externalId) {
    parsed.externalId = filePath.split(/[\\/]/).pop()?.replace(/\.jsonl$/, "") ?? "";
  }
  return parsed.items.length > 0 ? parsed : null;
}

export async function listCodexSessionFiles(
  fs: ImportFs,
  dir: string,
  maxFiles: number = CODEX_SCAN_MAX_FILES,
): Promise<{ files: string[]; truncated: boolean }> {
  const out: string[] = [];
  let truncated = false;
  const walk = async (dir: string, depth: number) => {
    let entries: string[] = [];
    try {
      entries = await fs.listDir(dir);
    } catch {
      return;
    }
    entries.sort().reverse();
    for (const entry of entries) {
      if (out.length >= maxFiles) {
        truncated = true;
        return;
      }
      const full = homeJoin(dir, entry);
      if (entry.endsWith(".jsonl")) {
        out.push(full);
      } else if (depth < 3) {
        await walk(full, depth + 1);
      }
    }
  };
  await walk(dir, 0);
  return { files: out, truncated };
}

/**
 * 采样扫描（对齐 PI #264）：超过全量解析阈值的文件只读头/尾 + 必要时顺序续读找
 * 标题；messageCount = null（精确计数需要整读文件，与采样目的相悖）。
 */
async function scanCodexFile(fs: ImportFs, filePath: string): Promise<CodexScanMeta | null> {
  const ends = await fs.readEnds(filePath, CODEX_SCAN_HEAD_BYTES, CODEX_SCAN_TAIL_BYTES);
  if (!ends) return null;
  const meta = newScanMeta();
  meta.mtimeMs = ends.mtimeMs;
  if (ends.totalBytes <= CODEX_SCAN_FULL_PARSE_MAX_BYTES) {
    const raw = await fs.readText(filePath);
    if (raw != null) {
      for (const line of raw.split("\n")) applyCodexLine(line, meta);
      if (!meta.sawItem) return null;
      if (!meta.externalId) meta.externalId = filePath.split(/[\\/]/).pop()?.replace(/\.jsonl$/, "") ?? "";
      return meta;
    }
  }
  meta.itemCount = null;
  for (const line of ends.head.split("\n")) applyCodexLine(line, meta);
  const headBoundary = ends.head.length > 0 ? Math.min(ends.totalBytes, CODEX_SCAN_HEAD_BYTES) : 0;

  if (meta.firstUserText === null && ends.totalBytes > headBoundary) {
    // 标题在头部采样之外（大段合成前导）：从头部边界起按块顺序续读，直到找到
    // 或达到续读上限。
    let offset = headBoundary;
    let carry = "";
    while (meta.firstUserText === null && offset < ends.totalBytes) {
      if (offset - headBoundary >= CODEX_SCAN_CONTINUE_MAX_BYTES) break;
      const chunk = await fs.readRange(filePath, offset, READ_CHUNK_BYTES);
      if (!chunk) break;
      const text = carry + chunk;
      const lines = text.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) applyCodexLine(line, meta);
      offset += READ_CHUNK_BYTES;
    }
    if (meta.firstUserText === null && carry.trim()) applyCodexLine(carry, meta);
  }

  if (meta.startedAt !== null) {
    // 尾部最后一个顶层 timestamp（嵌套 payload 的 timestamp 不是记录时间戳，
    // 不能挪动 updatedAt——与完整解析的 obj.timestamp 语义一致）。
    let last: string | null = null;
    for (const line of ends.tail.split("\n")) {
      try {
        const obj = JSON.parse(line.trim()) as Record<string, unknown>;
        if (typeof obj.timestamp === "string" && obj.timestamp) last = obj.timestamp;
      } catch {
        // 采样边界上的首/尾行可能残缺
      }
    }
    if (last !== null) meta.lastAt = last;
  }
  if (!meta.sawItem) return null;
  if (!meta.externalId) meta.externalId = filePath.split(/[\\/]/).pop()?.replace(/\.jsonl$/, "") ?? "";
  return meta;
}

export interface CodexScanResult {
  sessions: ExternalSessionSummary[];
  truncated: boolean;
}

export async function scanCodexSessionsResult(
  fs: ImportFs,
  home: string,
  maxFiles: number = CODEX_SCAN_MAX_FILES,
): Promise<CodexScanResult> {
  const dir = homeJoin(home, ".codex", "sessions");
  const { files, truncated } = await listCodexSessionFiles(fs, dir, maxFiles);
  const sessions: ExternalSessionSummary[] = [];
  for (const filePath of files) {
    const meta = await scanCodexFile(fs, filePath);
    if (!meta || meta.firstUserText === null) continue;
    // 存储时间戳损坏/越界时不得把会话历史改写成导入时刻：文件自身 mtime 是两端的诚实回退。
    const fileTime = toIso(meta.mtimeMs ?? undefined);
    sessions.push({
      source: "codex",
      externalId: meta.externalId,
      title: truncateTitle(meta.firstUserText) || meta.externalId,
      projectPath: meta.cwd,
      model: null,
      createdAt: toIso(meta.startedAt, fileTime),
      updatedAt: toIso(meta.lastAt, toIso(meta.startedAt, fileTime)),
      messageCount: meta.itemCount,
      filePath,
    });
  }
  return { sessions, truncated };
}

export function createCodexImporter(fs: ImportFs, home: string): SessionImporter {
  return {
    source: "codex",

    async scan(): Promise<ExternalSessionSummary[]> {
      return (await scanCodexSessionsResult(fs, home)).sessions;
    },

    async convert(summary: ExternalSessionSummary): Promise<ImportedSession> {
      const parsed = await parseCodexFile(fs, summary.filePath);
      const messages: ImportedUiMessage[] = [];
      const pendingCalls = new Map<string, { name: string; args: unknown }>();

      for (const { item, timestamp } of parsed?.items ?? []) {
        const createdAt = toIso(timestamp, summary.createdAt);
        if (item.type === "message") {
          const text = itemText(item);
          if (!text || (item.role === "user" && isCodexSyntheticUserText(text))) continue;
          messages.push({
            id: uuid(),
            role: item.role === "user" ? "user" : "assistant",
            content: text,
            createdAt,
            status: item.role === "assistant" ? "complete" : undefined,
          });
        } else if (item.type === "function_call" && item.call_id) {
          let args: unknown = item.arguments;
          try {
            args = JSON.parse(item.arguments ?? "");
          } catch {
            // 保留原始字符串
          }
          pendingCalls.set(item.call_id, { name: item.name ?? "tool", args });
        } else if (item.type === "function_call_output" && item.call_id) {
          const pending = pendingCalls.get(item.call_id);
          pendingCalls.delete(item.call_id);
          const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output);
          messages.push({
            id: uuid(),
            role: "tool",
            content: output,
            createdAt,
            toolName: pending?.name,
            toolCallId: item.call_id,
            toolStatus: "success",
            toolArgs: pending?.args,
            toolResult: output,
            status: "complete",
          });
        }
      }

      return {
        session: {
          id: importedSessionId("codex", summary.externalId),
          title: summary.title,
          projectPath: summary.projectPath,
          modelId: summary.model,
          providerId: null,
          mode: "agent",
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
        },
        messages,
      };
    },
  };
}

// ==================== Pi CLI ====================

interface PiEntry {
  type?: string;
  timestamp?: string;
  name?: string;
  message?: {
    role?: string;
    content?: string | Array<Record<string, any>>;
    provider?: string;
    model?: string;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    timestamp?: number;
  };
  // session header 字段
  id?: string;
  cwd?: string;
}

function contentText(content: string | Array<Record<string, any>> | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

async function parsePiFile(fs: ImportFs, filePath: string): Promise<{ header: PiEntry; entries: PiEntry[] } | null> {
  const raw = await fs.readText(filePath);
  if (raw == null) return null;
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return null;
  let header: PiEntry;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return null;
  }
  if (header.type !== "session" || !header.id) return null;
  const entries: PiEntry[] = [];
  for (const line of lines.slice(1)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // 跳过残行
    }
  }
  return { header, entries };
}

export function createPiImporter(fs: ImportFs, home: string): SessionImporter {
  const SESSIONS_DIR = homeJoin(home, ".pi", "agent", "sessions");
  return {
    source: "pi",

    async scan(): Promise<ExternalSessionSummary[]> {
      let dirs: string[] = [];
      try {
        dirs = await fs.listDir(SESSIONS_DIR);
      } catch {
        return [];
      }
      const summaries: ExternalSessionSummary[] = [];
      for (const dir of dirs) {
        const dirPath = homeJoin(SESSIONS_DIR, dir);
        let files: string[] = [];
        try {
          files = (await fs.listDir(dirPath)).filter((f) => f.endsWith(".jsonl"));
        } catch {
          continue;
        }
        for (const file of files) {
          const filePath = homeJoin(dirPath, file);
          const parsed = await parsePiFile(fs, filePath);
          if (!parsed) continue;
          const messageEntries = parsed.entries.filter((e) => e.type === "message");
          if (messageEntries.length === 0) continue;
          const sessionName = parsed.entries
            .filter((e) => e.type === "session_info" && e.name)
            .map((e) => e.name!)
            .pop();
          const firstUser = messageEntries.find(
            (e) => e.message?.role === "user" && contentText(e.message.content),
          );
          const lastTs = messageEntries[messageEntries.length - 1]?.timestamp ?? parsed.header.timestamp;
          summaries.push({
            source: "pi",
            externalId: parsed.header.id!,
            title:
              truncateTitle(sessionName ?? contentText(firstUser?.message?.content) ?? "") ||
              parsed.header.id!,
            projectPath: parsed.header.cwd ?? null,
            model: messageEntries.find((e) => e.message?.role === "assistant")?.message?.model ?? null,
            createdAt: toIso(parsed.header.timestamp),
            updatedAt: toIso(lastTs, toIso(parsed.header.timestamp)),
            messageCount: messageEntries.length,
            filePath,
          });
        }
      }
      return summaries;
    },

    async convert(summary: ExternalSessionSummary): Promise<ImportedSession> {
      const parsed = await parsePiFile(fs, summary.filePath);
      const messages: ImportedUiMessage[] = [];
      const pendingCalls = new Map<string, { name: string; args: unknown }>();
      let providerId: string | null = null;
      let modelId: string | null = null;

      for (const entry of parsed?.entries ?? []) {
        if (entry.type !== "message" || !entry.message) continue;
        const msg = entry.message;
        const createdAt = toIso(msg.timestamp ?? entry.timestamp, summary.createdAt);

        if (msg.role === "user") {
          const text = contentText(msg.content);
          if (text) {
            messages.push({ id: uuid(), role: "user", content: text, createdAt });
          }
        } else if (msg.role === "assistant") {
          providerId = msg.provider ?? providerId;
          modelId = msg.model ?? modelId;
          const text = contentText(msg.content);
          if (text) {
            messages.push({ id: uuid(), role: "assistant", content: text, createdAt, status: "complete" });
          }
          for (const b of Array.isArray(msg.content) ? msg.content : []) {
            if (b.type === "toolCall" && b.id) {
              pendingCalls.set(b.id, { name: b.name, args: b.arguments });
            }
          }
        } else if (msg.role === "toolResult" && msg.toolCallId) {
          const pending = pendingCalls.get(msg.toolCallId);
          pendingCalls.delete(msg.toolCallId);
          const resultText = contentText(msg.content);
          messages.push({
            id: uuid(),
            role: "tool",
            content: resultText,
            createdAt,
            toolName: msg.toolName ?? pending?.name,
            toolCallId: msg.toolCallId,
            toolStatus: msg.isError ? "error" : "success",
            toolArgs: pending?.args,
            toolResult: resultText,
            isError: msg.isError === true || undefined,
            status: "complete",
          });
        }
      }

      return {
        session: {
          id: importedSessionId("pi", summary.externalId),
          title: summary.title,
          projectPath: summary.projectPath,
          modelId,
          providerId,
          mode: "agent",
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
        },
        messages,
      };
    },
  };
}

// ==================== 汇总 ====================

export function createSessionImporters(fs: ImportFs, home: string): SessionImporter[] {
  return [
    createClaudeImporter(fs, home),
    createOpencodeImporter(fs, home),
    createCodexImporter(fs, home),
    createPiImporter(fs, home),
  ];
}
