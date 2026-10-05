/**
 * subagentDefinitions —— 子智能体定义层（对齐 PI-Desktop ADR 0062 的存储与发现模型）。
 * ============================================================================
 * - 用户定义：`~/.agents/subagents/<id>.md`（frontmatter：name/description/tools/
 *   model?/thinkingLevel?/maxTokens? + 正文 = 子代理完整系统提示词）。
 * - 启用状态**绝不写入文档**（与 PI 相同，文档保持可移植）：内置停用列表存
 *   kv `reinagent-subagent-builtins-disabled`（handle 数组），用户定义启停存
 *   kv `reinagent-subagent-enabled`（Record<id, boolean>，缺省启用）。
 * - 发现顺序：用户定义 > 同名内置（遮蔽）；内置来自本模块常量（坏常量如实进
 *   diagnostics，不中断）。
 * - 工具名使用本仓注册表名（read_file/glob/grep/exec_command/edit_file/write_file…）。
 */

import { kvGetJSON, kvSetJSON } from "../storage/db";
import { resolveWorkspacePath } from "../agent/workspace";
import { loadProvidersConfigFromDisk } from "../../components/settings/model-provider/types";

export const SUBAGENTS_DIR_DISPLAY = "~/.agents/subagents";
export const MAX_USER_SUBAGENTS = 64;
export const MAX_SUBAGENT_BYTES = 32 * 1024;

/** 未声明工具时的默认白名单（对齐 PI DEFAULT_SUBAGENT_TOOLS）。 */
export const DEFAULT_SUBAGENT_TOOLS = ["read_file", "glob", "grep"];

/** 编辑器可勾选的工具全集（本仓注册表名）。 */
export const SUBAGENT_ASSIGNABLE_TOOLS = [
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "exec_command",
  "write_file",
  "edit_file",
] as const;

/** 可改动文件/执行命令的工具（编辑器「会改动文件」提示用）。 */
export const SUBAGENT_MUTATING_TOOLS = ["exec_command", "write_file", "edit_file"];

export type SubagentSource = "builtin" | "user";

export interface SubagentDefinition {
  name: string;
  description: string;
  /** 工具白名单；空数组运行时回落 DEFAULT_SUBAGENT_TOOLS。 */
  tools: string[];
  /** 模型钉选 "provider/model"；缺省跟随会话模型。 */
  model?: string;
  /** off | low | medium | high | xhigh | max（缺省跟随会话）。 */
  thinkingLevel?: string;
  /** 仅解析存储（pi 文件兼容）；本仓运行时暂不强制，UI 不展示。 */
  maxTokens?: number;
  prompt: string;
  source: SubagentSource;
  filePath?: string;
}

export interface UserSubagentRecord {
  id: string;
  name: string;
  description: string;
  tools: string[];
  model?: string;
  thinkingLevel?: string;
  maxTokens?: number;
  enabled: boolean;
  path: string;
  sizeBytes: number;
  /** 文档正文（子代理系统提示词）；随扫描一并读出，避免目录合成二次读盘。 */
  prompt: string;
}

export interface UserSubagentInput {
  name: string;
  description: string;
  tools: string[];
  model?: string;
  thinkingLevel?: string;
  prompt: string;
}

export function subagentSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return /^[a-z0-9]/.test(slug) ? slug : "";
}

// ---------- frontmatter 解析 / 序列化（宽松对齐 PI parseSubagentDefinition） ----------

function splitFrontmatter(raw: string): { meta: Record<string, string | string[]>; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) return { meta: {}, body: normalized.trim() };
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: normalized.trim() };
  const head = normalized.slice(3, end).trim();
  const body = normalized.slice(end + 4).replace(/^\n+/, "").trim();
  const meta: Record<string, string | string[]> = {};
  let currentKey: string | null = null;
  let listItems: string[] | null = null;
  for (const line of head.split("\n")) {
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && currentKey && listItems) {
      listItems.push(listItem[1].trim());
      continue;
    }
    const pair = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (pair) {
      const key = pair[1].replace(/-[a-z]/g, (c) => c[1].toUpperCase());
      const value = pair[2].trim();
      if (value === "") {
        currentKey = key;
        listItems = [];
        meta[key] = listItems;
        continue;
      }
      currentKey = key;
      listItems = null;
      meta[key] = value;
    }
  }
  return { meta, body };
}

