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
  type ExternalSource,
  type ImportedSession,
  type ImportedUiMessage,
  type SessionImporter,
} from "./types.ts";
import { homeJoin, type ImportDb, type ImportFs, type ImportSqliteResult } from "./fsApi.ts";

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
  /** isMeta=true 的 user 行是宿主注入的命令转录/caveat（Wake 同款判据）——导入噪声。 */
  isMeta?: boolean;
  /** custom-title 行：用户手改的会话标题（Wake 同款最高优先级）。 */
  customTitle?: string;
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
  if (line.type === "user" && line.isMeta === true) return false;
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
            const allLines = parseJsonLines<ClaudeLine>(raw);
            // custom-title 行：用户手改标题，最高优先级（Wake claude.rs 同款序）。
            const customTitle =
              allLines.find((l) => l.type === "custom-title" && l.customTitle?.trim())?.customTitle?.trim() ?? "";
            const convo = allLines.filter(isConversationLine);
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
                truncateTitle(customTitle || blockText(firstUser?.message?.content) || "") ||
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

/**
 * Pi 家族共用解析核心（Wake pi.rs：omp 是 pi 的 fork、会话格式同构，只有数据
 * 根不同——`~/{.pi,.omp}/agent/sessions`）。
 */
function createPiLikeImporter(
  fs: ImportFs,
  home: string,
  dotDir: string,
  source: ExternalSource,
): SessionImporter {
  const SESSIONS_DIR = homeJoin(home, dotDir, "agent", "sessions");
  return {
    source,

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
            source,
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
          id: importedSessionId(source, summary.externalId),
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

export function createPiImporter(fs: ImportFs, home: string): SessionImporter {
  return createPiLikeImporter(fs, home, ".pi", "pi");
}

/** Oh My Pi：pi 的 fork，解析核心完全共用（Wake pi.rs omp() 同款）。 */
export function createOmpImporter(fs: ImportFs, home: string): SessionImporter {
  return createPiLikeImporter(fs, home, ".omp", "omp");
}

// ==================== Kiro ====================
// `~/.kiro/sessions/cli/<uuid>.{jsonl,json}` 三件套（.history 忽略）。jsonl 行
// {kind:Prompt|AssistantMessage|ToolLog,…}；.json 边车含 cwd/title/时间/model
// （Wake kiro.rs 同款：model_id 优先、model_name 兜底）。

interface KiroContentPart {
  kind?: string;
  data?: unknown;
}

function kiroTextOf(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p): p is KiroContentPart => Boolean(p && typeof p === "object") && p.kind === "text")
    .map((p) => (typeof p.data === "string" ? p.data : ""))
    .filter(Boolean)
    .join("\n");
}

