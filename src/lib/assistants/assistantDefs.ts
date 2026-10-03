/**
 * assistantDefs —— 助手（主对话人设预设）数据层。
 *
 * 定位与子智能体互补：子智能体是主模型的「委派工」（独立上下文跑子任务）；
 * 助手是「主对话人设」（切换后改变当前对话的系统提示词人设段）。
 * 助手不携带模型/推理预设——模型与推理强度一律跟随设置里的默认。
 *
 * 存储：`~/.ReinAgent/assistants/<id>.md`（frontmatter：name/description +
 * 正文 = 人设指令）。与子智能体同风格，用户可手改；旧文件里的 model/thinkingLevel
 * frontmatter 读取时忽略。
 * 内置预设（general/coder/writer/translator）为编译期常量，v1 不可编辑删除；
 * 用户自定义同名遮蔽内置。
 */

import { resolveWorkspacePath } from "../agent/workspace.ts";

export const ASSISTANTS_DIR_DISPLAY = "~/.ReinAgent/assistants";
export const MAX_ASSISTANTS = 32;
export const MAX_ASSISTANT_BYTES = 32 * 1024;
/** 默认助手 id：无人设注入，行为与未引入助手功能前完全一致。 */
export const GENERAL_ASSISTANT_ID = "general";

export interface AssistantDef {
  id: string;
  name: string;
  description: string;
  /** 人设指令（正文）。general 为空 = 无注入。 */
  prompt: string;
  builtin?: boolean;
}

export interface UserAssistantInput {
  id: string;
  name: string;
  description: string;
  prompt: string;
}

export function assistantSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return /^[a-z0-9]/.test(slug) ? slug : "";
}

/** 生成中文名助手的稳定 ASCII id（调用方在「打开编辑器」时固定一次，勿在渲染期调用）。 */
export function fallbackAssistantId(): string {
  return `assistant-${Date.now().toString(36).slice(-6)}`;
}

// ---------- frontmatter 解析 / 序列化（与子智能体同风格） ----------

function splitFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) return { meta: {}, body: normalized.trim() };
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: normalized.trim() };
  const head = normalized.slice(3, end).trim();
  const body = normalized.slice(end + 4).replace(/^\n+/, "").trim();
  const meta: Record<string, string> = {};
  for (const line of head.split("\n")) {
    const pair = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (pair) {
      const key = pair[1].replace(/-[a-z]/g, (c) => c[1].toUpperCase());
      meta[key] = pair[2].trim();
    }
  }
  return { meta, body };
}

export function parseAssistantDocument(raw: string): {
  ok: boolean;
  def?: Omit<AssistantDef, "builtin">;
  errors: string[];
} {
  const errors: string[] = [];
  const { meta, body } = splitFrontmatter(raw);
  const displayName = meta.name ?? "";
  const description = meta.description ?? "";
  // id：显式 id 行优先（用户助手保存时写入）；回退 name（内置预设 name==id）
  const id = meta.id ?? displayName;
  if (!displayName) errors.push("missing name");
  if (!description) errors.push("missing description");
  if (!body) errors.push("empty prompt body");
  if (new TextEncoder().encode(raw).length > MAX_ASSISTANT_BYTES) errors.push("document too large");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    def: {
      id,
      name: displayName,
      description,
      prompt: body,
    },
  };
}

export function renderAssistantDocument(def: {
  id: string;
  name: string;
  description: string;
  prompt: string;
}): string {
  // name = 用户起的显示名（支持中文）；id = 稳定 ASCII 句柄（文件名/#提及用）。
  // name 与 id 一致时不写冗余 id 行（内置预设与旧文件同形态）。
  const lines = ["---", `name: ${def.name}`, `description: ${def.description}`];
  if (def.id !== def.name) lines.push(`id: ${def.id}`);
  lines.push("---", "", def.prompt.trim(), "");
  return lines.join("\n");
}

// ---------- 内置预设 ----------

