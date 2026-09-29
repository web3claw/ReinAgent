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

export const HOOKS_EVENTS = ["PreToolUse", "UserPromptSubmit", "Stop"] as const;
export type HooksEventName = (typeof HOOKS_EVENTS)[number];
/** 运行器支持的全部事件（B② 扩展：PostToolUse/PermissionRequest/SessionStart 不进设置下拉，但可执行）。 */
export type RuntimeHookEventName = HooksEventName | "PostToolUse" | "PermissionRequest" | "SessionStart";

export interface HookConfigEntry {
  event: string;
  matcher?: string;
  command: string;
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

/** 解析 hooks 配置原文（坏 JSON → null；非法条目如实丢弃、合法项保留）。 */
export function parseHooksConfig(raw: string): HookConfigEntry[] | null {
  let entries: HookConfigEntry[] = [];
  try {
    const parsed = JSON.parse(raw) as HooksConfigFile;
    if (!Array.isArray(parsed.hooks)) return [];
    entries = parsed.hooks
      .filter((h) => h && typeof h.command === "string" && h.command.trim() && typeof h.event === "string")
      .map((h) => ({
        event: h.event,
        matcher: typeof h.matcher === "string" ? h.matcher : undefined,
        command: h.command.trim(),
        timeoutMs: typeof h.timeoutMs === "number" ? h.timeoutMs : undefined,
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
    const { getEnabledPluginHooks } = await import("../plugins/pluginRegistry");
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

/** 单条 hook 试运行（设置 UI「测试」按钮；显式用户动作，不看信任态）。 */
export async function runSingleHookForTest(
  entry: HookConfigEntry,
  workspaceRoot: string,
): Promise<HookOutcome> {
  const outcome: HookOutcome = { blocked: false, additionalContexts: [], runs: [] };
  const sampleInput: Omit<HookInput, "event"> =
    entry.event === "PreToolUse"
      ? {
          toolName: entry.matcher || "exec_command",
          payload: { args: { command: "echo hook-test" } },
        }
      : entry.event === "UserPromptSubmit"
        ? { payload: { prompt: "hook 测试提示词" } }
        : { payload: { taskId: "test", outcome: "done" } };
  return runHookEntries([entry], entry.event as HooksEventName, sampleInput, outcome, workspaceRoot);
}

function matcherMatches(matcher: string | undefined, toolName: string): boolean {
  if (!matcher) return true;
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return matcher === toolName;
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

/** 顺序执行 hook 条目（首条 block 短路）；决定写进 outcome。cwd 兜底工作区根（Stop 事件的 input 不带 root）。 */
async function runHookEntries(
  entries: HookConfigEntry[],
  event: RuntimeHookEventName,
  input: Omit<HookInput, "event">,
  outcome: HookOutcome,
  fallbackCwd: string,
): Promise<HookOutcome> {
  for (const entry of entries) {
    const hookInput: HookInput = { event, ...input, workspaceRoot: input.workspaceRoot ?? fallbackCwd };
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{
        exitCode: number | null;
        stdout: string;
        stderr: string;
        timedOut: boolean;
      }>("hook_execute", {
        args: {
          command: entry.command,
          cwd: input.workspaceRoot ?? fallbackCwd,
          stdinJson: JSON.stringify(hookInput),
          timeoutMs: entry.timeoutMs,
        },
      });
      outcome.runs.push({ command: entry.command, exitCode: result.exitCode, timedOut: result.timedOut });

      // 退出码 2 = block（Claude Code 约定，reason 取 stderr/stdout）
      if (result.exitCode === 2) {
        outcome.blocked = true;
        outcome.reason = (result.stderr || result.stdout || "hook blocked").trim().slice(0, 500);
        break;
      }
      const json = extractJsonLoose(result.stdout);
      if (json) {
        const decision = typeof json.decision === "string" ? json.decision : undefined;
        const reason = typeof json.reason === "string" ? json.reason : undefined;
        const context = typeof json.additionalContext === "string" ? json.additionalContext : undefined;
        if (context) outcome.additionalContexts.push(context);
        if (decision === "block") {
          outcome.blocked = true;
          outcome.reason = reason ?? "hook blocked";
          break;
        }
        if (decision === "approve") {
          outcome.approve = true;
        }
      }
    } catch (err) {
      outcome.runs.push({ command: entry.command, exitCode: null, timedOut: false, error: String(err) });
    }
  }
  return outcome;
}