export function createKiroImporter(fs: ImportFs, home: string): SessionImporter {
  const CLI_DIR = homeJoin(home, ".kiro", "sessions", "cli");
  return {
    source: "kiro",

    async scan(): Promise<ExternalSessionSummary[]> {
      let files: string[] = [];
      try {
        files = (await fs.listDir(CLI_DIR)).filter((f) => f.endsWith(".jsonl"));
      } catch {
        return [];
      }
      const summaries: ExternalSessionSummary[] = [];
      for (const file of files) {
        const filePath = homeJoin(CLI_DIR, file);
        const raw = await fs.readText(filePath);
        if (raw == null) continue;
        const lines = parseJsonLines<{ kind?: string; data?: { content?: unknown; meta?: { timestamp?: number } } }>(raw);
        const messageLines = lines.filter(
          (l) => l.kind === "Prompt" || l.kind === "AssistantMessage",
        );
        if (messageLines.length === 0) continue;
        // .json 边车（可缺）：cwd/title/时间/model
        const sidecarRaw = await fs.readText(filePath.replace(/\.jsonl$/, ".json"));
        const sidecar = (() => {
          try {
            return sidecarRaw ? (JSON.parse(sidecarRaw) as Record<string, any>) : null;
          } catch {
            return null;
          }
        })();
        const textOf = (l: (typeof messageLines)[number]) =>
          kiroTextOf((l.data as any)?.content);
        const firstUser = messageLines.find((l) => l.kind === "Prompt" && textOf(l));
        const model =
          (sidecar?.session_state?.rts_model_state?.model_info?.model_id as string | undefined) ??
          (sidecar?.session_state?.rts_model_state?.model_info?.model_name as string | undefined) ??
          null;
        const lastTs = messageLines.reduce(
          (acc, l) => Math.max(acc, (l.data as any)?.meta?.timestamp ?? 0),
          0,
        );
        summaries.push({
          source: "kiro",
          externalId: file.replace(/\.jsonl$/, ""),
          title:
            truncateTitle((sidecar?.title as string) || textOf(firstUser!) || "") ||
            file.replace(/\.jsonl$/, ""),
          projectPath: (sidecar?.cwd as string) || null,
          model,
          createdAt: toIso((sidecar?.created_at as string) ?? lastTs * 1000),
          updatedAt: toIso((sidecar?.updated_at as string) ?? lastTs * 1000),
          messageCount: messageLines.length,
          filePath,
        });
      }
      return summaries;
    },

    async convert(summary: ExternalSessionSummary): Promise<ImportedSession> {
      const raw = await fs.readText(summary.filePath);
      const lines = parseJsonLines<{ kind?: string; data?: { content?: unknown; meta?: { timestamp?: number } } }>(
        raw ?? "",
      );
      const messages: ImportedUiMessage[] = [];
      for (const line of lines) {
        if (line.kind !== "Prompt" && line.kind !== "AssistantMessage") continue;
        const text = kiroTextOf(line.data?.content);
        if (!text) continue;
        const createdAt = toIso((line.data?.meta?.timestamp ?? 0) * 1000, summary.createdAt);
        messages.push({
          id: uuid(),
          role: line.kind === "Prompt" ? "user" : "assistant",
          content: text,
          createdAt,
          ...(line.kind === "AssistantMessage" ? { status: "complete" as const } : {}),
        });
      }
      return {
        session: {
          id: importedSessionId("kiro", summary.externalId),
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

// ==================== Qoder ====================
// `~/.qoder/projects/<project-key>/<session-id>.jsonl`（Wake qoder.rs）：uuid +
// parentUuid 消息树，尾部 active-leaf 指向当前分支（explicit null = 已回退空会话）；
// 标题/运行配置是独立元数据行；同名目录的 state/subagents 边车不枚举。

interface QoderRow {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  isMeta?: boolean;
  cwd?: string;
  relocatedCwd?: string;
  customTitle?: string;
  aiTitle?: string;
  leafUuid?: string | null;
  timestamp?: string;
  message?: {
    role?: string;
    model?: string;
    content?: string | Array<Record<string, any>>;
  };
}

/** Wake qoder.rs KNOWN_METADATA_TYPES（summary/custom-title/ai-title/last-prompt/
 *  tag/workspace-directories/runtime-config/mode/content-replacement/
 *  file-history-snapshot/token-stats/active-leaf/relocated/worktree-state）：
 *  均不进消息流；本实现只挑 user/assistant 行，元数据行天然落在集合之外。 */

/**
 * active 分支解析（Wake active_chain）：沿 active-leaf 的 parentUuid 链收集主链
 * （attachment 等非消息节点在链中占位但不在 byUuid—— walk 到缺失父节点即止），
 * 再收回链上 assistant 的 tool_result 子节点。uuid 重复 = 分片，后行胜。
 * active-leaf 显式 null = 已回退空会话（无消息）；叶子缺失/无 active-leaf 行 →
 * 保守取文件序最后一个消息节点。
 */
function qoderActiveRows(rows: QoderRow[]): { included: QoderRow[]; leafEmpty: boolean } {
  let leaf: { kind: "missing" | "empty" | "uuid"; id?: string } = { kind: "missing" };
  const messageRows = rows.filter((r) => {
    if (r.type === "active-leaf") {
      if (r.leafUuid === null) leaf = { kind: "empty" };
      else if (typeof r.leafUuid === "string") leaf = { kind: "uuid", id: r.leafUuid };
    }
    return (
      (r.type === "user" || r.type === "assistant") && r.isSidechain !== true && !!r.message
    );
  });
  if (leaf.kind === "empty") return { included: [], leafEmpty: true };
  // byUuid 收全部带 uuid 的行：attachment 等节点虽不展示，但常是链上占位父节点
  //（Wake qoder.rs 同款——attachment 不进消息流但保留 parent 关系）。
  const byUuid = new Map<string, QoderRow>();
  for (const r of rows) if (r.uuid) byUuid.set(r.uuid, r);
  const cursor =
    leaf.kind === "uuid" && leaf.id && byUuid.has(leaf.id)
      ? byUuid.get(leaf.id)
      : messageRows[messageRows.length - 1];
  const chainUuids = new Set<string>();
  const seen = new Set<string>();
  let node = cursor;
  while (node) {
    const id = node.uuid ?? "";
    if (!id || seen.has(id)) break;
    seen.add(id);
    chainUuids.add(id);
    if (!node.parentUuid) break;
    node = byUuid.get(node.parentUuid);
  }
  // 同一次 API 响应被写成多个共享 message.id 的 assistant 兄弟分片（Wake 同款）：
  // 链上任一分片在链，即按 message.id 收齐全部分片，再收它们的 tool_result 子节点。
  const chainedMsgIds = new Set(
    messageRows
      .filter((r) => r.type === "assistant" && r.uuid && chainUuids.has(r.uuid) && (r.message as any)?.id)
      .map((r) => (r.message as any).id as string),
  );
  const includedUuids = new Set<string>(chainUuids);
  const included: QoderRow[] = [];
  for (const r of messageRows) {
    if (r.uuid && chainUuids.has(r.uuid)) {
      included.push(r);
      includedUuids.add(r.uuid);
      continue;
    }
    const msgId = (r.message as any)?.id;
    if (r.type === "assistant" && typeof msgId === "string" && chainedMsgIds.has(msgId)) {
      included.push(r);
      if (r.uuid) includedUuids.add(r.uuid);
      continue;
    }
    if (
      r.type === "user" &&
      !!r.parentUuid &&
      includedUuids.has(r.parentUuid) &&
      Array.isArray(r.message?.content) &&
      (r.message?.content as any[]).some((b) => b?.type === "tool_result")
    ) {
      included.push(r);
    }
  }
  return { included, leafEmpty: false };
}

export function createQoderImporter(fs: ImportFs, home: string): SessionImporter {
  const PROJECTS_DIR = homeJoin(home, ".qoder", "projects");
  return {
    source: "qoder",

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
          const raw = await fs.readText(filePath);
          if (raw == null) continue;
          const rows = parseJsonLines<QoderRow>(raw);
          let customTitle = "";
          let aiTitle = "";
          let cwd = "";
          let relocatedCwd = "";
          let model: string | null = null;
          for (const r of rows) {
            if (r.type === "custom-title") customTitle = r.customTitle ?? "";
            else if (r.type === "ai-title") aiTitle = r.aiTitle ?? "";
            else if (r.type === "relocated" && r.relocatedCwd) relocatedCwd = r.relocatedCwd;
            else if (r.type === "assistant" && !model && r.message?.model) model = r.message.model;
          }
          const { included, leafEmpty } = qoderActiveRows(rows);
          if (included.length === 0) continue;
          if (!cwd) cwd = included[0]?.cwd ?? "";
          const projectPath = relocatedCwd || cwd || null;
          const firstUser = included.find(
            (r) => r.type === "user" && typeof r.message?.content === "string" && r.message.content.trim(),
          );
          void leafEmpty;
          summaries.push({
            source: "qoder",
            externalId: file.replace(/\.jsonl$/, ""),
            title:
              truncateTitle(customTitle || aiTitle || (firstUser?.message?.content as string) || "") ||
              file.replace(/\.jsonl$/, ""),
            projectPath,
            model,
            createdAt: toIso(included[0]?.timestamp),
            updatedAt: toIso(included[included.length - 1]?.timestamp),
            messageCount: included.length,
            filePath,
          });
        }
      }
      return summaries;
    },

    async convert(summary: ExternalSessionSummary): Promise<ImportedSession> {
      const raw = await fs.readText(summary.filePath);
      const rows = parseJsonLines<QoderRow>(raw ?? "");
      // 与 scan 同一条 active 链解析；弃用分支与 isMeta 行不进消息流。
      const { included } = qoderActiveRows(rows);
      const messages: ImportedUiMessage[] = [];
      const pendingTools = new Map<string, { name: string; args: unknown }>();
      for (const row of included) {
        if (row.type === "user" && row.isMeta === true) continue;
        const createdAt = toIso(row.timestamp, summary.createdAt);
        const blocks = Array.isArray(row.message?.content) ? row.message!.content as any[] : null;
        if (row.type === "assistant") {
          const text = blockText(row.message?.content);
          if (text) {
            messages.push({ id: uuid(), role: "assistant", content: text, createdAt, status: "complete" });
          }
          for (const b of blocks ?? []) {
            if (b.type === "tool_use" && b.id) pendingTools.set(b.id, { name: b.name, args: b.input });
          }
        } else {
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
            const text = blockText(row.message?.content);
            if (text && !text.startsWith("<")) {
              messages.push({ id: uuid(), role: "user", content: text, createdAt });
            }
          }
        }
      }
      return {
        session: {
          id: importedSessionId("qoder", summary.externalId),
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

// ==================== Kimi ====================
// `~/.kimi-code/sessions/wd_<名>_<hash>/session_<uuid>/` 一目录一会话（Wake
// kimi.rs）：事件溯源 wire.jsonl——turn.prompt/steer 是用户输入；append_message
// 只收 assistant（user 输入已由 prompt 覆盖，tool/system 上下文行跳过）；
// loop_event 工具明细 v1 不展开（Wake 同款）。state.json 边车给标题/时间
// （"New Session" 是占位），cwd 靠根级 session_index.jsonl 映射。

export function createKimiImporter(fs: ImportFs, home: string): SessionImporter {
  const SESSIONS_DIR = homeJoin(home, ".kimi-code", "sessions");
  const INDEX_PATH = homeJoin(home, ".kimi-code", "session_index.jsonl");
  return {
    source: "kimi",

    async scan(): Promise<ExternalSessionSummary[]> {
      // sessionId → workDir 映射（缺文件 = cwd 未知，如实 null）
      const cwdMap = new Map<string, string>();
      const indexRaw = await fs.readText(INDEX_PATH);
      if (indexRaw) {
        for (const row of parseJsonLines<{ sessionId?: string; workDir?: string }>(indexRaw)) {
          if (row.sessionId && row.workDir) cwdMap.set(row.sessionId, row.workDir);
        }
      }
      let wdDirs: string[] = [];
      try {
        wdDirs = await fs.listDir(SESSIONS_DIR);
      } catch {
        return [];
      }
      const summaries: ExternalSessionSummary[] = [];
      for (const wd of wdDirs) {
        const wdPath = homeJoin(SESSIONS_DIR, wd);
        let sessionDirs: string[] = [];
        try {
          sessionDirs = (await fs.listDir(wdPath)).filter((d) => d.startsWith("session_"));
        } catch {
          continue;
        }
        for (const sessionDir of sessionDirs) {
          const sessionPath = homeJoin(wdPath, sessionDir);
          const wirePath = homeJoin(sessionPath, "agents", "main", "wire.jsonl");
          const wireRaw = await fs.readText(wirePath);
          if (wireRaw == null) continue;
          const events = parseJsonLines<{
            type?: string;
            input?: Array<{ type?: string; text?: string }>;
            message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
            created_at?: number;
          }>(wireRaw);
          let promptCount = 0;
          let firstPrompt = "";
          for (const ev of events) {
            if (ev.type === "turn.prompt" || ev.type === "turn.steer") {
              const text = (ev.input ?? [])
                .filter((p) => p?.type === "text" && p.text)
                .map((p) => p.text!)
                .join("\n");
              if (text) {
                promptCount += 1;
                if (!firstPrompt) firstPrompt = text;
              }
            } else if (ev.type === "context.append_message" && ev.message?.role === "assistant") {
              promptCount += 1;
            }
          }
          if (promptCount === 0) continue;
          const stateRaw = await fs.readText(homeJoin(sessionPath, "state.json"));
          const state = (() => {
            try {
              return stateRaw ? JSON.parse(stateRaw) as Record<string, any> : null;
            } catch {
              return null;
            }
          })();
          const stateTitle = (state?.title as string) ?? "";
          const title = stateTitle && stateTitle !== "New Session" ? stateTitle : firstPrompt;
          summaries.push({
            source: "kimi",
            externalId: sessionDir,
            title: truncateTitle(title) || sessionDir,
            projectPath: cwdMap.get(sessionDir) ?? null,
            model: null,
            createdAt: toIso((state?.createdAt as string) ?? events[0]?.created_at),
            updatedAt: toIso(state?.updatedAt as string ?? null, toIso(events[0]?.created_at)),
            messageCount: promptCount,
            filePath: wirePath,
          });
        }
      }
      return summaries;
    },

    async convert(summary: ExternalSessionSummary): Promise<ImportedSession> {
      const raw = await fs.readText(summary.filePath);
      const events = parseJsonLines<{
        type?: string;
        input?: Array<{ type?: string; text?: string }>;
        message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
      }>(raw ?? "");
      const messages: ImportedUiMessage[] = [];
      for (const ev of events) {
        if (ev.type === "turn.prompt" || ev.type === "turn.steer") {
          const text = (ev.input ?? [])
            .filter((p) => p?.type === "text" && p.text)
            .map((p) => p.text!)
            .join("\n");
          if (text) messages.push({ id: uuid(), role: "user", content: text, createdAt: summary.createdAt });
        } else if (ev.type === "context.append_message" && ev.message?.role === "assistant") {
          const text = (ev.message.content ?? [])
            .filter((p) => p?.type === "text" && p.text)
            .map((p) => p.text!)
            .join("\n");
          if (text) {
            messages.push({ id: uuid(), role: "assistant", content: text, createdAt: summary.createdAt, status: "complete" });
          }
        }
      }
      return {
        session: {
          id: importedSessionId("kimi", summary.externalId),
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

// ==================== CodeBuddy / WorkBuddy ====================
// `~/.{codebuddy,workbuddy}/projects/<cwd 转义>/<sessionId>.jsonl`（Wake
// codebuddy.rs）：布局借自 Claude Code，**行格式却是 OpenAI Responses 形**——
// message（input_text/output_text）、reasoning、function_call(callId,
// arguments 是 JSON 字符串)、function_call_result。标题 custom-title >
// ai-title > topic 各自 last-wins，占位符（"(No content)"/"/compact"/
// <image_local_path>…）跳过。WorkBuddy 是孪生实例（仅根不同）。

const CODEBUDDY_TITLE_PLACEHOLDERS = (text: string): boolean =>
  text === "(No content)" ||
  text === "/compact" ||
  (text.startsWith("<image_local_path>") && text.endsWith("</image_local_path>"));

function createCodebuddyLikeImporter(
  fs: ImportFs,
  home: string,
  dotDir: string,
  source: ExternalSource,
): SessionImporter {
  const PROJECTS_DIR = homeJoin(home, dotDir, "projects");
  return {
    source,

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
          const externalId = file.replace(/\.jsonl$/, "");
          const raw = await fs.readText(filePath);
          if (raw == null) continue;
          let customTitle = "";
          let aiTitle = "";
          let topic = "";
          let model: string | null = null;
          let cwd = "";
          let rowCount = 0;
          for (const row of parseJsonLines<Record<string, any>>(raw)) {
            const typ = row.type;
            if (typ === "custom-title") {
              const t = row.customTitle;
              if (typeof t === "string" && t.trim() && !CODEBUDDY_TITLE_PLACEHOLDERS(t)) customTitle = t.trim();
            } else if (typ === "ai-title") {
              const t = row.aiTitle;
              if (typeof t === "string" && t.trim() && !CODEBUDDY_TITLE_PLACEHOLDERS(t)) aiTitle = t.trim();
            } else if (typ === "topic") {
              const t = row.topic;
              if (typeof t === "string" && t.trim() && !CODEBUDDY_TITLE_PLACEHOLDERS(t)) topic = t.trim();
            } else if (typ === "message") {
              const role = row.role;
              if (role === "user") rowCount += 1;
              else if (role === "assistant") {
                rowCount += 1;
                const pd = row.providerData ?? {};
                const m = (pd.requestModelName as string) || (row.model as string) || "";
                if (m) model = m;
              }
              if (!cwd && typeof row.cwd === "string") cwd = row.cwd;
            }
          }
          if (rowCount === 0) continue;
          // meta 边车 cwd 兜底
          if (!cwd) {
            const metaRaw = await fs.readText(homeJoin(dirPath, `${externalId}.meta.json`));
            if (metaRaw) {
              try {
                cwd = (JSON.parse(metaRaw) as Record<string, any>).cwd ?? "";
              } catch {
                // 边车残缺不遮会话
              }
            }
          }
          const firstUserText = (() => {
            for (const row of parseJsonLines<Record<string, any>>(raw)) {
              if (row.type !== "message" || row.role !== "user") continue;
              const blocks = Array.isArray(row.content) ? row.content : [];
              const text = blocks
                .filter((b) => b?.type === "input_text" && typeof b.text === "string")
                .map((b) => b.text as string)
                .join("\n");
              if (text && !text.startsWith("<")) return text;
            }
            return "";
          })();
          summaries.push({
            source,
            externalId,
            title:
              truncateTitle(customTitle || aiTitle || topic || firstUserText) ||
              externalId,
            projectPath: cwd || null,
            model,
            createdAt: toIso(null),
            updatedAt: toIso(null),
            messageCount: rowCount,
            filePath,
          });
        }
      }
      return summaries;
    },

    async convert(summary: ExternalSessionSummary): Promise<ImportedSession> {
      const raw = await fs.readText(summary.filePath);
      const rows = parseJsonLines<Record<string, any>>(raw ?? "");
      const messages: ImportedUiMessage[] = [];
      const pendingCalls = new Map<string, { name: string; args: unknown }>();
      let providerId: string | null = null;
      for (const row of rows) {
        const createdAt = toIso(row.timestamp, summary.createdAt);
        const typ = row.type;
        if (typ === "function_call" && row.callId) {
          let args: unknown = row.arguments;
          if (typeof args === "string") {
            try {
              args = JSON.parse(args);
            } catch {
              args = { raw: args };
            }
          }
          pendingCalls.set(row.callId, { name: row.name, args });
        } else if (typ === "function_call_result" && row.callId) {
          const pending = pendingCalls.get(row.callId);
          pendingCalls.delete(row.callId);
          const output = row.output ?? {};
          const resultText =
            typeof output === "string" ? output : typeof output.text === "string" ? output.text : "";
          messages.push({
            id: uuid(),
            role: "tool",
            content: resultText,
            createdAt,
            toolName: row.name ?? pending?.name,
            toolCallId: row.callId,
            toolStatus: row.status === "failed" ? "error" : "success",
            toolArgs: pending?.args,
            toolResult: resultText,
            isError: row.status === "failed" || undefined,
            status: "complete",
          });
        } else if (typ === "message") {
          const role = row.role;
          const blocks = Array.isArray(row.content) ? row.content : [];
          const text = blocks
            .filter((b) => (b?.type === "input_text" || b?.type === "output_text") && typeof b.text === "string")
            .map((b) => b.text as string)
            .join("\n");
          if (!text) continue;
          if (role === "user") {
            if (text.startsWith("<")) continue;
            messages.push({ id: uuid(), role: "user", content: text, createdAt });
          } else if (role === "assistant") {
            const pd = row.providerData ?? {};
            providerId = (pd.providerId as string) ?? providerId;
            messages.push({ id: uuid(), role: "assistant", content: text, createdAt, status: "complete" });
          }
        }
        // reasoning / file-history-snapshot / summary / turn-metrics / 未知行：导入噪声
      }
      return {
        session: {
          id: importedSessionId(source, summary.externalId),
          title: summary.title,
          projectPath: summary.projectPath,
          modelId: summary.model,
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

export function createCodebuddyImporter(fs: ImportFs, home: string): SessionImporter {
  return createCodebuddyLikeImporter(fs, home, ".codebuddy", "codebuddy");
}

/** WorkBuddy：CodeBuddy 同内核孪生实例（Wake codebuddy.rs workbuddy() 同款）。 */
export function createWorkbuddyImporter(fs: ImportFs, home: string): SessionImporter {
  return createCodebuddyLikeImporter(fs, home, ".workbuddy", "workbuddy");
}

// ==================== Gemini CLI ====================
// `~/.gemini/tmp/<slug>/chats/session-*.jsonl`（Wake gemini.rs）：首行 header
// {sessionId,startTime,lastUpdated}，后续 {$set:{messages}} **覆盖式快照**——
// 重放到最后一条 $set 为准。无原生标题（首条用户文本兜底）；cwd 靠
// ~/.gemini/projects.json 的 路径→slug 映射反查；无 model 列。

export function createGeminiImporter(fs: ImportFs, home: string): SessionImporter {
  const TMP_DIR = homeJoin(home, ".gemini", "tmp");
  const PROJECTS_JSON = homeJoin(home, ".gemini", "projects.json");
  return {
    source: "gemini",

    async scan(): Promise<ExternalSessionSummary[]> {
      // slug → 项目路径 反查表（{"projects": {path: slug}}）
      const slugMap = new Map<string, string>();
      const projectsRaw = await fs.readText(PROJECTS_JSON);
      if (projectsRaw) {
        try {
          const parsed = JSON.parse(projectsRaw) as { projects?: Record<string, string> };
          for (const [path, slug] of Object.entries(parsed.projects ?? {})) {
            if (typeof slug === "string") slugMap.set(slug, path);
          }
        } catch {
          // projects.json 残缺不遮会话
        }
      }
      let slugDirs: string[] = [];
      try {
        slugDirs = await fs.listDir(TMP_DIR);
      } catch {
        return [];
      }
      const summaries: ExternalSessionSummary[] = [];
      for (const slug of slugDirs) {
        const chatsDir = homeJoin(TMP_DIR, slug, "chats");
        let files: string[] = [];
        try {
          files = (await fs.listDir(chatsDir)).filter((f) => f.startsWith("session-") && f.endsWith(".jsonl"));
        } catch {
          continue;
        }
        for (const file of files) {
          const filePath = homeJoin(chatsDir, file);
          const raw = await fs.readText(filePath);
          if (raw == null) continue;
          const rows = parseJsonLines<Record<string, any>>(raw);
          const header = rows.find((r) => typeof r.sessionId === "string");
          if (!header) continue;
          let lastSet: any[] | null = null;
          for (const row of rows) {
            const set = row.$set;
            if (set && Array.isArray(set.messages)) lastSet = set.messages;
          }
          const msgs = (lastSet ?? []).filter((m) => m && typeof m === "object");
          if (msgs.length === 0) continue;
          const firstUser = msgs.find(
            (m) => m.type === "user" && (m.content ?? []).some((b: any) => typeof b?.text === "string" && b.text),
          );
          const firstUserText = firstUser
            ? (firstUser.content as any[]).filter((b) => typeof b?.text === "string").map((b) => b.text).join("\n")
            : "";
          summaries.push({
            source: "gemini",
            externalId: header.sessionId,
            title: truncateTitle(firstUserText) || header.sessionId,
            projectPath: slugMap.get(slug) ?? null,
            model: null,
            createdAt: toIso(header.startTime),
            updatedAt: toIso(header.lastUpdated),
            messageCount: msgs.length,
            filePath,
          });
        }
      }
      return summaries;
    },

    async convert(summary: ExternalSessionSummary): Promise<ImportedSession> {
      const raw = await fs.readText(summary.filePath);
      const rows = parseJsonLines<Record<string, any>>(raw ?? "");
      let lastSet: any[] | null = null;
      for (const row of rows) {
        const set = row.$set;
        if (set && Array.isArray(set.messages)) lastSet = set.messages;
      }
      const messages: ImportedUiMessage[] = [];
      for (const m of lastSet ?? []) {
        const text = (m.content ?? [])
          .filter((b: any) => typeof b?.text === "string")
          .map((b: any) => b.text as string)
          .join("\n");
        if (!text) continue;
        if (m.type === "user") {
          messages.push({ id: uuid(), role: "user", content: text, createdAt: toIso(m.timestamp, summary.createdAt) });
        } else {
          messages.push({
            id: uuid(),
            role: "assistant",
            content: text,
            createdAt: toIso(m.timestamp, summary.createdAt),
            status: "complete",
          });
        }
      }
      return {
        session: {
          id: importedSessionId("gemini", summary.externalId),
          title: summary.title,
          projectPath: summary.projectPath,
          modelId: null,
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

// ==================== Grok Build ====================
// `~/.grok/sessions/<url 编码 cwd>/<uuid>/` 一目录一会话（Wake grok.rs）：
// updates.jsonl 是 ACP 风格流水（chunk 流式落盘需按角色段合并）；summary.json
// 边车给 cwd/标题/模型；tool_call/tool_call_update 按 toolCallId 配对。

interface GrokUpdate {
  sessionUpdate?: string;
  /** chunk 形：{type:"text",text}；tool_call_update 形：[{type:"content",content:{text}}] */
  content?:
    | { type?: string; text?: string }
    | Array<{ type?: string; content?: { type?: string; text?: string } }>;
  toolCallId?: string;
  title?: string;
  rawInput?: unknown;
  status?: string;
}

function grokResultText(update: GrokUpdate): string {
  const content = update.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => block?.content?.text ?? "")
    .filter(Boolean)
    .join("\n");
}

function grokChunkText(update: GrokUpdate): string {
  const content = update.content;
  if (Array.isArray(content)) return content.map((b) => b?.content?.text ?? "").filter(Boolean).join("");
  return typeof content?.text === "string" ? content.text : "";
}

export function createGrokImporter(fs: ImportFs, home: string): SessionImporter {
  const SESSIONS_DIR = homeJoin(home, ".grok", "sessions");
  return {
    source: "grok",

    async scan(): Promise<ExternalSessionSummary[]> {
      let cwdDirs: string[] = [];
      try {
        cwdDirs = await fs.listDir(SESSIONS_DIR);
      } catch {
        return [];
      }
      const summaries: ExternalSessionSummary[] = [];
      for (const cwdDir of cwdDirs) {
        const cwdPath = homeJoin(SESSIONS_DIR, cwdDir);
        let sessionDirs: string[] = [];
        try {
          sessionDirs = await fs.listDir(cwdPath);
        } catch {
          continue;
        }
        for (const sessionId of sessionDirs) {
          const sessionPath = homeJoin(cwdPath, sessionId);
          const updatesPath = homeJoin(sessionPath, "updates.jsonl");
          const updatesRaw = await fs.readText(updatesPath);
          if (updatesRaw == null) continue;
          const summaryRaw = await fs.readText(homeJoin(sessionPath, "summary.json"));
          const sidecar = (() => {
            try {
              return summaryRaw ? JSON.parse(summaryRaw) as Record<string, any> : null;
            } catch {
              return null;
            }
          })();
          // ACP chunk 按角色段合并计数（user/agent 文本段 + 工具对）
          const updates = parseJsonLines<{ params?: { update?: GrokUpdate } }>(updatesRaw)
            .map((r) => r.params?.update)
            .filter((u): u is GrokUpdate => Boolean(u));
          let hasContent = false;
          let sawUser = false;
          for (const u of updates) {
            const kind = u.sessionUpdate;
            if (kind === "user_message_chunk") {
              sawUser = true;
              hasContent = true;
            } else if (kind === "agent_message_chunk" || kind === "tool_call") {
              hasContent = true;
            }
          }
          if (!hasContent || !sawUser) continue;
          const cwd = sidecar?.info?.cwd ?? null;
          summaries.push({
            source: "grok",
            externalId: sessionId,
            title:
              truncateTitle(
                (sidecar?.generated_title as string) ||
                  (sidecar?.session_summary as string) ||
                  "",
              ) || sessionId,
            projectPath: cwd,
            model: (sidecar?.current_model_id as string) ?? null,
            createdAt: toIso(sidecar?.created_at),
            updatedAt: toIso(sidecar?.updated_at, toIso(sidecar?.created_at)),
            messageCount: (sidecar?.num_chat_messages as number) ?? null,
            filePath: updatesPath,
          });
        }
      }
      return summaries;
    },

    async convert(summary: ExternalSessionSummary): Promise<ImportedSession> {
      const raw = await fs.readText(summary.filePath);
      const updates = parseJsonLines<{ timestamp?: number; params?: { update?: GrokUpdate } }>(raw ?? "")
        .map((r): { ts?: number; update?: GrokUpdate } => ({ ts: r.timestamp, update: r.params?.update }))
        .filter((r): r is { ts?: number; update: GrokUpdate } => Boolean(r.update));
      const messages: ImportedUiMessage[] = [];
      const pendingCalls = new Map<string, { title: string; args: unknown }>();
      let curRole: "user" | "assistant" | null = null;
      let curText = "";
      const flush = () => {
        if (curRole && curText.trim()) {
          messages.push({
            id: uuid(),
            role: curRole,
            content: curText,
            createdAt: toIso(null, summary.createdAt),
            ...(curRole === "assistant" ? { status: "complete" as const } : {}),
          });
        }
        curRole = null;
        curText = "";
      };
      for (const { ts, update } of updates) {
        const kind = update.sessionUpdate;
        const createdAt = toIso(ts, summary.createdAt);
        if (kind === "user_message_chunk") {
          if (curRole !== "user") flush();
          curRole = "user";
          curText += grokChunkText(update);
        } else if (kind === "agent_message_chunk") {
          if (curRole !== "assistant") flush();
          curRole = "assistant";
          curText += grokChunkText(update);
        } else if (kind === "tool_call" && update.toolCallId) {
          flush();
          pendingCalls.set(update.toolCallId, { title: update.title ?? "", args: update.rawInput });
        } else if (kind === "tool_call_update" && update.toolCallId) {
          const pending = pendingCalls.get(update.toolCallId);
          pendingCalls.delete(update.toolCallId);
          const resultText = grokResultText(update);
          messages.push({
            id: uuid(),
            role: "tool",
            content: resultText,
            createdAt,
            toolName: pending?.title || update.title,
            toolCallId: update.toolCallId,
            toolArgs: pending?.args,
            toolResult: resultText,
            toolStatus: update.status === "failed" ? "error" : "success",
            isError: update.status === "failed" || undefined,
            status: "complete",
          });
        } else {
          // agent_thought_chunk / auto_compact_* / 未知 update：段界（不产消息）
          if (kind === "agent_thought_chunk") flush();
        }
      }
      flush();
      return {
        session: {
          id: importedSessionId("grok", summary.externalId),
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

// ==================== Craft Agents ====================
// `~/.craft-agent/workspaces/<slug>/sessions/<id>/session.jsonl`（Wake craft.rs，
// 按 v0.13.5 源码落地）：craft 自身不带引擎——Claude 连接跑 Claude Agent SDK
// （转录落 ~/.claude），其余跑 Pi SDK（转录落会话目录 .pi-sessions/）。Wake 读
// 的是 craft 自己记的这份。首行 SessionHeader（name/preview/workingDirectory/
// sdkSessionId/model…），后续 StoredMessage：user/assistant/tool 单行自带
// toolInput+toolResult；hidden 行与 plan/info/error/warning/auth-request 不进。
// 路径占位 {{SESSION_PATH}} 读时展开。native id 带工作区命名空间
// `<config.json 的 id>/<会话目录>`。引擎副本由 claimed() 认领。

interface CraftHeader {
  id?: string;
  name?: string;
  preview?: string;
  sdkSessionId?: string;
  sdkCwd?: string;
  workingDirectory?: string;
  model?: string;
  llmConnection?: string;
  createdAt?: number;
  lastUsedAt?: number;
  lastMessageAt?: number;
}

interface CraftRow {
  type?: string;
  content?: string;
  timestamp?: number;
  hidden?: boolean;
  toolName?: string;
  toolUseId?: string;
  toolInput?: unknown;
  toolResult?: string;
  isError?: boolean;
}

const CRAFT_MESSAGE_TYPES = new Set(["user", "assistant", "tool"]);

function craftExpandPlaceholders(text: string, sessionDir: string): string {
  return text.split("{{SESSION_PATH}}").join(sessionDir);
}

export function createCraftImporter(fs: ImportFs, home: string): SessionImporter {
  const WORKSPACES_DIR = homeJoin(home, ".craft-agent", "workspaces");
  /** 本轮 scan 收集的 Claude 引擎转录 id（Wake claude_ids 同款；Pi 连接不认领）。 */
  let claimedClaudeIds: string[] = [];
  return {
    source: "craft",

    async scan(): Promise<ExternalSessionSummary[]> {
      let workspaceDirs: string[] = [];
      try {
        workspaceDirs = await fs.listDir(WORKSPACES_DIR);
      } catch {
        return [];
      }
      const summaries: ExternalSessionSummary[] = [];
      for (const wsDir of workspaceDirs) {
        const wsPath = homeJoin(WORKSPACES_DIR, wsDir);
        // 工作区 config.json 给 id（native id 命名空间用）；缺省回退目录名。
        const configRaw = await fs.readText(homeJoin(wsPath, "config.json"));
        let wsId = wsDir;
        if (configRaw) {
          try {
            wsId = (JSON.parse(configRaw) as Record<string, any>).id || wsDir;
          } catch {
            // config 残缺不遮工作区
          }
        }
        const sessionsDir = homeJoin(wsPath, "sessions");
        let sessionDirs: string[] = [];
        try {
          sessionDirs = await fs.listDir(sessionsDir);
        } catch {
          continue;
        }
        for (const sessionId of sessionDirs) {
          const sessionPath = homeJoin(sessionsDir, sessionId);
          const sessionPathAbs = homeJoin(home, ".craft-agent", "workspaces", wsDir, "sessions", sessionId);
          const raw = await fs.readText(homeJoin(sessionPath, "session.jsonl"));
          if (raw == null) continue;
          const rows = raw.split("\n");
          let header: CraftHeader | null = null;
          const messageRows: CraftRow[] = [];
          for (const line of rows) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let parsed: CraftRow & Partial<CraftHeader>;
            try {
              parsed = JSON.parse(trimmed);
            } catch {
              continue;
            }
            if (!header && typeof parsed.id === "string" && parsed.id === sessionId && !parsed.type) {
              header = parsed as CraftHeader;
            } else if (parsed.type && CRAFT_MESSAGE_TYPES.has(parsed.type) && parsed.hidden !== true) {
              messageRows.push(parsed as CraftRow);
            }
          }
          if (!header || messageRows.length === 0) continue;
          // 非 Pi 引擎（model 不带 "pi/" 前缀）的会话由 Claude Agent SDK 跑，
          // sdkSessionId 就是 ~/.claude 里的转录 id → 认领引擎副本（Wake is_pi_model 同款）。
          const isPiEngine = typeof header.model === "string" && header.model.startsWith("pi/");
          if (!isPiEngine && header.sdkSessionId?.trim()) {
            claimedClaudeIds.push(header.sdkSessionId.trim());
          }
          const firstUser = messageRows.find((r) => r.type === "user" && r.content?.trim());
          summaries.push({
            source: "craft",
            externalId: `${wsId}/${sessionId}`,
            title:
              truncateTitle(
                header.name?.trim() ||
                  header.preview?.trim() ||
                  craftExpandPlaceholders(firstUser?.content ?? "", sessionPathAbs),
              ) || sessionId,
            projectPath: header.workingDirectory ?? header.sdkCwd ?? null,
            model: header.model ?? null,
            createdAt: toIso(header.createdAt),
            updatedAt: toIso(header.lastMessageAt ?? header.lastUsedAt ?? header.createdAt),
            messageCount: messageRows.length,
            filePath: homeJoin(sessionPath, "session.jsonl"),
          });
        }
      }
      return summaries;
    },

    async convert(summary: ExternalSessionSummary): Promise<ImportedSession> {
      const raw = await fs.readText(summary.filePath);
      const sessionDir = summary.filePath.replace(/\/session\.jsonl$/, "");
      const lines = (raw ?? "").split("\n");
      const messages: ImportedUiMessage[] = [];
      let header: CraftHeader | null = null;
      const messageRows: CraftRow[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as CraftRow & Partial<CraftHeader>;
          if (!header && typeof parsed.id === "string" && !parsed.type) {
            header = parsed as CraftHeader;
          } else if (parsed.type && CRAFT_MESSAGE_TYPES.has(parsed.type) && parsed.hidden !== true) {
            messageRows.push(parsed as CraftRow);
          }
        } catch {
          // 跳过残行
        }
      }
      const fallbackTs = toIso(header?.createdAt);
      for (const row of messageRows) {
        const createdAt = toIso(row.timestamp, fallbackTs);
        const content = craftExpandPlaceholders(row.content ?? "", sessionDir);
        if (row.type === "user") {
          if (content.trim()) messages.push({ id: uuid(), role: "user", content, createdAt });
        } else if (row.type === "assistant") {
          if (content.trim()) {
            messages.push({ id: uuid(), role: "assistant", content, createdAt, status: "complete" });
          }
        } else if (row.type === "tool" && row.toolName) {
          // 占位符可能出现在 toolInput（如 Bash 命令里引用会话目录）
          let toolArgs = row.toolInput;
          if (typeof toolArgs === "string") {
            toolArgs = craftExpandPlaceholders(toolArgs, sessionDir);
          } else if (toolArgs && typeof toolArgs === "object") {
            toolArgs = JSON.parse(craftExpandPlaceholders(JSON.stringify(toolArgs), sessionDir));
          }
          const resultText = craftExpandPlaceholders(row.toolResult ?? "", sessionDir);
          messages.push({
            id: uuid(),
            role: "tool",
            content: resultText,
            createdAt,
            toolName: row.toolName,
            toolCallId: row.toolUseId,
            toolArgs,
            toolResult: resultText,
            toolStatus: row.isError ? "error" : "success",
            isError: row.isError === true || undefined,
            status: "complete",
          });
        }
      }
      return {
        session: {
          id: importedSessionId("craft", summary.externalId),
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

    /** Claude 引擎副本认领：非 Pi 连接的会话，其 sdkSessionId 就是 ~/.claude 的转录 id。 */
    claimed() {
      return claimedClaudeIds.map((id) => ({ source: "claude-code" as const, externalId: id }));
    },
  };
}

// ==================== v1/v2 共享解析器（OpenCode 系：zcode / opencode）====================
// Wake parse_v1_messages / parse_v2_messages 的导入形态：文本块与工具块按
// part 顺序发射（文本先于其后的工具）；reasoning/step-*/snapshot/patch/image
// 为导入噪声；tool 块兼容 {callID,tool,state} 与 {id,name,state} 两形态。

interface V1ParseOutcome {
  messages: ImportedUiMessage[];
  model: string | null;
}

async function parseV1SessionMessages(
  db: ImportDb,
  dbPath: string,
  sessionId: string,
  partOrder: string,
  messageOrder: string,
): Promise<V1ParseOutcome> {
  const [partsResult, messagesResult] = await Promise.all([
    db.query(dbPath, `SELECT message_id, data FROM part WHERE session_id = ? ORDER BY ${partOrder}`, [sessionId]),
    db.query(dbPath, `SELECT id, data FROM message WHERE session_id = ? ORDER BY ${messageOrder}`, [sessionId]),
  ]);
  const partsByMsg = new Map<string, Record<string, any>[]>();
  for (const row of partsResult?.rows ?? []) {
    const mid = String(row[0] ?? "");
    try {
      const parsed = JSON.parse(String(row[1] ?? ""));
      const list = partsByMsg.get(mid) ?? [];
      list.push(parsed);
      partsByMsg.set(mid, list);
    } catch {
      // 残行跳过
    }
  }
  const messages: ImportedUiMessage[] = [];
  let model: string | null = null;
  for (const row of messagesResult?.rows ?? []) {
    const mid = String(row[0] ?? "");
    let meta: Record<string, any>;
    try {
      meta = JSON.parse(String(row[1] ?? ""));
    } catch {
      continue;
    }
    const role = meta.role;
    if (role !== "user" && role !== "assistant") continue;
    // semantics.transcriptVisibility === "hidden"（fork 通知/compaction 摘要等）不进
    if (meta.semantics?.transcriptVisibility === "hidden") continue;
    const createdAt = toIso(meta.time?.created ?? null);
    const msgModel = meta.modelId ?? meta.modelID;
    if (role === "assistant" && typeof msgModel === "string" && msgModel) model = msgModel;
    type Emission = { kind: "text"; text: string } | { kind: "tool"; part: Record<string, any> };
    const emissions: Emission[] = [];
    let pendingText = "";
    for (const part of partsByMsg.get(mid) ?? []) {
      const type = part.type;
      if (type === "text") {
        if (part.synthetic === true) continue;
        if (typeof part.text === "string" && part.text.trim()) {
          pendingText += (pendingText ? "\n" : "") + part.text;
        }
      } else if (type === "tool" && role === "assistant") {
        if (pendingText) {
          emissions.push({ kind: "text", text: pendingText });
          pendingText = "";
        }
        emissions.push({ kind: "tool", part });
      }
    }
    if (pendingText) emissions.push({ kind: "text", text: pendingText });
    for (const emission of emissions) {
      if (emission.kind === "text") {
        messages.push({
          id: uuid(),
          role,
          content: emission.text,
          createdAt,
          ...(role === "assistant" ? { status: "complete" as const } : {}),
        });
      } else {
        const part = emission.part;
        const state = part.state ?? {};
        const output = (() => {
          if (typeof state.output === "string") return state.output;
          if (typeof state.result === "string") return state.result;
          if (Array.isArray(state.content)) {
            return state.content.map((b: any) => b?.text ?? "").filter(Boolean).join("\n");
          }
          return "";
        })();
        messages.push({
          id: uuid(),
          role: "tool",
          content: output,
          createdAt,
          toolName: part.tool ?? part.name,
          toolCallId: part.callID ?? part.id,
          toolArgs: state.input,
          toolResult: output,
          toolStatus: state.error ? "error" : "success",
          isError: state.error ? true : undefined,
          status: "complete",
        });
      }
    }
  }
  return { messages, model };
}

/** v2 正文：session_message 单表按 seq 有序，type 列分 user/synthetic/assistant。 */
async function parseV2SessionMessages(
  db: ImportDb,
  dbPath: string,
  sessionId: string,
): Promise<ImportedUiMessage[]> {
  const result = await db.query(
    dbPath,
    "SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq",
    [sessionId],
  );
  const messages: ImportedUiMessage[] = [];
  for (const row of result?.rows ?? []) {
    const mtype = String(row[0] ?? "");
    let meta: Record<string, any>;
    try {
      meta = JSON.parse(String(row[1] ?? ""));
    } catch {
      continue;
    }
    const createdAt = toIso(meta.time?.created ?? null);
    if (mtype === "user") {
      const text = typeof meta.text === "string" ? meta.text.trim() : "";
      if (text) messages.push({ id: uuid(), role: "user", content: text, createdAt });
    } else if (mtype === "assistant") {
      const blocks = Array.isArray(meta.content) ? meta.content : [];
      const texts: string[] = [];
      for (const block of blocks) {
        const bt = block?.type;
        if (bt === "text" && typeof block.text === "string" && block.text.trim()) {
          if (block.synthetic === true) continue;
          texts.push(block.text);
        } else if (bt === "tool") {
          const state = block.state ?? {};
          const output = (() => {
            if (typeof state.output === "string") return state.output;
            if (typeof state.result === "string") return state.result;
            if (Array.isArray(state.content)) {
              return state.content.map((b: any) => b?.text ?? "").filter(Boolean).join("\n");
            }
            return "";
          })();
          if (texts.length) {
            messages.push({ id: uuid(), role: "assistant", content: texts.join("\n"), createdAt, status: "complete" });
            texts.length = 0;
          }
          messages.push({
            id: uuid(),
            role: "tool",
            content: output,
            createdAt,
            toolName: block.tool ?? block.name,
            toolCallId: block.callID ?? block.id,
            toolArgs: state.input,
            toolResult: output,
            toolStatus: state.error ? "error" : "success",
            isError: state.error ? true : undefined,
            status: "complete",
          });
        }
      }
      if (texts.length) {
        messages.push({ id: uuid(), role: "assistant", content: texts.join("\n"), createdAt, status: "complete" });
      }
    }
    // synthetic / system / shell 等上下文行：导入噪声
  }
  return messages;
}

// ==================== ZCode（SQLite）====================
// `~/.zcode/cli/db/db.sqlite`（Wake zcode.rs）：session/message/part 三表与
// OpenCode v1 同名同列（ZCode 是 OpenCode 衍生物）。桌面层 v2/tasks-index.sqlite
// 借两个过滤位——deleted（软删）与 migration_source（向导从 Claude 导入的副本，
// 原家已索引）。用户会话按 task_type 白名单 interactive/fork/selection_side_chat
// （老库退回 parent_id IS NULL）；model 逐消息记在 assistant 的 data.modelId。

interface ZcSchema {
  titleSource: boolean;
  taskType: boolean;
  partSequence: boolean;
  messageSequence: boolean;
}

function zcProbeColumns(result: ImportSqliteResult | null): Set<string> {
  const out = new Set<string>();
  if (!result) return out;
  const nameIdx = result.columns.indexOf("name");
  if (nameIdx < 0) return out;
  for (const row of result.rows) {
    const name = row[nameIdx];
    if (typeof name === "string") out.add(name);
  }
  return out;
}

export function createZcodeImporter(fs: ImportFs, home: string, db?: ImportDb): SessionImporter {
  void fs; // SQLite 型来源不读文件系统
  const DB_PATH = homeJoin(home, ".zcode", "cli", "db", "db.sqlite");
  const TASKS_DB = homeJoin(home, ".zcode", "v2", "tasks-index.sqlite");

  async function readSchema(): Promise<ZcSchema> {
    const [session, part, message] = await Promise.all([
      db!.query(DB_PATH, "PRAGMA table_info(session)"),
      db!.query(DB_PATH, "PRAGMA table_info(part)"),
      db!.query(DB_PATH, "PRAGMA table_info(message)"),
    ]);
    const sessionCols = zcProbeColumns(session);
    return {
      titleSource: sessionCols.has("title_source"),
      taskType: sessionCols.has("task_type"),
      partSequence: zcProbeColumns(part).has("sequence"),
      messageSequence: zcProbeColumns(message).has("sequence"),
    };
  }

  /** 桌面端要藏的会话（软删 + 向导从 Claude 导入的副本）。读不出来 = 不藏。 */
  async function readHidden(): Promise<Set<string>> {
    const hidden = new Set<string>();
    const cols = zcProbeColumns(await db!.query(TASKS_DB, "PRAGMA table_info(tasks)"));
    if (!cols.has("task_id")) return hidden;
    const predicates: string[] = [];
    if (cols.has("deleted")) predicates.push("deleted = 1");
    if (cols.has("migration_source")) {
      predicates.push("(migration_source IS NOT NULL AND migration_source != '')");
    }
    if (predicates.length === 0) return hidden;
    const result = await db!.query(TASKS_DB, `SELECT task_id FROM tasks WHERE ${predicates.join(" OR ")}`);
    for (const row of result?.rows ?? []) {
      if (typeof row[0] === "string") hidden.add(row[0]);
    }
    return hidden;
  }

  interface ZcSessionRow {
    id: string;
    directory: string;
    title: string;
    placeholder: boolean;
    createdMs: number;
    updatedMs: number;
    contentLen: number;
  }

  async function enumerate(): Promise<ZcSessionRow[]> {
    const schema = await readSchema();
    const titleCol = schema.titleSource ? "s.title_source" : "'first_input'";
    const listed = schema.taskType
      ? "s.task_type IN ('interactive', 'fork', 'selection_side_chat')"
      : "s.parent_id IS NULL";
    const result = await db!.query(
      DB_PATH,
      `SELECT s.id, s.directory, s.title, ${titleCol}, s.time_created, s.time_updated,
              (SELECT COALESCE(SUM(LENGTH(p.data)), 0) FROM part p WHERE p.session_id = s.id)
       FROM session s WHERE ${listed}`,
    );
    if (!result) return [];
    return result.rows
      .map((row) => ({
        id: String(row[0] ?? ""),
        directory: typeof row[1] === "string" ? row[1] : "",
        title: typeof row[2] === "string" ? row[2] : "",
        placeholder: row[3] === "default",
        createdMs: Number(row[4] ?? 0),
        updatedMs: Number(row[5] ?? 0),
        contentLen: Number(row[6] ?? 0),
      }))
      .filter((r) => r.id && r.contentLen > 0);
  }

  /** message + part 解析（共享 v1 解析器；Wake parse_v1_messages 的导入形态）。 */
  async function parseMessages(sessionId: string, schema: ZcSchema) {
    const partOrder = schema.partSequence ? "message_id, sequence, id" : "message_id, id";
    const messageOrder = schema.messageSequence ? "sequence, time_created, id" : "time_created, id";
    return parseV1SessionMessages(db!, DB_PATH, sessionId, partOrder, messageOrder);
  }

  return {
    source: "zcode",

    async scan(): Promise<ExternalSessionSummary[]> {
      if (!db) return [];
      const [rows, hidden, schema] = await Promise.all([enumerate(), readHidden(), readSchema()]);
      const summaries: ExternalSessionSummary[] = [];
      for (const row of rows) {
        if (hidden.has(row.id)) continue;
        const { messages, model } = await parseMessages(row.id, schema);
        if (messages.length === 0) continue;
        const firstUser = messages.find((m) => m.role === "user" && m.content.trim());
        summaries.push({
          source: "zcode",
          externalId: row.id,
          title:
            truncateTitle((row.placeholder ? "" : row.title) || firstUser?.content || "") || row.id,
          projectPath: row.directory || null,
          model,
          createdAt: toIso(row.createdMs || null),
          updatedAt: toIso(row.updatedMs || null),
          messageCount: messages.length,
          filePath: DB_PATH,
        });
      }
      return summaries;
    },

    async convert(summary: ExternalSessionSummary): Promise<ImportedSession> {
      if (!db) throw new Error("import db unavailable");
      const schema = await readSchema();
      const { messages, model } = await parseMessages(summary.externalId, schema);
      return {
        session: {
          id: importedSessionId("zcode", summary.externalId),
          title: summary.title,
          projectPath: summary.projectPath,
          modelId: model ?? summary.model,
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

// ==================== OpenCode（SQLite 新版）====================
// 现代 OpenCode 把会话存进 `~/.local/share/opencode/opencode.db`（OpenCode 2 另用
// 同目录 opencode-next.db，两库可同时存在、并行扫描——Wake opencode.rs 同款）。
// v1：session/message/part 三表；v2：正文改在 session_message 单表（type 列分
// user/synthetic/assistant）。parent_id 非空 = 子代理，不进列表。此前目录版
// importer 只覆盖旧式文件存储，两版并存、按 externalId 去重。

export function createOpencodeSqliteImporter(fs: ImportFs, home: string, db?: ImportDb): SessionImporter {
  void fs; // SQLite 型来源不读文件系统
  const DB_CANDIDATES = [
    homeJoin(home, ".local", "share", "opencode", "opencode.db"),
    homeJoin(home, ".local", "share", "opencode", "opencode-next.db"),
  ];

  async function tableSet(dbPath: string): Promise<Set<string>> {
    const result = await db!.query(dbPath, "SELECT name FROM sqlite_master WHERE type='table'");
    const names = new Set<string>();
    for (const row of result?.rows ?? []) {
      if (typeof row[0] === "string") names.add(row[0]);
    }
    return names;
  }

  /** 逐会话代数（⚠ 真库两代并存：老会话正文在 part，新会话在 session_message）。 */
  interface OcRow {
    id: string;
    directory: string;
    title: string;
    createdMs: number;
    updatedMs: number;
    isV2: boolean;
  }

  async function enumerateDb(dbPath: string): Promise<OcRow[]> {
    const tables = await tableSet(dbPath);
    if (!tables.has("session")) return [];
    const hasPart = tables.has("part");
    const hasMessage = tables.has("message");
    const hasSm = tables.has("session_message");
    // ⚠ 真库（2026-10 实测）session 表没有时间列（时间在 message/part 上），
    // 硬引用会让 prepare 失败、整家消失——时间从 message/session_message 聚合。
    const timeExprs: string[] = [];
    if (hasMessage) {
      timeExprs.push(
        "(SELECT MIN(m.time_created) FROM message m WHERE m.session_id = s.id)",
        "(SELECT MAX(m.time_updated) FROM message m WHERE m.session_id = s.id)",
      );
    } else {
      timeExprs.push("0", "0");
    }
    if (hasSm) {
      timeExprs.push(
        "(SELECT MIN(sm.time_created) FROM session_message sm WHERE sm.session_id = s.id)",
        "(SELECT MAX(sm.time_updated) FROM session_message sm WHERE sm.session_id = s.id)",
      );
    } else {
      timeExprs.push("0", "0");
    }
    const partLen = hasPart
      ? "(SELECT COALESCE(SUM(LENGTH(p.data)), 0) FROM part p WHERE p.session_id = s.id)"
      : "0";
    const smCount = hasSm
      ? "(SELECT COUNT(*) FROM session_message sm WHERE sm.session_id = s.id)"
      : "0";
    const result = await db!.query(
      dbPath,
      `SELECT s.id, s.directory, s.title, ${timeExprs.join(", ")}, ${partLen}, ${smCount}
       FROM session s WHERE s.parent_id IS NULL`,
    );
    if (!result) return [];
    return result.rows
      .map((row) => {
        // 列序：id, directory, title, msgMin, msgMax, smMin, smMax, partLen, smCount
        const partLen = Number(row[7] ?? 0);
        const smCount = Number(row[8] ?? 0);
        return {
          id: String(row[0] ?? ""),
          directory: typeof row[1] === "string" ? row[1] : "",
          title: typeof row[2] === "string" ? row[2] : "",
          // v1 会话用 message 时间；v2 会话用 session_message 时间
          createdMs: Number(row[3] ?? 0) || Number(row[5] ?? 0),
          updatedMs: Number(row[4] ?? 0) || Number(row[6] ?? 0),
          isV2: smCount > 0 && partLen === 0,
          contentTotal: partLen + smCount,
        };
      })
      .filter((r) => r.id && r.contentTotal > 0)
      .map(({ contentTotal, ...rest }) => rest);
  }

  async function parseDbSession(dbPath: string, sessionId: string, isV2: boolean): Promise<V1ParseOutcome> {
    if (isV2) {
      return { messages: await parseV2SessionMessages(db!, dbPath, sessionId), model: null };
    }
    return parseV1SessionMessages(db!, dbPath, sessionId, "message_id, id", "time_created, id");
  }

  return {
    source: "opencode",

    async scan(): Promise<ExternalSessionSummary[]> {
      if (!db) return [];
      const summaries: ExternalSessionSummary[] = [];
      for (const dbPath of DB_CANDIDATES) {
        const rows = await enumerateDb(dbPath);
        for (const row of rows) {
          const { messages, model } = await parseDbSession(dbPath, row.id, row.isV2);
          if (messages.length === 0) continue;
          const firstUser = messages.find((m) => m.role === "user" && m.content.trim());
          summaries.push({
            source: "opencode",
            externalId: row.id,
            title: truncateTitle(row.title || firstUser?.content || "") || row.id,
            projectPath: row.directory || null,
            model,
            createdAt: toIso(row.createdMs || null),
            updatedAt: toIso(row.updatedMs || null),
            messageCount: messages.length,
            filePath: dbPath,
          });
        }
      }
      return summaries;
    },

    async convert(summary: ExternalSessionSummary): Promise<ImportedSession> {
      if (!db) throw new Error("import db unavailable");
      const rows = await enumerateDb(summary.filePath);
      const own = rows.find((r) => r.id === summary.externalId);
      const { messages, model } = await parseDbSession(
        summary.filePath,
        summary.externalId,
        own?.isV2 ?? false,
      );
      return {
        session: {
          id: importedSessionId("opencode", summary.externalId),
          title: summary.title,
          projectPath: summary.projectPath,
          modelId: model ?? summary.model,
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

// ==================== Copilot CLI（SQLite）====================
// `~/.copilot/session-store.db`（Wake copilot.rs）：sessions(id,cwd,branch,summary)
// + turns(user_message,assistant_response)。无每会话文件；一轮 turn 两条正文。

export function createCopilotImporter(fs: ImportFs, home: string, db?: ImportDb): SessionImporter {
  void fs;
  const DB_PATH = homeJoin(home, ".copilot", "session-store.db");
  return {
    source: "copilot",
    async scan(): Promise<ExternalSessionSummary[]> {
      if (!db) return [];
      const result = await db.query(
        DB_PATH,
        `SELECT s.id, s.cwd, s.branch, s.summary, s.created_at, s.updated_at,
                COALESCE(SUM(LENGTH(COALESCE(t.user_message,'')) + LENGTH(COALESCE(t.assistant_response,''))), 0),
                COUNT(t.id)
         FROM sessions s LEFT JOIN turns t ON t.session_id = s.id
         GROUP BY s.id`,
      );
      const summaries: ExternalSessionSummary[] = [];
      for (const row of result?.rows ?? []) {
        const id = String(row[0] ?? "");
        if (!id || Number(row[6] ?? 0) === 0) continue;
        summaries.push({
          source: "copilot",
          externalId: id,
          title: truncateTitle(typeof row[3] === "string" ? row[3] : "") || id,
          projectPath: typeof row[1] === "string" && row[1] ? row[1] : null,
          model: null,
          createdAt: toIso(Number(row[4] ?? 0) || null),
          updatedAt: toIso(Number(row[5] ?? 0) || null),
          messageCount: null,
          filePath: DB_PATH,
        });
      }
      return summaries;
    },
    async convert(summary: ExternalSessionSummary): Promise<ImportedSession> {
      if (!db) throw new Error("import db unavailable");
      const result = await db.query(
        DB_PATH,
        "SELECT user_message, assistant_response FROM turns WHERE session_id = ? ORDER BY rowid",
        [summary.externalId],
      );
      const messages: ImportedUiMessage[] = [];
      for (const row of result?.rows ?? []) {
        const userText = typeof row[0] === "string" ? row[0] : "";
        const assistantText = typeof row[1] === "string" ? row[1] : "";
        if (userText.trim()) {
          messages.push({ id: uuid(), role: "user", content: userText, createdAt: summary.createdAt });
        }
        if (assistantText.trim()) {
          messages.push({
            id: uuid(),
            role: "assistant",
            content: assistantText,
            createdAt: summary.createdAt,
            status: "complete",
          });
        }
      }
      return {
        session: {
          id: importedSessionId("copilot", summary.externalId),
          title: summary.title,
          projectPath: summary.projectPath,
          modelId: null,
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

// ==================== Hermes Agent（SQLite）====================
// `~/.hermes/state.db` + profiles/*/state.db（Wake hermes.rs）：
// sessions(id,source,model,title,started_at,ended_at) + messages(role,content,
// tool_calls,tool_call_id,tool_name,timestamp)，时间戳 unix 秒。source == "tool"
// 的检索会话不列；tool_calls 两种形状并存（自家精简 {name,arguments} /
// OpenAI 原样 {id,type,function:{...}}）。

export function createHermesImporter(fs: ImportFs, home: string, db?: ImportDb): SessionImporter {
  void fs;
  const HERMES_HOME = homeJoin(home, ".hermes");
  return {
    source: "hermes",
    async scan(): Promise<ExternalSessionSummary[]> {
      if (!db) return [];
      // 主库（profiles/*/state.db 的枚举需要 fs 目录列表，导入 v1 只覆盖主库）
      const candidates = [homeJoin(HERMES_HOME, "state.db")];
      const summaries: ExternalSessionSummary[] = [];
      for (const dbPath of candidates) {
        const result = await db.query(
          dbPath,
          "SELECT s.id, s.source, s.model, s.title, s.started_at, s.ended_at FROM sessions s WHERE COALESCE(s.source,'') != 'tool'",
        );
        if (!result) continue;
        for (const row of result.rows) {
          const id = String(row[0] ?? "");
          if (!id) continue;
          summaries.push({
            source: "hermes",
            externalId: id,
            title: truncateTitle(typeof row[3] === "string" ? row[3] : "") || id,
            projectPath: null,
            model: typeof row[2] === "string" && row[2] ? row[2] : null,
            createdAt: toIso(Number(row[4] ?? 0) * 1000 || null),
            updatedAt: toIso(Number(row[5] ?? 0) * 1000 || null),
            messageCount: null,
            filePath: dbPath,
          });
        }
      }
      return summaries;
    },
    async convert(summary: ExternalSessionSummary): Promise<ImportedSession> {
      if (!db) throw new Error("import db unavailable");
      const result = await db.query(
        summary.filePath,
        "SELECT id, role, content, tool_call_id, tool_calls, tool_name, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp, id",
        [summary.externalId],
      );
      const messages: ImportedUiMessage[] = [];
      const pending = new Map<string, { name?: string; args?: unknown }>();
      const unnamedQueue: { name?: string; args?: unknown }[] = [];
      for (const row of result?.rows ?? []) {
        const role = String(row[1] ?? "");
        const content = typeof row[2] === "string" ? row[2] : "";
        const toolCallId = typeof row[3] === "string" && row[3] ? row[3] : undefined;
        const toolCallsRaw = typeof row[4] === "string" && row[4] ? row[4] : "";
        const toolName = typeof row[5] === "string" && row[5] ? row[5] : undefined;
        const createdAt = toIso(Number(row[6] ?? 0) * 1000 || null, summary.createdAt);
        if (role === "assistant") {
          if (toolCallsRaw) {
            try {
              const calls = JSON.parse(toolCallsRaw) as any[];
              for (const call of calls) {
                const name = call?.name ?? call?.function?.name;
                let args = call?.arguments ?? call?.function?.arguments;
                if (typeof args === "string") {
                  try {
                    args = JSON.parse(args);
                  } catch {
                    args = { raw: args };
                  }
                }
                const entry = { name, args };
                if (call?.id) pending.set(String(call.id), entry);
                else unnamedQueue.push(entry);
              }
            } catch {
              // tool_calls 残行不遮正文
            }
          }
          if (content.trim()) {
            messages.push({ id: uuid(), role: "assistant", content, createdAt, status: "complete" });
          }
        } else if (role === "tool") {
          let entry: { name?: string; args?: unknown } | undefined;
          if (toolCallId) entry = pending.get(toolCallId);
          if (!entry && toolName) entry = unnamedQueue.find((e) => e.name === toolName);
          if (!entry) entry = unnamedQueue.shift();
          messages.push({
            id: uuid(),
            role: "tool",
            content,
            createdAt,
            toolName: toolName ?? entry?.name,
            toolCallId,
            toolArgs: entry?.args,
            toolResult: content,
            status: "complete",
          });
        } else if (role === "user" && content.trim()) {
          messages.push({ id: uuid(), role: "user", content, createdAt });
        }
      }
      return {
        session: {
          id: importedSessionId("hermes", summary.externalId),
          title: summary.title,
          projectPath: null,
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

// ==================== Devin（SQLite）====================
// `~/.local/share/devin/cli/sessions.db`（Wake devin.rs，XDG 形态）：
// sessions(id,title,working_directory,model,hidden,main_chain_id,…) +
// message_nodes(session_id,node_id,parent_node_id,chat_message,created_at)。
// 可见转录 = 从 main_chain_id 沿 parent_node_id 走回根的链（叶子悬空/成环
// 退回 created_at,row_id 全列）。chat_message JSON：role user/assistant/
// system/tool；assistant 的 tool_calls [{id,name,arguments}]；tool 行按
// tool_call_id 回填。hidden=1 与内部来源（telemetry.source != user、
// is_user_input=false、compaction 请求正文）不列/不进。

export function createDevinImporter(fs: ImportFs, home: string, db?: ImportDb): SessionImporter {
  void fs;
  const DB_PATH = homeJoin(home, ".local", "share", "devin", "cli", "sessions.db");
  return {
    source: "devin",
    async scan(): Promise<ExternalSessionSummary[]> {
      if (!db) return [];
      const result = await db.query(
        DB_PATH,
        `SELECT s.id, s.title, s.working_directory, s.model, s.created_at, s.last_activity_at, s.main_chain_id, s.hidden
         FROM sessions s WHERE COALESCE(s.hidden, 0) = 0`,
      );
      if (!result) return [];
      const summaries: ExternalSessionSummary[] = [];
      for (const row of result.rows) {
        const id = String(row[0] ?? "");
        if (!id) continue;
        summaries.push({
          source: "devin",
          externalId: id,
          title: truncateTitle(typeof row[1] === "string" ? row[1] : "") || id,
          projectPath: typeof row[2] === "string" && row[2] ? row[2] : null,
          model: typeof row[3] === "string" && row[3] ? row[3] : null,
          createdAt: toIso(Number(row[4] ?? 0) * 1000 || null),
          updatedAt: toIso(Number(row[5] ?? 0) * 1000 || null),
          messageCount: null,
          filePath: DB_PATH,
        });
      }
      return summaries;
    },
    async convert(summary: ExternalSessionSummary): Promise<ImportedSession> {
      if (!db) throw new Error("import db unavailable");
      const [nodesResult, sessionResult] = await Promise.all([
        db.query(
          DB_PATH,
          "SELECT row_id, node_id, parent_node_id, chat_message, created_at FROM message_nodes WHERE session_id = ? ORDER BY created_at, row_id",
          [summary.externalId],
        ),
        db.query(DB_PATH, "SELECT main_chain_id FROM sessions WHERE id = ?", [summary.externalId]),
      ]);
      const mainChainId = sessionResult?.rows?.[0]?.[0];
      interface Node {
        rowId: number;
        nodeId: string;
        parentId: string | null;
        message: Record<string, any>;
        createdAt: number;
      }
      const nodes: Node[] = [];
      for (const row of nodesResult?.rows ?? []) {
        try {
          nodes.push({
            rowId: Number(row[0] ?? 0),
            nodeId: String(row[1] ?? ""),
            parentId: typeof row[2] === "string" && row[2] ? row[2] : null,
            message: JSON.parse(String(row[3] ?? "{}")),
            createdAt: Number(row[4] ?? 0),
          });
        } catch {
          // 残行跳过
        }
      }
      // 主链：从 main_chain_id 沿 parent 走回根；失败退回全列。
      const byId = new Map(nodes.map((n) => [n.nodeId, n]));
      let chain: Node[] | null = null;
      if (typeof mainChainId === "string" && byId.has(mainChainId)) {
        const walked: Node[] = [];
        const seen = new Set<string>();
        let cursor: Node | undefined = byId.get(mainChainId);
        while (cursor && !seen.has(cursor.nodeId)) {
          seen.add(cursor.nodeId);
          walked.push(cursor);
          cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
        }
        chain = walked.reverse();
      }
      const ordered = chain ?? nodes;
      const messages: ImportedUiMessage[] = [];
      const pending = new Map<string, { name?: string; args?: unknown }>();
      for (const node of ordered) {
        const msg = node.message;
        const role = msg.role;
        const content = typeof msg.content === "string" ? msg.content : "";
        const createdAt = toIso(node.createdAt * 1000 || null, summary.createdAt);
        if (role === "assistant") {
          for (const call of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
            if (call?.id) pending.set(String(call.id), { name: call.name, args: call.arguments });
          }
          if (content.trim()) {
            messages.push({ id: uuid(), role: "assistant", content, createdAt, status: "complete" });
          }
        } else if (role === "tool") {
          const entry = msg.tool_call_id ? pending.get(String(msg.tool_call_id)) : undefined;
          messages.push({
            id: uuid(),
            role: "tool",
            content,
            createdAt,
            toolName: entry?.name,
            toolCallId: msg.tool_call_id ? String(msg.tool_call_id) : undefined,
            toolArgs: entry?.args,
            toolResult: content,
            status: "complete",
          });
        } else if (role === "user") {
          // 内部消息归 Meta 不进：心跳/注入/compaction 请求正文
          const meta = msg.metadata ?? {};
          const telemetrySource = meta.telemetry?.source;
          if (typeof telemetrySource === "string" && telemetrySource !== "user") continue;
          if (meta.is_user_input === false) continue;
          if (content.startsWith("Conversation to summarize:") || content.startsWith("Now summarize the conversation above")) {
            continue;
          }
          if (content.trim()) messages.push({ id: uuid(), role: "user", content, createdAt });
        }
        // system 角色：注入上下文，不进
      }
      return {
        session: {
          id: importedSessionId("devin", summary.externalId),
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

// ==================== OpenClaw（SQLite + legacy JSONL）====================
// `~/.openclaw/agents/<agentId>/`（Wake openclaw.rs）：现版 `agent/
// openclaw-agent.sqlite`（transcript_events 的 event_json 即 pi 系一行，
// session_transcript_active_events 给活跃分支，缺表退回最后一条为叶回溯）；
// 旧版 `sessions/<id>.jsonl` 同格式明文。spawned_by 非空 = 子代理，不列。
// 消息形状即 pi-ai（与 pi importer 同构）。

export function createOpenclawImporter(fs: ImportFs, home: string, db?: ImportDb): SessionImporter {
  const AGENTS_DIR = homeJoin(home, ".openclaw", "agents");
  return {
    source: "openclaw",

    async scan(): Promise<ExternalSessionSummary[]> {
      const summaries: ExternalSessionSummary[] = [];
      let agentDirs: string[] = [];
      try {
        agentDirs = await fs.listDir(AGENTS_DIR);
      } catch {
        return [];
      }
      for (const agentId of agentDirs) {
        const agentRoot = homeJoin(AGENTS_DIR, agentId);
        // 现版：agent/openclaw-agent.sqlite
        const dbPath = homeJoin(agentRoot, "agent", "openclaw-agent.sqlite");
        if (db) {
          const rows = await db.query(
            dbPath,
            "SELECT session_id, COALESCE(label,''), COALESCE(created_at,0), COALESCE(updated_at,0), COALESCE(spawned_by,'') FROM session_windows",
          );
          for (const row of rows?.rows ?? []) {
            const id = String(row[0] ?? "");
            if (!id) continue;
            const spawnedBy = String(row[4] ?? "");
            if (spawnedBy) continue; // 子代理运行记录不列
            // cwd 从首条事件解出（event_json header）
            let cwd = "";
            try {
              const ev = await db.query(
                dbPath,
                "SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq LIMIT 1",
                [id],
              );
              const raw = ev?.rows?.[0]?.[0];
              if (typeof raw === "string") {
                const header = JSON.parse(raw) as Record<string, any>;
                if (typeof header.cwd === "string") cwd = header.cwd;
              }
            } catch {
              // cwd 缺失不遮会话
            }
            summaries.push({
              source: "openclaw",
              externalId: `${agentId}/${id}`,
              title: truncateTitle(String(row[1] ?? "")) || id,
              projectPath: cwd || null,
              model: null,
              createdAt: toIso(Number(row[2] ?? 0) * 1000 || null),
              updatedAt: toIso(Number(row[3] ?? 0) * 1000 || null),
              messageCount: null,
              filePath: dbPath,
            });
          }
        }
        // 旧版：sessions/<id>.jsonl（同 pi 格式）
        const legacyDir = homeJoin(agentRoot, "sessions");
        let legacyFiles: string[] = [];
        try {
          legacyFiles = (await fs.listDir(legacyDir)).filter(
            (f) => f.endsWith(".jsonl") && !f.includes(".checkpoint."),
          );
        } catch {
          legacyFiles = [];
        }
        for (const file of legacyFiles) {
          const filePath = homeJoin(legacyDir, file);
          const parsed = await parsePiFile(fs, filePath);
          if (!parsed) continue;
          const messageEntries = parsed.entries.filter((e) => e.type === "message");
          if (messageEntries.length === 0) continue;
          const id = file.replace(/\.jsonl$/, "");
          // 库里已有同 id（doctor --fix 迁移过）→ 跳过 jsonl 副本
          if (summaries.some((s) => s.externalId === `${agentId}/${id}`)) continue;
          const firstUser = messageEntries.find(
            (e) => e.message?.role === "user" && contentText(e.message.content),
          );
          summaries.push({
            source: "openclaw",
            externalId: `${agentId}/${id}`,
            title: truncateTitle(contentText(firstUser?.message?.content) ?? "") || id,
            projectPath: parsed.header.cwd ?? null,
            model: messageEntries.find((e) => e.message?.role === "assistant")?.message?.model ?? null,
            createdAt: toIso(parsed.header.timestamp),
            updatedAt: toIso(
              messageEntries[messageEntries.length - 1]?.timestamp ?? parsed.header.timestamp,
            ),
            messageCount: messageEntries.length,
            filePath,
          });
        }
      }
      return summaries;
    },

    async convert(summary: ExternalSessionSummary): Promise<ImportedSession> {
      const sessionId = summary.externalId.split("/").slice(1).join("/");
      const messages: ImportedUiMessage[] = [];
      if (summary.filePath.endsWith(".jsonl")) {
        const parsed = await parsePiFile(fs, summary.filePath);
        const pending = new Map<string, { name?: string; args?: unknown }>();
        for (const entry of parsed?.entries ?? []) {
          if (entry.type !== "message" || !entry.message) continue;
          const msg = entry.message;
          const createdAt = toIso(msg.timestamp ?? entry.timestamp, summary.createdAt);
          if (msg.role === "user") {
            const text = contentText(msg.content);
            if (text) messages.push({ id: uuid(), role: "user", content: text, createdAt });
          } else if (msg.role === "assistant") {
            const text = contentText(msg.content);
            if (text) {
              messages.push({ id: uuid(), role: "assistant", content: text, createdAt, status: "complete" });
            }
            for (const b of Array.isArray(msg.content) ? msg.content : []) {
              if (b.type === "toolCall" && b.id) pending.set(b.id, { name: b.name, args: b.arguments });
            }
          } else if (msg.role === "toolResult" && msg.toolCallId) {
            const entry = pending.get(msg.toolCallId);
            const resultText = contentText(msg.content);
            messages.push({
              id: uuid(),
              role: "tool",
              content: resultText,
              createdAt,
              toolName: msg.toolName ?? entry?.name,
              toolCallId: msg.toolCallId,
              toolArgs: entry?.args,
              toolResult: resultText,
              toolStatus: msg.isError ? "error" : "success",
              isError: msg.isError === true || undefined,
              status: "complete",
            });
          }
        }
      } else if (db) {
        const result = await db.query(
          summary.filePath,
          "SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq",
          [sessionId],
        );
        const pending = new Map<string, { name?: string; args?: unknown }>();
        for (const row of result?.rows ?? []) {
          let parsed: Record<string, any>;
          try {
            parsed = JSON.parse(String(row[0] ?? "{}"));
          } catch {
            continue;
          }
          if (parsed.type !== "message" || !parsed.message) continue;
          const msg = parsed.message;
          const createdAt = toIso(msg.timestamp ?? parsed.timestamp, summary.createdAt);
          if (msg.role === "user") {
            const text = contentText(msg.content);
            if (text) messages.push({ id: uuid(), role: "user", content: text, createdAt });
          } else if (msg.role === "assistant") {
            const text = contentText(msg.content);
            if (text) {
              messages.push({ id: uuid(), role: "assistant", content: text, createdAt, status: "complete" });
            }
            for (const b of Array.isArray(msg.content) ? msg.content : []) {
              if (b.type === "toolCall" && b.id) pending.set(b.id, { name: b.name, args: b.arguments });
            }
          } else if (msg.role === "toolResult" && msg.toolCallId) {
            const entry = pending.get(msg.toolCallId);
            const resultText = contentText(msg.content);
            messages.push({
              id: uuid(),
              role: "tool",
              content: resultText,
              createdAt,
              toolName: msg.toolName ?? entry?.name,
              toolCallId: msg.toolCallId,
              toolArgs: entry?.args,
              toolResult: resultText,
              toolStatus: msg.isError ? "error" : "success",
              isError: msg.isError === true || undefined,
              status: "complete",
            });
          }
        }
      }
      return {
        session: {
          id: importedSessionId("openclaw", summary.externalId),
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

// ==================== Cursor（CLI 转录 + IDE vscdb）====================
// CLI：`~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl`
// （Wake cursor.rs）：{role, message:{content:[{type:text|tool_use}]}} +
// {type:"turn_ended"}；user 正文包在 <timestamp>/<user_query> 壳里。
// IDE：`state.vscdb` 的 cursorDiskKV 表——composerData:<id>（元数据 + 气泡
// 顺序 fullConversationHeadersOnly）与 bubbleId:<id>:<bubble>（正文 text/
// thinking/toolFormerData）。cwd/模型优先从 IDE composerData 借。

function cursorUnwrapUserText(text: string): string {
  const m = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (m) return m[1].trim();
  return text.replace(/^<timestamp>[\s\S]*?<\/timestamp>\s*/, "").trim();
}

function decodeBlobValue(value: unknown): Record<string, any> | null {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as Record<string, any>;
  } catch {
    // vscdb 的 value 可能是 base64 编码的 BLOB
    try {
      const decoded = Buffer.from(value, "base64").toString("utf8");
      return JSON.parse(decoded) as Record<string, any>;
    } catch {
      return null;
    }
  }
}

export function createCursorImporter(fs: ImportFs, home: string, db?: ImportDb): SessionImporter {
  const PROJECTS_DIR = homeJoin(home, ".cursor", "projects");
  const STATE_DB = homeJoin(
    home,
    ".config",
    "Cursor",
    "User",
    "globalStorage",
    "state.vscdb",
  );

  async function composerFacts(composerId: string): Promise<{ cwd: string | null; model: string | null }> {
    if (!db) return { cwd: null, model: null };
    const result = await db.query(STATE_DB, "SELECT value FROM cursorDiskKV WHERE key = ?", [
      `composerData:${composerId}`,
    ]);
    const data = decodeBlobValue(result?.rows?.[0]?.[0]);
    if (!data) return { cwd: null, model: null };
    const cwd =
      (typeof data.workspaceIdentifier?.uri?.fsPath === "string" && data.workspaceIdentifier.uri.fsPath) ||
      (typeof data.cwd === "string" && data.cwd) ||
      null;
    const model = typeof data.modelName === "string" && data.modelName ? data.modelName : null;
    return { cwd: cwd || null, model };
  }

  async function parseCliTranscript(filePath: string, fallback: ExternalSessionSummary): Promise<ImportedUiMessage[]> {
    const raw = await fs.readText(filePath);
    const rows = parseJsonLines<Record<string, any>>(raw ?? "");
    const messages: ImportedUiMessage[] = [];
    const pending = new Map<string, { name?: string; args?: unknown }>();
    for (const row of rows) {
      if (row.type === "turn_ended" || !row.role) continue;
      const content = row.message?.content;
      const blocks = Array.isArray(content) ? content : [];
      const createdAt = toIso(row.timestamp ?? null, fallback.createdAt);
      if (row.role === "user") {
        const text = blocks
          .filter((b: any) => b?.type === "text" && typeof b.text === "string")
          .map((b: any) => b.text as string)
          .join("\n");
        // <user_query> 壳里是真人输入；无该壳的是注入上下文（workspace 等）→ 跳过
        const hasQueryShell = text.includes("<user_query>");
        const unwrapped = cursorUnwrapUserText(text);
        if (hasQueryShell && unwrapped) {
          messages.push({ id: uuid(), role: "user", content: unwrapped, createdAt });
        }
      } else if (row.role === "assistant") {
        const text = blocks
          .filter((b: any) => b?.type === "text" && typeof b.text === "string")
          .map((b: any) => b.text as string)
          .join("\n");
        if (text.trim()) {
          messages.push({ id: uuid(), role: "assistant", content: text, createdAt, status: "complete" });
        }
        for (const b of blocks) {
          if (b?.type === "tool_use") {
            const id = b.id ?? b.tool_use_id;
            if (id) pending.set(String(id), { name: b.name, args: b.input });
          }
        }
      }
      // tool_result 块（user 行内）与 tool_use 配对
      if (row.role === "user") {
        for (const b of blocks) {
          if (b?.type !== "tool_result") continue;
          const id = String(b.tool_use_id ?? "");
          const entry = pending.get(id);
          pending.delete(id);
          const resultText =
            typeof b.content === "string"
              ? b.content
              : Array.isArray(b.content)
                ? b.content.map((x: any) => x?.text ?? "").filter(Boolean).join("\n")
                : "";
          messages.push({
            id: uuid(),
            role: "tool",
            content: resultText,
            createdAt,
            toolName: entry?.name,
            toolCallId: id || undefined,
            toolArgs: entry?.args,
            toolResult: resultText,
            isError: b.is_error === true || undefined,
            status: "complete",
          });
        }
      }
    }
    return messages;
  }

  return {
    source: "cursor",

    async scan(): Promise<ExternalSessionSummary[]> {
      let slugDirs: string[] = [];
      try {
        slugDirs = await fs.listDir(PROJECTS_DIR);
      } catch {
        return [];
      }
      const summaries: ExternalSessionSummary[] = [];
      for (const slug of slugDirs) {
        const transcriptsDir = homeJoin(PROJECTS_DIR, slug, "agent-transcripts");
        let sessionDirs: string[] = [];
        try {
          sessionDirs = await fs.listDir(transcriptsDir);
        } catch {
          continue;
        }
        for (const sessionId of sessionDirs) {
          const filePath = homeJoin(transcriptsDir, sessionId, `${sessionId}.jsonl`);
          const raw = await fs.readText(filePath);
          if (raw == null) continue;
          const rows = parseJsonLines<Record<string, any>>(raw);
          const hasBody = rows.some(
            (r) => r.role && JSON.stringify(r.message?.content ?? "").length > 0,
          );
          if (!hasBody) continue; // turn_ended 空壳（正文在 IDE 库）不列
          const facts = await composerFacts(sessionId);
          // slug 还原兜底：'-Users-tester-proj' → '/Users/tester/proj'
          const slugPath = slug.startsWith("-") ? `/${slug.slice(1).replace(/-/g, "/")}` : null;
          const firstUser = rows.find((r) => r.role === "user");
          const firstText = Array.isArray(firstUser?.message?.content)
            ? firstUser.message.content
                .filter((b: any) => b?.type === "text")
                .map((b: any) => String(b.text ?? ""))
                .join("\n")
            : "";
          const lastTs = rows.reduce(
            (acc, r) => (Number(r.timestamp ?? 0) > acc ? Number(r.timestamp) : acc),
            0,
          );
          summaries.push({
            source: "cursor",
            externalId: sessionId,
            title: truncateTitle(cursorUnwrapUserText(firstText)) || sessionId,
            projectPath: facts.cwd ?? slugPath,
            model: facts.model,
            createdAt: toIso(lastTs || null),
            updatedAt: toIso(lastTs || null),
            messageCount: rows.filter((r) => r.role).length,
            filePath,
          });
        }
      }
      return summaries;
    },

    async convert(summary: ExternalSessionSummary): Promise<ImportedSession> {
      const messages = await parseCliTranscript(summary.filePath, summary);
      return {
        session: {
          id: importedSessionId("cursor", summary.externalId),
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

// ==================== DeepSeek Harness（dsh）====================
// `~/.dsh/sessions/--<cwd 转义>--/<id>/session[.vN].jsonl`（Wake dsh.rs）：
// 日志文件名带格式代数，读编号最大的那一代（dsh 迁移只增不删）。v0-v1 有
// assistant/chunk 与打包行（跳过）；v2 起流嵌在消息里。user/message 的
// source.kind=="user" 才是真人输入；agent-instructions/plugin 等归 Meta；
// tool/result 按 toolCallId 回填；session/title last-wins。delegationDepth>0
// 或 origin=="subagent" 是子代理会话，不列。
// ⚠ 用户拍板（2026-10-06）：默认落盘是 zstd 多帧连接，TS 侧不做解压——
// 只读未压缩代（`session[.vN].jsonl`）；只有 .zstd 的会话跳过（如实少列）。

export function createDshImporter(fs: ImportFs, home: string): SessionImporter {
  const SESSIONS_DIR = homeJoin(home, ".dsh", "sessions");

  /**
   * 代数：session.jsonl = v0，session.vN.jsonl = N；.zstd 同代（解压后同内容，
   * 同代并存时未压缩版优先——省解压）。用户拍板修订（2026-10-07）：真机 dsh
   * 默认落盘即 zstd，唯一会话只有 .zstd——原「仅未压缩」决定按现实放宽，
   * 经 readTextAuto（Rust zstd 多帧解码）透明读取。
   */
  function generationOf(fileName: string): number | null {
    const zstd = fileName.endsWith(".zstd");
    const base = zstd ? fileName.slice(0, -".zstd".length) : fileName;
    if (base === "session.jsonl") return 0;
    const m = base.match(/^session\.v(\d+)\.jsonl$/);
    if (m) return Number(m[1]) * 2 + (zstd ? 0 : 1); // 同代未压缩优先（权重高 1）
    return null;
  }

  function contentBlocksText(content: unknown, kinds: Set<string>): string {
    if (!Array.isArray(content)) return "";
    return content
      .filter((b: any) => b && kinds.has(b.type) && typeof b.text === "string" && b.text.trim())
      .map((b: any) => b.text as string)
      .join("\n");
  }

  async function readSession(dirPath: string): Promise<{
    header: Record<string, any>;
    rows: Record<string, any>[];
  } | null> {
    let files: string[] = [];
    try {
      files = await fs.listDir(dirPath);
    } catch {
      return null;
    }
    let best: { gen: number; file: string } | null = null;
    for (const file of files) {
      const gen = generationOf(file);
      if (gen === null) continue;
      if (!best || gen > best.gen) best = { gen, file };
    }
    if (!best) return null; // 目录里没有任何可读日志
    const chosen = homeJoin(dirPath, best.file);
    const raw = best.file.endsWith(".zstd")
      ? ((await fs.readTextAuto?.(chosen)) ?? null)
      : await fs.readText(chosen);
    if (raw == null) return null;
    const rows = parseJsonLines<Record<string, any>>(raw);
    const header = rows.find((r) => r.type === "session");
    if (!header) return null;
    return { header, rows };
  }

  function parseRows(rows: Record<string, any>[], header: Record<string, any>): {
    messages: ImportedUiMessage[];
    title: string;
    model: string | null;
    lastTs: number;
  } {
    const messages: ImportedUiMessage[] = [];
    const pending = new Map<string, { name?: string; args?: unknown }>();
    let title = "";
    let model: string | null = null;
    let lastTs = Number(header.createdAt ?? 0);
    for (const raw of rows) {
      const event = (raw.data ?? raw) as Record<string, any>;
      const type = raw.type;
      if (typeof raw.time === "number") lastTs = Math.max(lastTs, raw.time);
      if (type === "session/title" && typeof event.title === "string" && event.title.trim()) {
        title = event.title.trim();
      } else if (type === "user/message") {
        if (event.source?.kind !== "user" && raw.source?.kind !== "user") continue;
        const text = contentBlocksText(event.content ?? raw.content, new Set(["text"]));
        if (text) messages.push({ id: uuid(), role: "user", content: text, createdAt: toIso(lastTs || null) });
      } else if (type === "assistant/message") {
        const message = event.message ?? event;
        const source = message.source ?? event.source;
        if (typeof source?.model === "string" && source.model) model = source.model;
        const content = message.content ?? [];
        if (Array.isArray(content)) {
          const text = contentBlocksText(content, new Set(["text"]));
          if (text) {
            messages.push({
              id: uuid(),
              role: "assistant",
              content: text,
              createdAt: toIso(lastTs || null),
              status: "complete",
            });
          }
          for (const block of content) {
            const bt = block?.type;
            if ((bt === "tool-call" || bt === "toolCall") && (block.id || block.callId)) {
              let args = block.arguments ?? block.args;
              if (typeof args === "string") {
                try {
                  args = JSON.parse(args);
                } catch {
                  args = { raw: args };
                }
              }
              pending.set(String(block.id ?? block.callId), { name: block.name, args });
            }
          }
        }
      } else if (type === "tool/call") {
        let args = event.arguments;
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            args = { raw: args };
          }
        }
        if (event.callId) pending.set(String(event.callId), { name: event.name, args });
      } else if (type === "tool/result") {
        const message = event.message ?? event;
        const callId = message.toolCallId ?? message.source?.callId ?? event.toolCallId;
        const blocks = Array.isArray(message.content) ? message.content : [];
        const toolResultBlock = blocks.find((b: any) => b?.type === "tool-result");
        const text =
          contentBlocksText(blocks, new Set(["text"])) ||
          contentBlocksText(toolResultBlock?.content, new Set(["text"]));
        const entry = callId ? pending.get(String(callId)) : undefined;
        if (callId) pending.delete(String(callId));
        if (text || callId) {
          messages.push({
            id: uuid(),
            role: "tool",
            content: text,
            createdAt: toIso(lastTs || null),
            toolName: entry?.name ?? toolResultBlock?.name,
            toolCallId: callId ? String(callId) : undefined,
            toolArgs: entry?.args,
            toolResult: text,
            isError: toolResultBlock?.isError === true || undefined,
            status: "complete",
          });
        }
      }
      // system/message、developer/message、chunk 打包行、turn/step/compaction 等：导入噪声
    }
    return { messages, title, model, lastTs };
  }

  return {
    source: "dsh",

    async scan(): Promise<ExternalSessionSummary[]> {
      let cwdDirs: string[] = [];
      try {
        cwdDirs = await fs.listDir(SESSIONS_DIR);
      } catch {
        return [];
      }
      const summaries: ExternalSessionSummary[] = [];
      for (const cwdDir of cwdDirs) {
        const cwdPath = homeJoin(SESSIONS_DIR, cwdDir);
        let sessionDirs: string[] = [];
        try {
          sessionDirs = await fs.listDir(cwdPath);
        } catch {
          continue;
        }
        for (const sessionDir of sessionDirs) {
          const dirPath = homeJoin(cwdPath, sessionDir);
          const read = await readSession(dirPath);
          if (!read) continue;
          const { header, rows } = read;
          if (header.origin === "subagent" || Number(header.delegationDepth ?? 0) > 0) continue;
          const { messages, title, model, lastTs } = parseRows(rows, header);
          if (messages.length === 0) continue;
          const id = String(header.id ?? sessionDir);
          const firstUser = messages.find((m) => m.role === "user");
          summaries.push({
            source: "dsh",
            externalId: id,
            title: truncateTitle(title || firstUser?.content || "") || id,
            projectPath: typeof header.cwd === "string" && header.cwd ? header.cwd : null,
            model,
            createdAt: toIso(Number(header.createdAt ?? 0) || null),
            updatedAt: toIso(lastTs || null),
            messageCount: messages.length,
            filePath: dirPath,
          });
        }
      }
      return summaries;
    },

    async convert(summary: ExternalSessionSummary): Promise<ImportedSession> {
      const read = await readSession(summary.filePath);
      const messages = read ? parseRows(read.rows, read.header).messages : [];
      return {
        session: {
          id: importedSessionId("dsh", summary.externalId),
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

export function createSessionImporters(fs: ImportFs, home: string, db?: ImportDb): SessionImporter[] {
  return [
    createClaudeImporter(fs, home),
    createOpencodeImporter(fs, home),
    createCodexImporter(fs, home),
    createPiImporter(fs, home),
    createOmpImporter(fs, home),
    createKiroImporter(fs, home),
    createQoderImporter(fs, home),
    createKimiImporter(fs, home),
    createCodebuddyImporter(fs, home),
    createWorkbuddyImporter(fs, home),
    createGeminiImporter(fs, home),
    createGrokImporter(fs, home),
    createCraftImporter(fs, home),
    createZcodeImporter(fs, home, db),
    createOpencodeSqliteImporter(fs, home, db),
    createCopilotImporter(fs, home, db),
    createHermesImporter(fs, home, db),
    createDevinImporter(fs, home, db),
    createOpenclawImporter(fs, home, db),
    createCursorImporter(fs, home, db),
    createDshImporter(fs, home),
  ];
}