function parseToolsValue(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : value.replace(/^\[|\]$/g, "").split(",");
  return raw
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter((item) => item.length > 0);
}

export interface ParseResult {
  ok: boolean;
  definition?: SubagentDefinition;
  errors: string[];
}

export function parseSubagentDocument(
  raw: string,
  source: SubagentSource,
  filePath?: string,
): ParseResult {
  const errors: string[] = [];
  const { meta, body } = splitFrontmatter(raw);
  const name = typeof meta.name === "string" ? meta.name.trim() : "";
  const description = typeof meta.description === "string" ? meta.description.trim() : "";
  const tools = parseToolsValue(meta.tools).filter((tool) => tool !== "inherit");
  if (!name) errors.push("missing name");
  if (!description) errors.push("missing description");
  if (!body) errors.push("empty prompt body");
  if (new TextEncoder().encode(raw).length > MAX_SUBAGENT_BYTES) errors.push("document too large");
  if (errors.length > 0) return { ok: false, errors };

  const modelRaw = typeof meta.model === "string" ? meta.model.trim() : "";
  const thinkingRaw = typeof meta.thinkingLevel === "string" ? meta.thinkingLevel.trim() : "";
  const maxTokensRaw = Number(
    typeof meta.maxTokens === "string" ? meta.maxTokens : Array.isArray(meta.maxTokens) ? "" : "",
  );
  return {
    ok: true,
    definition: {
      name,
      description,
      tools,
      ...(modelRaw ? { model: modelRaw } : {}),
      ...(thinkingRaw ? { thinkingLevel: thinkingRaw } : {}),
      ...(Number.isSafeInteger(maxTokensRaw) && maxTokensRaw > 0 ? { maxTokens: maxTokensRaw } : {}),
      prompt: body,
      source,
      ...(filePath ? { filePath } : {}),
    },
    errors: [],
  };
}

/** 序列化为 markdown 文档（不含启用状态）。 */
export function renderSubagentDocument(def: {
  name: string;
  description: string;
  tools: string[];
  model?: string;
  thinkingLevel?: string;
  maxTokens?: number;
  prompt: string;
}): string {
  const lines = [
    "---",
    `name: ${def.name}`,
    `description: ${def.description}`,
    `tools: [${def.tools.join(", ")}]`,
  ];
  if (def.model) lines.push(`model: ${def.model}`);
  if (def.thinkingLevel) lines.push(`thinkingLevel: ${def.thinkingLevel}`);
  if (def.maxTokens && def.maxTokens > 0) lines.push(`maxTokens: ${def.maxTokens}`);
  lines.push("---", "", def.prompt.trim(), "");
  return lines.join("\n");
}

// ---------- 内置 5 定义（指令正文照搬 PI-Desktop，工具名映射本仓注册表） ----------

/** PI 原文工具名 → 本仓注册表名；BrowserPreview 本仓没有，ui-designer 如实去掉。 */
const PI_TOOL_TO_LOCAL: Record<string, string> = {
  Read: "read_file",
  Glob: "glob",
  Grep: "grep",
  Bash: "exec_command",
  Edit: "edit_file",
  Write: "write_file",
};

