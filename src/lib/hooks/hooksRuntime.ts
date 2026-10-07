/**
 * hooksRuntime —— 工作区 Hooks 运行时（P2-G2，对齐 ZCode hooks 契约的可用子集）。
 *
 * 配置：`<workspaceRoot>/.ReinAgent/config.json`
 *   { "hooks": [{ "event": "PreToolUse" | "UserPromptSubmit" | "Stop",
 *                 "matcher"?: "<工具名正则/精确名，仅 PreToolUse>",
 *                 "command": "<shell 命令>", "timeoutMs"?: number }] }
 *
 * 执行：Rust hook_execute（spawn shell、stdin=事件 JSON、限时）。
 * 输出协议（对齐 Claude Code，宽松解析）：stdout JSON
 *   { "decision"?: "block" | "approve", "reason"?: string, "additionalContext"?: string }
 * 或 exit code 2 = block（reason 取 stderr/stdout）。非 JSON stdout 忽略。
 *
 * 信任评审（对齐 ZCode workspace hook trust）：工作区 hook 配置首次发现或变更时
 * 视为「待审」——kv 记录已信任的配置原文摘要；用户批准后才执行。
 */

import { kvGet, kvSet } from "../storage/db";
import { getEnabledPluginHooks, getPluginOptions } from "../plugins/pluginRegistry";

// ---- 事件体系（2026-10-01 对齐 LiveAgent Hooks 页面）----
// 生命周期事件：页面主分组，8 个按对话生命周期顺序排列；观察性（不阻塞主流程）。
export const LIFECYCLE_HOOK_EVENTS = [
  "agent_start",
  "turn_start",
  "message_start",
  "message_end",
  "tool_execution_start",
  "tool_execution_end",
  "turn_end",
  "agent_end",
] as const;
export type LifecycleHookEvent = (typeof LIFECYCLE_HOOK_EVENTS)[number];

// 经典事件：ZCode 契约兼容（旧配置继续生效），UI「兼容事件」分组可见，支持 block 协议。
export const CLASSIC_HOOK_EVENTS = [
  "PreToolUse",
  "UserPromptSubmit",
  "PostToolUse",
  "PermissionRequest",
  "SessionStart",
  "Stop",
] as const;

export type HooksEventName = (typeof CLASSIC_HOOK_EVENTS)[number];
export type RuntimeHookEventName = LifecycleHookEvent | HooksEventName;

export function isLifecycleHookEvent(event: string): event is LifecycleHookEvent {
  return (LIFECYCLE_HOOK_EVENTS as readonly string[]).includes(event);
}

// ---- Hook 类型（LiveAgent HookDef 对齐：command | http）----
export type HookType = "command" | "http";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export function canHttpMethodHaveBody(method: HttpMethod): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH";
}

export interface HookHttpRequestSpec {
  id: string;
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  body?: unknown;
}

/** hook 执行超时缺省值（UI 占位与运行时一致，对齐 LiveAgent 60s） */
export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

export interface HookConfigEntry {
  id?: string;
  event: string;
  name?: string;
  description?: string;
  matcher?: string;
  /** command 类型脚本（沿用旧字段名，旧配置零迁移） */
  command?: string;
  /** http 类型请求列表（按序串行发送） */
  requests?: HookHttpRequestSpec[];
  /** 缺省 command（旧条目无此字段） */
  type?: HookType;
  timeoutMs?: number;
  /** false = 停用（配置可保留，运行时跳过）；缺省启用 */
  enabled?: boolean;
}

export interface HooksConfigFile {
  hooks?: HookConfigEntry[];
}

export interface HookInput {
  event: RuntimeHookEventName;
  /** PreToolUse：工具名（matcher 匹配目标） */
  toolName?: string;
  /** 事件负载（工具参数 / 用户提示词 / 终态信息） */
  payload?: unknown;
  workspaceRoot?: string;
}

export interface HookOutcome {
  blocked: boolean;
  reason?: string;
  approve?: boolean;
  additionalContexts: string[];
  /** 每条 hook 的执行摘要（诊断用） */
  runs: Array<{ command: string; exitCode: number | null; timedOut: boolean; error?: string }>;
  /** 是否存在执行失败的 hook */
  hasError?: boolean;
}

function hooksConfigPath(workspaceRoot: string): string {
  return `${workspaceRoot.replace(/[\\/]+$/, "")}/.ReinAgent/config.json`;
}