const BUILTIN_DOCUMENTS: readonly { id: string; name: string; description: string; prompt: string }[] = [
  {
    id: "general",
    name: "通用助手",
    description: "日常与工作通用的默认人设，覆盖生活咨询与一般性任务。",
    prompt: `You are a versatile general-purpose assistant. Preferences for this conversation:

- Match the user's intent and level: answer everyday questions directly and practically; for work tasks, be structured and precise.
- Prefer concrete, actionable answers over abstract advice; when a decision is needed, state a recommended option with one-line reasoning.
- Ask a clarifying question only when the request is genuinely ambiguous and the answer would change materially.
- Answer in the user's language; keep formatting light (plain sentences first, lists only when they aid scanning).`,
  },
  {
    id: "coder",
    name: "代码专家",
    description: "先读后改、小步提交式修改，回答直给代码与关键取舍。",
    prompt: `You are ReinAgent, an interactive coding agent that helps users with software engineering tasks. You can read, write and edit files, execute commands in the terminal, and help users with coding tasks. Preferences for this conversation:

- One-off scripts, analysis artifacts and other temporary files must be placed under \`.ReinAgent/temp/\` at the workspace root — never scattered in the project; files there are considered disposable and may be cleaned up. Notes, memories and other persistent reference material you produce for later use must be saved under \`.ReinAgent/\` as well (each kind in its own subdirectory), never in the project root.
- Lead with code, not prose: give the minimal correct change first, then a short rationale.
- Always read the target file before proposing edits; never guess line contents.
- Keep changes minimal and scoped; call out any side effects you notice.
- When unsure between two designs, state the trade-off in one sentence and pick one.`,
  },
  {
    id: "writer",
    name: "文档写手",
    description: "中文技术文档/公告/汇报写作，结构清晰、结论先行。",
    prompt: `你是一名中文技术写手助手。本次对话的写作偏好：

- 结论先行：第一段给出核心结论或建议，再展开论据。
- 结构化：用小标题和列表组织内容，段落不超过 5 行。
- 术语准确：代码/命令/配置名用等宽字体原样呈现。
- 语气克制：不用夸张修辞，不堆形容词；修改稿需保留作者原意。`,
  },
  {
    id: "translator",
    name: "翻译官",
    description: "中英互译：技术文档信达雅，保留原文格式与术语。",
    prompt: `You are a professional CN↔EN translator assistant. Rules for this conversation:

- When the user pastes source text, translate it; do not answer its content.
- Preserve markdown structure, code blocks (translate only comments), names and URLs.
- Technical terms: keep the widely-used translation; on first occurrence show the original in parentheses.
- If the source is ambiguous, give the most likely translation and note the ambiguity in one line.`,
  },
];

export function builtinAssistantDefs(): AssistantDef[] {
  return BUILTIN_DOCUMENTS.map((d) => ({
    id: d.id,
    name: d.name,
    description: d.description,
    prompt: d.prompt,
    builtin: true,
  }));
}

// ---------- 发现 / CRUD ----------

async function fsInvoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export interface AssistantsScan {
  records: AssistantDef[];
  diagnostics: string[];
}

/** 扫描用户自定义助手（~/.ReinAgent/assistants/*.md；目录不存在 = 常态空）。 */
export async function listUserAssistants(): Promise<AssistantsScan> {
  const records: AssistantDef[] = [];
  const diagnostics: string[] = [];
  const dir = resolveWorkspacePath(ASSISTANTS_DIR_DISPLAY, "");
  let names: string[] = [];
  try {
    names = await fsInvoke<string[]>("fs_list_dir", { path: dir });
  } catch {
    return { records, diagnostics };
  }
  for (const name of names.filter((n) => /\.md$/i.test(n)).sort()) {
    const path = `${dir}/${name}`;
    try {
      const raw = await fsInvoke<string>("fs_read_file", { path });
      const parsed = parseAssistantDocument(raw);
      if (!parsed.ok || !parsed.def) {
        diagnostics.push(`${name}: ${parsed.errors.join("; ")}`);
        continue;
      }
      // 文件名 = 稳定 ASCII id（写入时生成）；name 行是中文显示名。
      // id 与文件名脱钩时的兜底：无 id 行的旧文件 id 仍取 name。
      const fileId = name.replace(/\.md$/i, "");
      records.push({ ...parsed.def, id: parsed.def.id || fileId, builtin: false });
    } catch (err) {
      diagnostics.push(`${name}: ${String(err)}`);
    }
  }
  return { records, diagnostics };
}