export const BUILTIN_SUBAGENT_DOCUMENTS: readonly string[] = [
  `---
name: explorer
description: Fast codebase search and pattern matching — find files, locate implementations and answer "where is X?" / "how does Y work?". Use when answering needs a sweep over many files and you only want the conclusion. Has Bash — use it when the task needs CLI commands (gh, git, npm, cargo, etc.).
tools: [Read, Glob, Grep, Bash]
---

You are Explorer — a fast codebase navigation specialist.

- Prefer Grep for text/regex patterns (strings, symbols, comments), Glob for
  file discovery by name or extension, Read for specific files.
- Fire several searches in parallel when the answer needs more than one place.
- Follow definitions and call sites; do not stop at the first hit if the
  question implies more than one place.
- Quote the few lines that answer the question and cite \`path:line\` for each.

Report in this shape:

<files>
- src/app.ts:42 — brief description of what's there
</files>
<answer>
Concise answer to the question. If you could not find it, say what you
searched and where the trail went cold — a precise dead end is more useful
than a guess.
</answer>`,
  `---
name: code-reviewer
description: Review specific code or a specific change for defects. Use for a second opinion on correctness, edge cases and missing tests before you commit. Has NO Bash or shell access — cannot run CLI commands (gh, git, npm, etc.). If the task needs shell commands, use explorer or fixer instead.
tools: [Read, Glob, Grep]
---

Review only what the task names, and read enough surrounding code to judge it.

- You have NO shell or terminal access. Do not attempt to run commands.
  If the task requires CLI output (gh, git log, npm, cargo, etc.), report
  that limitation in one sentence and stop — do not pad the report with
  unrelated code reading.

- Prefer defects that change behavior: wrong results, unhandled failures,
  broken invariants, races, resource leaks, missing test coverage.
- Check the code against how its callers and neighbors actually use it, not
  against a style preference.
- Say nothing about formatting, naming or structure unless it causes a defect.

Report: each finding as \`path:line\` plus one sentence on what breaks and under
what input. Order by severity. If the code is sound, say so plainly and name
the cases you checked — an empty review with no evidence is not a review.`,
  `---
name: test-runner
description: Run a specific test or build command and report what failed and why. Use when a command's output is long and only the failures matter.
tools: [Read, Glob, Grep, Bash]
---

Run the command the task names. Do not invent a different one, and do not fix
anything: diagnosis is the deliverable.

- Run the command once. If it fails to start (missing script, wrong directory),
  find the right invocation and say what you changed.
- For each failure, read the failing test and the code under it far enough to
  name the cause.

Report: pass/fail counts, then one entry per failure with the test name, the
assertion or error, and the \`path:line\` you believe is responsible. Keep the
raw output out of the report except for the lines that carry the failure.`,
  `---
name: fixer
description: Implement a complete multi-file change from a spec. Use when a feature or fix spans several files and the work is separable — it can write files inside the workspace while you keep working.
tools: [Read, Glob, Grep, Edit, Write, Bash]
---

You are Fixer — a fast, focused implementation specialist. The main agent
delegates a complete, self-contained spec; implement it. Do not re-plan and do
not research beyond what the task needs.

- Read every file you will change first; never Edit or Write from memory or
  from stale content.
- Keep changes minimal and scoped to the task. Do not touch unrelated code.
- You may write inside the workspace; never write outside it. Prefer the
  workspace-relative paths the main agent gave you.
- Run the relevant validation when it is clearly applicable (test, build or
  lint command the task names); otherwise report it skipped with a reason.
- Do not delegate, do not ask the user, do not search the web. If the spec
  lacks context you truly need, use Grep/Glob/Read yourself.

Report in this shape:

<summary>
2-3 sentences: what was implemented and the outcome.
</summary>
<changes>
- path/file.ts: what changed (function or line level)
</changes>
<verification>
- Tests: [passed / failed / skipped: reason]
- Validation: [passed / failed / skipped: reason]
</verification>`,
  `---
name: ui-designer
description: Design and implement a web interface from a brief — visual system, motion and complete interaction states, checked by running the project's build or browser tooling. Use for building or restyling a UI when the visual work should run in its own context.
tools: [Read, Glob, Grep, Bash, Edit, Write]
---

You are UI designer — a senior UI/UX designer and frontend engineer. The main
agent hands you one interface task with its brief; deliver a working
implementation, not a static mock and not a generic hero, features, pricing
template.

- Read the files you will touch and the project's existing design system
  first. Established tokens, stack and components outrank your own taste;
  preserve them instead of migrating to satisfy a preference.
- When the project has no UI to match, write a small design contract before
  coding: mission, semantic color/typography/spacing/radius/motion tokens on
  a 4px/8px rhythm, and the Do/Don't rules you will hold the result to.
- Build the whole interaction: semantic controls with real actions, visible
  keyboard focus, and the loading, empty, error, success, disabled and
  selected states the flow can reach. Keep grid tracks stable so long
  content reflows without overlap; never hide a layout defect behind
  overflow clipping. No TODOs, pseudo-handlers or invented backend behavior
  — label fixture data as demo data.
- Motion carries state changes, never decorates: immediate hover and press
  feedback, spring-like entrances with a small stagger for lists, and
  reduced-motion variants. Do not use \`transition: all\`, a generic
  \`0.3s ease\`, or constant-speed linear movement for stateful UI, and do
  not add an animation dependency for what one CSS transition covers.
- The brief is your confirmation; there is no user to ask mid-run. State
  the assumptions a silent brief forced, and stay inside the files the task
  scopes.
- Verify before reporting: run the project's build or typecheck when it
  covers your change; use browser or E2E tooling through Bash for visual,
  responsive, keyboard-focus and reduced-motion checks when available;
  otherwise report those checks as skipped instead of implying they were
  performed. Fix what you observe and re-check. A result you did not look at
  is not evidence.

Report in this shape:

<summary>
2-3 sentences: what was built and the design direction taken.
</summary>
<changes>
- path/file.tsx: what changed
</changes>
<verification>
- Browser: [what was opened and checked, issues fixed, issues remaining]
- Build: [passed / failed / skipped: reason]
</verification>`,
];