function trustKey(workspaceRoot: string): string {
  return `reinagent-hooks-trust:${workspaceRoot}`;
}

/** 信任摘要：配置原文（trim）。原文级比对——任何变更都重新待审。 */
function configFingerprint(raw: string): string {
  return raw.trim();
}

/** 简易 JSON 提取：容忍 hook 在 stdout 里混入非 JSON 行（取第一个 {...} 块）。 */
export function extractJsonLoose(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 解析 hooks 配置原文（坏 JSON → null；非法条目如实丢弃、合法项保留）。
 *  兼容三代形态：旧 {event,command} / 现行 {event,enabled} / 新 {id,name,type,requests}。 */
export function parseHooksConfig(raw: string): HookConfigEntry[] | null {
  let entries: HookConfigEntry[] = [];
  try {
    const parsed = JSON.parse(raw) as HooksConfigFile;
    if (!Array.isArray(parsed.hooks)) return [];
    entries = parsed.hooks
      .filter((h) => {
        if (!h || typeof h.event !== "string") return false;
        const isCommand = typeof h.command === "string" && !!h.command.trim();
        const isHttp = Array.isArray(h.requests) && h.requests.length > 0;
        return isCommand || isHttp;
      })
      .map((h) => ({
        ...(typeof h.id === "string" ? { id: h.id } : {}),
        event: h.event,
        ...(typeof h.name === "string" ? { name: h.name } : {}),
        ...(typeof h.description === "string" ? { description: h.description } : {}),
        ...(typeof h.matcher === "string" ? { matcher: h.matcher } : {}),
        ...(typeof h.command === "string" ? { command: h.command.trim() } : {}),
        ...(Array.isArray(h.requests) ? { requests: h.requests } : {}),
        ...(h.type === "http" || h.type === "command" ? { type: h.type } : {}),
        ...(typeof h.timeoutMs === "number" ? { timeoutMs: h.timeoutMs } : {}),
        ...(typeof h.enabled === "boolean" ? { enabled: h.enabled } : {}),
      }));
    return entries;
  } catch {
    return null; // config.json 坏 JSON：不当 hooks 配置（诚实忽略，不猜测）
  }
}

export interface DiscoveredHooks {
  raw: string;
  entries: HookConfigEntry[];
  /** 与 kv 中已信任摘要一致 */
  trusted: boolean;
}

/** 发现工作区 hooks 配置（文件不存在/解析失败 → null；配置坏行如实丢弃并保留合法项）。 */
export async function discoverWorkspaceHooks(workspaceRoot: string): Promise<DiscoveredHooks | null> {
  if (!workspaceRoot) return null;
  let raw: string;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    raw = await invoke<string>("fs_read_file", { path: hooksConfigPath(workspaceRoot) });
  } catch {
    return null; // 文件不存在 / 无 Tauri（Web 模式）：无 hooks，正常形态
  }
  const entries = parseHooksConfig(raw);
  if (entries === null) return null;
  const trusted = kvGet(trustKey(workspaceRoot)) === configFingerprint(raw);
  return { raw, entries, trusted };
}

/**
 * 插件贡献 hooks 合并（P2-G2 插件系统）：启用插件的 hooks 追加到工作区配置之后。
 * 插件安装是显式用户动作，视为已信任来源（不走工作区信任横幅）。
 * 插件清单读取失败 → 空数组（注册表内部已 warn，不阻断工作区 hooks）。
 */
export async function discoverPluginHooks(): Promise<HookConfigEntry[]> {
  try {
    { /* getEnabledPluginHooks 静态引入 */ }
    return await getEnabledPluginHooks();
  } catch (err) {
    console.warn("[hooks] plugin hooks discovery failed:", err);
    return [];
  }
}

/** 批准当前工作区 hooks 配置（横幅「批准」按钮）。 */
export function trustWorkspaceHooks(workspaceRoot: string, raw: string): void {
  kvSet(trustKey(workspaceRoot), configFingerprint(raw));
}

/** 撤销信任（横幅「拒绝」按钮 / 设置清除）。 */
export function untrustWorkspaceHooks(workspaceRoot: string): void {
  kvSet(trustKey(workspaceRoot), "");
}