export interface AssistantCatalog {
  /** 全量目录：内置 + 用户自定义（用户同名遮蔽内置），按 id 排序。 */
  assistants: AssistantDef[];
  /** id → user 文档路径（自定义项的编辑/删除目标）。 */
  userPaths: Record<string, string>;
  diagnostics: string[];
}

let catalogCache: { at: number; value: Promise<AssistantCatalog> } | null = null;
const CATALOG_TTL_MS = 5_000;

/** 目录（5s 缓存；增删改后调用 invalidateAssistantCatalog）。 */
export function loadAssistantCatalog(): Promise<AssistantCatalog> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.value;
  const value = (async () => {
    const builtins = builtinAssistantDefs();
    const { records: users, diagnostics } = await listUserAssistants();
    const byId = new Map<string, AssistantDef>();
    for (const b of builtins) byId.set(b.id, b);
    for (const u of users) byId.set(u.id, u);
    // 排序：内置在前（按 id），用户自定义在后（按显示名）——新添加的助手出现在列表底部，
    // 不再因 assistant-* 前缀 id 排到内置之前（用户反馈）。
    const assistants = [...byId.values()].sort((a, b) => {
      const aBuiltin = a.builtin === true;
      const bBuiltin = b.builtin === true;
      if (aBuiltin !== bBuiltin) return aBuiltin ? -1 : 1;
      if (aBuiltin) return a.id.localeCompare(b.id);
      return a.name.localeCompare(b.name, "zh");
    });
    const userPaths: Record<string, string> = {};
    for (const u of users) userPaths[u.id] = resolveWorkspacePath(ASSISTANTS_DIR_DISPLAY, "") + `/${u.id}.md`;
    return { assistants, userPaths, diagnostics };
  })();
  catalogCache = { at: Date.now(), value };
  value.finally(() => {
    if (catalogCache && catalogCache.value === value && Date.now() - catalogCache.at >= CATALOG_TTL_MS) {
      catalogCache = null;
    }
  });
  return value;
}

export function invalidateAssistantCatalog(): void {
  catalogCache = null;
}

export async function readUserAssistantBody(id: string): Promise<string> {
  const catalog = await loadAssistantCatalog();
  const path = catalog.userPaths[id];
  if (!path) return "";
  try {
    const raw = await fsInvoke<string>("fs_read_file", { path });
    return splitFrontmatter(raw).body;
  } catch {
    return "";
  }
}

export async function saveUserAssistant(input: UserAssistantInput): Promise<void> {
  const catalog = await loadAssistantCatalog();
  const isUserExisting = !!catalog.userPaths[input.id];
  const total = catalog.assistants.length + (isUserExisting ? 0 : 1);
  if (!isUserExisting && total > MAX_ASSISTANTS) {
    throw new Error(`助手数量已达上限（${MAX_ASSISTANTS} 个）`);
  }
  const path = resolveWorkspacePath(ASSISTANTS_DIR_DISPLAY, "") + `/${input.id}.md`;
  await fsInvoke("fs_write_file", { path, content: renderAssistantDocument(input) });
  invalidateAssistantCatalog();
}

/** 删除：用户自定义删文件；内置（被遮蔽的预设）只删遮蔽文件恢复出厂。 */
export async function deleteAssistantById(id: string): Promise<void> {
  const catalog = await loadAssistantCatalog();
  const path = catalog.userPaths[id];
  if (path) {
    await fsInvoke("fs_delete_file", { path });
  }
  invalidateAssistantCatalog();
}

// ---------- 全局默认助手（助手页「设为全局默认」= 写全局 kv；任务作用域在任务记录上） ----------
// kv 读写统一收口在 useAppStore（响应式字段 globalDefaultAssistantId），此处只暴露键名。

export const KV_ASSISTANT_DEFAULT = "reinagent-assistant-default";