/** 内置定义解析：工具名 PI → 本仓映射。坏常量 → diagnostics（不中断）。 */
export function builtinSubagentDefinitions(): { definitions: SubagentDefinition[]; diagnostics: string[] } {
  const definitions: SubagentDefinition[] = [];
  const diagnostics: string[] = [];
  for (const raw of BUILTIN_SUBAGENT_DOCUMENTS) {
    const parsed = parseSubagentDocument(raw, "builtin");
    if (!parsed.ok || !parsed.definition) {
      diagnostics.push(`builtin subagent invalid: ${parsed.errors.join("; ")}`);
      continue;
    }
    const def = parsed.definition;
    definitions.push({
      ...def,
      tools: def.tools.map((tool) => PI_TOOL_TO_LOCAL[tool] ?? tool),
    });
  }
  return { definitions, diagnostics };
}

// ---------- 启用状态（kv；文档不含启用态） ----------

const KV_BUILTINS_DISABLED = "reinagent-subagent-builtins-disabled";
const KV_USER_ENABLED = "reinagent-subagent-enabled";

export function getDisabledBuiltins(): string[] {
  const list = kvGetJSON<string[]>(KV_BUILTINS_DISABLED);
  return Array.isArray(list) ? list.filter((h) => typeof h === "string") : [];
}

export function setBuiltinEnabled(handle: string, enabled: boolean): void {
  const disabled = new Set(getDisabledBuiltins());
  if (enabled) disabled.delete(handle);
  else disabled.add(handle);
  kvSetJSON(KV_BUILTINS_DISABLED, [...disabled]);
}

export function getUserEnabledMap(): Record<string, boolean> {
  const map = kvGetJSON<Record<string, boolean>>(KV_USER_ENABLED);
  return map && typeof map === "object" ? map : {};
}

export function setUserSubagentEnabled(id: string, enabled: boolean): void {
  const map = getUserEnabledMap();
  if (enabled) delete map[id];
  else map[id] = false;
  kvSetJSON(KV_USER_ENABLED, map);
}

// ---------- 发现 / CRUD（Tauri fs 命令；目录不存在 = 常态空列表） ----------

function subagentsDir(): string {
  // resolveWorkspacePath 对 ~ 前缀做真实 home 展开（未知 home 会抛真实错误）
  return resolveWorkspacePath(SUBAGENTS_DIR_DISPLAY, "");
}