/** 把条目数组写回工作区 hooks 配置（保留 config.json 里其它顶层键；信任态不因保存改变）。 */
export async function saveWorkspaceHooks(
  workspaceRoot: string,
  entries: HookConfigEntry[],
): Promise<void> {
  const path = hooksConfigPath(workspaceRoot);
  let config: Record<string, unknown> = {};
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    config = JSON.parse(await invoke<string>("fs_read_file", { path })) as Record<string, unknown>;
  } catch {
    // 无既有配置（或读取失败）：以全新 config 写入
  }
  config.hooks = entries;
  const { invoke: invokeWrite } = await import("@tauri-apps/api/core");
  await invokeWrite("fs_write_file", { path, content: JSON.stringify(config, null, 2) });
}

function matcherMatches(matcher: string | undefined, toolName: string): boolean {
  if (!matcher) return true;
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return matcher === toolName;
  }
}

/** 单条 hook 的执行结果（blocked 仅经典事件协议生效）。 */
interface SingleHookResult {
  blocked: boolean;
  reason?: string;
  approve?: boolean;
  context?: string;
  error?: string;
  summary: HookOutcome["runs"][number];
}

/** 执行单条 hook：按 type 分发 command（spawn shell）/ http（Rust ureq，走全局代理）。 */
async function executeSingleHook(
  entry: HookConfigEntry,
  hookInput: HookInput,
  cwd: string,
): Promise<SingleHookResult> {
  const timeoutMs = entry.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const isHttp = entry.type === "http" || (!entry.command && !!entry.requests?.length);
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    if (isHttp) {
      const requests = entry.requests ?? [];
      for (const req of requests) {
        const result = await invoke<{
          status: number | null;
          ok: boolean;
          bodySnippet: string;
          timedOut: boolean;
          error?: string;
        }>("hook_http_execute", {
          args: {
            request: { url: req.url, method: req.method, headers: req.headers, body: req.body },
            timeoutMs,
          },
        });
        const label = `http ${req.method} ${req.url}`;
        if (result.error) {
          return { blocked: false, error: result.error, summary: { command: label, exitCode: null, timedOut: result.timedOut, error: result.error } };
        }
        if (!result.ok) {
          const reason = `HTTP ${result.status ?? "?"}: ${result.bodySnippet.slice(0, 200)}`;
          return { blocked: false, error: reason, summary: { command: label, exitCode: result.status ?? null, timedOut: result.timedOut } };
        }
      }
      return { blocked: false, summary: { command: `http ×${requests.length}`, exitCode: 0, timedOut: false } };
    }

    const result = await invoke<{
      exitCode: number | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
    }>("hook_execute", {
      args: {
        command: entry.command ?? "",
        cwd,
        stdinJson: JSON.stringify(hookInput),
        timeoutMs,
      },
    });
    const summary = { command: entry.command ?? "", exitCode: result.exitCode, timedOut: result.timedOut };
    // 退出码 2 = block（Claude Code 约定，reason 取 stderr/stdout）
    if (result.exitCode === 2) {
      return { blocked: true, reason: (result.stderr || result.stdout || "hook blocked").trim().slice(0, 500), summary };
    }
    const json = extractJsonLoose(result.stdout);
    if (json) {
      const decision = typeof json.decision === "string" ? json.decision : undefined;
      const reason = typeof json.reason === "string" ? json.reason : undefined;
      const context = typeof json.additionalContext === "string" ? json.additionalContext : undefined;
      if (decision === "block") {
        return { blocked: true, reason: reason ?? "hook blocked", summary };
      }
      if (decision === "approve") {
        return { blocked: false, approve: true, context, summary };
      }
      return { blocked: false, context, summary };
    }
    return { blocked: false, summary };
  } catch (err) {
    return {
      blocked: false,
      error: String(err),
      summary: { command: entry.command ?? entry.requests?.[0]?.url ?? "(hook)", exitCode: null, timedOut: false, error: String(err) },
    };
  }
}

/** 发现缓存（5s TTL）：full 模式下每个工具调用都会过 PreToolUse，避免每次读盘。 */
const discoveryCache = new Map<string, { at: number; value: Promise<DiscoveredHooks | null> }>();
const DISCOVERY_CACHE_TTL_MS = 5_000;

function discoverCached(workspaceRoot: string): Promise<DiscoveredHooks | null> {
  const cached = discoveryCache.get(workspaceRoot);
  if (cached && Date.now() - cached.at < DISCOVERY_CACHE_TTL_MS) return cached.value;
  const value = discoverWorkspaceHooks(workspaceRoot);
  discoveryCache.set(workspaceRoot, { at: Date.now(), value });
  value.finally(() => {
    const entry = discoveryCache.get(workspaceRoot);
    // 只清掉自己的过期项（banner 路径的实时发现不受影响——它绕过本缓存）
    if (entry && entry.value === value && Date.now() - entry.at >= DISCOVERY_CACHE_TTL_MS) {
      discoveryCache.delete(workspaceRoot);
    }
  });
  return value;
}