async function fsInvoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export interface UserSubagentsScan {
  records: UserSubagentRecord[];
  diagnostics: string[];
}

export async function listUserSubagents(): Promise<UserSubagentsScan> {
  const records: UserSubagentRecord[] = [];
  const diagnostics: string[] = [];
  const dir = subagentsDir();
  let names: string[] = [];
  try {
    names = await fsInvoke<string[]>("fs_list_dir", { path: dir });
  } catch {
    return { records, diagnostics }; // 目录不存在 = 常态
  }
  const enabledMap = getUserEnabledMap();
  for (const name of names.filter((n) => /\.md$/i.test(n)).sort()) {
    const path = `${dir}/${name}`;
    try {
      const raw = await fsInvoke<string>("fs_read_file", { path });
      const parsed = parseSubagentDocument(raw, "user", path);
      if (!parsed.ok || !parsed.definition) {
        diagnostics.push(`${name}: ${parsed.errors.join("; ")}`);
        continue;
      }
      const def = parsed.definition;
      records.push({
        id: def.name,
        name: def.name,
        description: def.description,
        tools: def.tools,
        ...(def.model ? { model: def.model } : {}),
        ...(def.thinkingLevel ? { thinkingLevel: def.thinkingLevel } : {}),
        ...(def.maxTokens ? { maxTokens: def.maxTokens } : {}),
        enabled: enabledMap[def.name] !== false,
        path,
        sizeBytes: new TextEncoder().encode(raw).length,
        prompt: def.prompt,
      });
    } catch (err) {
      diagnostics.push(`${name}: ${String(err)}`);
    }
  }
  return { records, diagnostics };
}

/** 读取单个用户定义全文（编辑器回填）。 */
export async function readUserSubagent(
  id: string,
): Promise<{ record: UserSubagentRecord | null; body: string }> {
  const { records } = await listUserSubagents();
  const record = records.find((r) => r.id === id) ?? null;
  if (!record) return { record: null, body: "" };
  return { record, body: record.prompt };
}

export async function writeUserSubagentDocument(id: string, content: string): Promise<string> {
  const dir = subagentsDir();
  const path = `${dir}/${id}.md`;
  await fsInvoke("fs_write_file", { path, content });
  return path;
}

export async function createUserSubagent(input: UserSubagentInput): Promise<void> {
  const { records } = await listUserSubagents();
  if (records.length >= MAX_USER_SUBAGENTS) {
    throw new Error(`子智能体数量已达上限（${MAX_USER_SUBAGENTS} 个）。`);
  }
  if (records.some((r) => r.id === input.name)) {
    throw new Error(`已存在同名子智能体：${input.name}`);
  }
  await writeUserSubagentDocument(input.name, renderSubagentDocument(input));
}

export async function updateUserSubagent(
  oldId: string,
  input: UserSubagentInput,
): Promise<void> {
  const { records } = await listUserSubagents();
  const existing = records.find((r) => r.id === oldId);
  if (!existing) throw new Error(`子智能体不存在：${oldId}`);
  if (input.name !== oldId && records.some((r) => r.id === input.name)) {
    throw new Error(`已存在同名子智能体：${input.name}`);
  }
  await writeUserSubagentDocument(input.name, renderSubagentDocument(input));
  if (input.name !== oldId) {
    // 改名 = 新文件 + 删旧文件；启用状态跟随迁移
    await fsInvoke("fs_delete_file", { path: existing.path });
    const map = getUserEnabledMap();
    if (oldId in map) {
      map[input.name] = map[oldId];
      delete map[oldId];
      kvSetJSON(KV_USER_ENABLED, map);
    }
  }
}

export async function removeUserSubagent(id: string): Promise<void> {
  const { records } = await listUserSubagents();
  const existing = records.find((r) => r.id === id);
  if (!existing) return;
  await fsInvoke("fs_delete_file", { path: existing.path });
}

// ---------- 目录合成（运行时 + 页面共用） ----------

export interface SubagentCatalog {
  /** 生效目录（用户 > 同名内置；停用项已剔除）——agent 工具描述与执行用。 */
  definitions: SubagentDefinition[];
  /** 全部内置（含停用，带 enabled）——设置页内置组。 */
  builtins: Array<SubagentDefinition & { enabled: boolean }>;
  /** 全部用户定义（含停用，带 enabled）。 */
  userRecords: UserSubagentRecord[];
  diagnostics: string[];
}

export async function loadSubagentCatalog(): Promise<SubagentCatalog> {
  const { definitions: builtinsAll, diagnostics: builtinDiag } = builtinSubagentDefinitions();
  const disabled = new Set(getDisabledBuiltins());
  const builtins = builtinsAll.map((def) => ({ ...def, enabled: !disabled.has(def.name) }));
  const { records: userRecords, diagnostics } = await listUserSubagents();

  const userByName = new Map(userRecords.map((r) => [r.name, r]));
  const userDefs: SubagentDefinition[] = userRecords
    .filter((r) => r.enabled)
    .map((r) => ({
      name: r.name,
      description: r.description,
      tools: r.tools,
      ...(r.model ? { model: r.model } : {}),
      ...(r.thinkingLevel ? { thinkingLevel: r.thinkingLevel } : {}),
      ...(r.maxTokens ? { maxTokens: r.maxTokens } : {}),
      prompt: r.prompt,
      source: "user" as const,
      filePath: r.path,
    }));
  const effective = [
    ...userDefs,
    ...builtins.filter((b) => b.enabled && !userByName.has(b.name)),
  ];
  return {
    definitions: effective.filter((d) => d.prompt.length > 0),
    builtins,
    userRecords,
    diagnostics: [...builtinDiag, ...diagnostics],
  };
}

/** 兼容旧工具调用值：Explore → explorer、general-purpose → fixer。 */
export function normalizeSubagentHandle(type: string): string {
  const legacy: Record<string, string> = {
    Explore: "explorer",
    "general-purpose": "fixer",
    explore: "explorer",
  };
  return legacy[type] ?? type;
}

// ---------- 模型钉选解析（"provider/model" → pi-ai 运行时绑定） ----------

export interface ResolvedSubagentModel {
  model: unknown;
  stream: (model: unknown, context: unknown, options?: unknown) => unknown;
  api: string;
  label: string;
  getApiKey: () => string;
}

/**
 * 按定义钉选解析模型。供应商不存在/已删 → null（调用方回落会话模型，LA 语义）；
 * API Key 为空 → 抛真实错误（No-Fallback，不静默换模型）。
 */
export async function resolveSubagentModelPin(pin: string): Promise<ResolvedSubagentModel | null> {
  const slash = pin.indexOf("/");
  const providerId = slash > 0 ? pin.slice(0, slash).trim() : "";
  const modelId = slash > 0 ? pin.slice(slash + 1).trim() : "";
  if (!providerId || !modelId) return null;

  const providers = await loadProvidersConfigFromDisk();
  const provider = providers.find((item) => item.id === providerId);
  if (!provider) return null;
  if (!provider.apiKey.trim()) {
    throw new Error(`子智能体模型供应商 API Key 为空：${provider.name || providerId}`);
  }
  const { API_FORMAT_TO_TYPE } = await import("../memory/modelResolution");
  const { buildModel } = await import("../providers/modelFactory");
  const { getStreamFnForApi } = await import("../providers/runAgentTurn");
  const model = buildModel({
    provider: (API_FORMAT_TO_TYPE[provider.apiFormat] ?? "openai") as never,
    apiKey: provider.apiKey,
    modelId,
    baseUrl: provider.baseUrl,
    apiFormat: provider.apiFormat,
  });
  const stream = await getStreamFnForApi(model.api);
  return {
    model,
    stream: stream as ResolvedSubagentModel["stream"],
    api: model.api,
    label: `${providerId}/${modelId}`,
    getApiKey: () => provider.apiKey,
  };
}