/** 执行某事件的全部已信任 hooks（顺序、单条超时各自生效；首条 block 即短路）。 */
export async function runWorkspaceHooks(
  event: RuntimeHookEventName,
  input: Omit<HookInput, "event">,
  workspaceRoot: string,
): Promise<HookOutcome> {
  const outcome: HookOutcome = { blocked: false, additionalContexts: [], runs: [] };
  const discovered = await discoverCached(workspaceRoot);
  if (!discovered || !discovered.trusted || discovered.entries.length === 0) {
    // 工作区 hooks 缺失/未信任时，插件 hooks 仍要跑（独立信任来源）
    const pluginEntries = await discoverPluginHooks();
    return runHookEntries(pluginEntries.filter((h) => h.event === event), event, input, outcome, workspaceRoot);
  }
  const entries = discovered.entries.filter(
    (h) =>
      h.event === event &&
      h.enabled !== false &&
      (event !== "PreToolUse" || matcherMatches(h.matcher, String(input.toolName ?? ""))),
  );
  const pluginEntries = (await discoverPluginHooks()).filter(
    (h) =>
      h.event === event &&
      h.enabled !== false &&
      (event !== "PreToolUse" || matcherMatches(h.matcher, String(input.toolName ?? ""))),
  );
  return runHookEntries([...entries, ...pluginEntries], event, input, outcome, workspaceRoot);
}

/** 顺序执行 hook 条目；经典事件首条 block 即短路（ZCode 契约），
 *  生命周期事件观察性执行（block 决策忽略，不阻断主流程）。cwd 兜底工作区根。 */
async function runHookEntries(
  entries: HookConfigEntry[],
  event: RuntimeHookEventName,
  input: Omit<HookInput, "event">,
  outcome: HookOutcome,
  fallbackCwd: string,
): Promise<HookOutcome> {
  const observational = isLifecycleHookEvent(event);
  for (const entry of entries) {
    const hookInput: HookInput = { event, ...input, workspaceRoot: input.workspaceRoot ?? fallbackCwd };
    // 插件来源的 hook：注入该插件 userConfig 已存值（stdin payload.pluginOptions）
    let pluginOptions: Record<string, unknown> | undefined;
    const pluginName = (entry as { pluginName?: unknown }).pluginName;
    if (typeof pluginName === "string") {
      try {
        { /* getPluginOptions 静态引入 */ }
        pluginOptions = getPluginOptions(pluginName, null);
      } catch {
        pluginOptions = undefined;
      }
    }
    const payloadInput = pluginOptions ? { ...hookInput, pluginOptions } : hookInput;
    const result = await executeSingleHook(entry, payloadInput, input.workspaceRoot ?? fallbackCwd);
    outcome.runs.push(result.summary);
    if (result.context) outcome.additionalContexts.push(result.context);
    if (result.error) {
      outcome.hasError = true;
      if (observational) {
        // 生命周期 hook 失败不阻断，但留下诊断痕迹（不静默吞）
        console.warn(`[hooks] lifecycle ${event} hook failed:`, result.error);
      } else {
        // 经典 hook（PreToolUse 等）执行异常：输出 warning 并在 outcome 记录，避免隐蔽失败
        console.warn(`[hooks] classic ${event} hook execution error:`, result.error);
      }
    }
    if (!observational) {
      if (result.blocked) {
        outcome.blocked = true;
        outcome.reason = result.reason ?? "hook blocked";
        break;
      }
      if (result.approve) outcome.approve = true;
    }
  }
  return outcome;
}

/**
 * 生命周期事件入口：fire-and-forget（不 await，不阻塞 agent 主流程）。
 * 工作区未信任时与经典事件同规则（不执行工作区条目，插件条目照常）。
 */
export function fireLifecycleHook(
  event: LifecycleHookEvent,
  input: Omit<HookInput, "event">,
  workspaceRoot: string,
): void {
  void runWorkspaceHooks(event, input, workspaceRoot).catch((err) => {
    console.warn(`[hooks] lifecycle ${event} dispatch failed:`, err);
  });
}
