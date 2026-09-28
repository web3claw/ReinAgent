/**
 * turnActivity.ts —— 回合工作状态（对齐 ZCode ConversationTurnGroup / 工具卡）纯逻辑层。
 *
 * - groupTurns：把平铺时间线按「用户提问」切轮（user 开轮，至下一条 user 前）；
 * - formatWorkDuration：时长格式化，最多两段非零单位（如「3 分 48 秒」/「3m 48s」）；
 * - resolveTurnWorkState / turnDurationMs：状态条三态（运行中/完成/已停止/无时长）与工时；
 * - computeDiffStat：编辑/写入文件的 +N/－N 行数统计（对齐 ZCode getChangeStat 兜底口径）；
 * - toolKindLabel：工具名 → 类型标签（读取/编辑/终端…），未知工具回退原名（不臆测）。
 *
 * No-Fallback：历史消息无时间打点时如实返回 undefined（UI 显示「已处理」），绝不伪造时长。
 */

import type { TimelineEntry } from "./conversationModel";
import type { LineChangeStat } from "../../preview/shared-src/lineChangeStat.ts";

export { computeLineChangeStat } from "../../preview/shared-src/lineChangeStat.ts";
export type { LineChangeStat };

/** 一轮对话：一条用户提问 + 其后的全部助手/工具活动。 */
export interface TurnGroup {
  /** 稳定 key：锚定用户消息 id（无 user 消息的历史数据用首条活动 id）。 */
  key: string;
  userMessage?: TimelineEntry;
  /** 折叠体内的活动条目（assistant 的思考 / 全部工具调用）。 */
  activity: TimelineEntry[];
  /** 轮内最后一条 assistant（正文外显）。 */
  lastAssistant?: TimelineEntry;
  /** 轮内任一条目仍在流式 / 执行中。 */
  running: boolean;
  startedAt?: number;
  endedAt?: number;
}

/** 按用户提问切轮。平铺数组 → 轮列表；轮内保持原始顺序。 */
export function groupTurns(messages: TimelineEntry[]): TurnGroup[] {
  const turns: TurnGroup[] = [];
  let current: TurnGroup | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      current = {
        key: message.id,
        userMessage: message,
        activity: [],
        lastAssistant: undefined,
        running: false,
      };
      turns.push(current);
      continue;
    }
    if (!current) {
      current = {
        key: message.id,
        userMessage: undefined,
        activity: [],
        lastAssistant: undefined,
        running: false,
      };
      turns.push(current);
    }
    current.activity.push(message);
    if (message.role === "assistant") current.lastAssistant = message;
  }

  for (const turn of turns) {
    turn.running = turn.activity.some(
      (entry) => entry.status === "streaming" || entry.status === "running"
    );
    const starts = turn.activity
      .map((entry) => entry.startedAt)
      .filter((value): value is number => typeof value === "number");
    turn.startedAt = starts.length > 0 ? Math.min(...starts) : undefined;
    if (!turn.running) {
      const ends = turn.activity
        .map((entry) => entry.endedAt)
        .filter((value): value is number => typeof value === "number");
      turn.endedAt = ends.length > 0 ? Math.max(...ends) : undefined;
    }
  }

  return turns;
}

/** 时长格式化：最多保留两段最靠前的非零单位；中文「数字 单位」间留空格。 */
export function formatWorkDuration(ms: number, locale: string = "zh-CN"): string {
  if (!Number.isFinite(ms) || ms <= 0) return locale === "zh-CN" ? "0 秒" : "0s";
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const zh = locale === "zh-CN";
  const segments: Array<[number, string]> = [];
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) segments.push([days, zh ? "天" : "d"]);
  if (hours > 0) segments.push([hours, zh ? "时" : "h"]);
  if (minutes > 0) segments.push([minutes, zh ? "分" : "m"]);
  if (seconds > 0 || segments.length === 0) segments.push([seconds, zh ? "秒" : "s"]);
  return segments
    .slice(0, 2)
    .map(([value, unit]) => (zh ? `${value} ${unit}` : `${value}${unit}`))
    .join(" ");
}

export type TurnWorkState = "running" | "completed" | "stopped" | "no-duration";

/** 状态条三态判定：运行中 / 完成 / 已停止 / 无时长数据（历史消息）。 */
export function resolveTurnWorkState(group: TurnGroup): TurnWorkState {
  if (group.running) return "running";
  if (group.lastAssistant && group.lastAssistant.status === "stopped") return "stopped";
  if (group.startedAt !== undefined && group.endedAt !== undefined) return "completed";
  return "no-duration";
}

/**
 * 是否需要用户立即介入（对齐 LiveAgent `attentionRequired` 语义）：
 * 轮内存在**被阻塞在用户决策上**的工具调用时，状态条强制展开并显示「等待你的决定」。
 *
 * 判据（保守、可解释，全部有真实数据支撑，不臆测）：
 * - `pendingApproval != null`：审批门正挂起等待决策（会话级真相源，最强信号）；
 * - 或轮内存在 running 态的 `ask_user` / `exit_plan_mode` 类工具条目（这些工具
 *   本身即「等用户回答/批准」——运行中就意味着在等人）。
 *
 * @param group 目标轮
 * @param pendingApproval 会话级挂起审批（来自 ChatState.pendingApproval）
 */
export function isAttentionRequired(
  group: TurnGroup,
  pendingApproval?: unknown,
): boolean {
  if (pendingApproval !== null && pendingApproval !== undefined) return true;
  // 等人类工具：运行中即表示在等用户（其名称以工具注册表为准，未知不臆测）
  const ATTENTION_TOOLS = new Set(["ask_user", "AskUserQuestion", "exit_plan_mode", "ExitPlanMode"]);
  return group.activity.some(
    (entry) =>
      entry.role === "tool" &&
      entry.status === "running" &&
      typeof entry.toolName === "string" &&
      ATTENTION_TOOLS.has(entry.toolName),
  );
}

/**
 * 隐藏窗口停表（对齐 LiveAgent 隐藏窗口停表）：把「墙钟区间」折算为「有效工作时长」——
 * 页面不可见（切后台/最小化）期间不计入工时。
 *
 * 纯函数（可测）：给定轮起点、已累计的隐藏时长记录与当前时刻，返回有效工时。
 * 运行中调用方传入 `hiddenSpans`（每段 [hiddenAt, visibleAt]），完成态传入一次隐藏总时长。
 *
 * @param startedAt 轮起点（ms）
 * @param nowMs 当前时刻（运行中）或轮终点（完成）
 * @param hiddenSpans 与 [startedAt, now] 区间相交的隐藏时段（ms 区间，乱序容忍）
 */
export function effectiveWorkMs(
  startedAt: number,
  nowMs: number,
  hiddenSpans: Array<[number, number]>,
): number {
  const wall = Math.max(0, nowMs - startedAt);
  if (hiddenSpans.length === 0) return wall;
  let hidden = 0;
  for (const [from, to] of hiddenSpans) {
    const lo = Math.max(from, startedAt);
    const hi = Math.min(to, nowMs);
    if (hi > lo) hidden += hi - lo;
  }
  return Math.max(0, wall - hidden);
}

/** 回合工时：运行中 = now - startedAt（实时跳动）；完成 = endedAt - startedAt；无打点 = undefined。 */
export function turnDurationMs(group: TurnGroup, nowMs?: number): number | undefined {
  if (group.startedAt === undefined) return undefined;
  if (group.running) return Math.max(0, (typeof nowMs === "number" ? nowMs : Date.now()) - group.startedAt);
  if (group.endedAt !== undefined) return Math.max(0, group.endedAt - group.startedAt);
  return undefined;
}

export interface DiffStat {
  added: number;
  removed: number;
}

export type DiffLineType = "added" | "removed" | "context";

/** diff 视图的一行：type 决定底色与符号；行号由视图层跨增删连续计数（对齐 ZCode 截图样式）。 */
export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/** 单行上限保护：超长文件只 diff 前 maxLines 行，避免 O(n·m) 爆内存。 */
export const DIFF_MAX_LINES = 500;

function splitDiffLines(value: string): string[] {
  if (value.length === 0) return [];
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  // 结尾换行产生的尾部空串是噪声，去掉（中间空行保留）。
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * 行级 LCS diff（零依赖，O(n·m)，输入行数受 DIFF_MAX_LINES 保护）。
 * 输出顺序：上下文 / 删除（旧行）/ 新增（新行），按 diff 语义交错。
 */
export function computeLineDiff(
  oldString: string,
  newString: string,
  maxLines: number = DIFF_MAX_LINES
): DiffLine[] {
  const oldLines = splitDiffLines(oldString).slice(0, maxLines);
  const newLines = splitDiffLines(newString).slice(0, maxLines);
  const n = oldLines.length;
  const m = newLines.length;

  // dp[i][j] = oldLines[i..] 与 newLines[j..] 的最长公共子序列长度
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] =
        oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      result.push({ type: "context", text: oldLines[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: "removed", text: oldLines[i] });
      i += 1;
    } else {
      result.push({ type: "added", text: newLines[j] });
      j += 1;
    }
  }
  while (i < n) {
    result.push({ type: "removed", text: oldLines[i] });
    i += 1;
  }
  while (j < m) {
    result.push({ type: "added", text: newLines[j] });
    j += 1;
  }
  return result;
}

/**
 * 编辑/写入文件的 +N/－N 统计：基于 computeLineDiff 的精确口径（LCS 公共行计为 context，
 * 不再按总行数粗估）。edit_file 用 old_string/new_string；write_file 视为全新增。
 * 其余工具返回 null（不显示统计）。
 */
export function computeDiffStat(toolName: string, args: unknown): DiffStat | null {
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  if (toolName === "edit_file") {
    // 参数名回退：edit_file 工具实际签名为 target/replacement（old_string/new_string 为兼容别名）
    const oldString =
      typeof record.old_string === "string" ? record.old_string
      : typeof record.target === "string" ? record.target : "";
    const newString =
      typeof record.new_string === "string" ? record.new_string
      : typeof record.replacement === "string" ? record.replacement : "";
    if (!oldString && !newString) return null;
    const diff = computeLineDiff(oldString, newString);
    const added = diff.filter((line) => line.type === "added").length;
    const removed = diff.filter((line) => line.type === "removed").length;
    if (added === 0 && removed === 0) return null;
    return { added, removed };
  }
  if (toolName === "write_file") {
    const content = typeof record.content === "string" ? record.content : "";
    if (!content) return null;
    const diff = computeLineDiff("", content);
    return { added: diff.length, removed: 0 };
  }
  return null;
}

/** 提取编辑/写入工具的 diff 视图数据；不可 diff 的工具返回 null。 */
export function computeToolDiffLines(toolName: string, args: unknown): DiffLine[] | null {
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  if (toolName === "edit_file") {
    // 参数名回退：同 computeDiffStat
    const oldString =
      typeof record.old_string === "string" ? record.old_string
      : typeof record.target === "string" ? record.target : "";
    const newString =
      typeof record.new_string === "string" ? record.new_string
      : typeof record.replacement === "string" ? record.replacement : "";
    if (!oldString && !newString) return null;
    return computeLineDiff(oldString, newString);
  }
  if (toolName === "write_file") {
    const content = typeof record.content === "string" ? record.content : "";
    if (!content) return null;
    return computeLineDiff("", content);
  }
  return null;
}

/** 工具名 → 类型标签；未收录的工具如实回退原名，绝不臆测。 */
export function toolKindLabel(toolName: string, locale: string = "zh-CN"): string {
  const zh = locale === "zh-CN";
  const known: Record<string, [string, string]> = {
    read_file: [zh ? "读取" : "Read", "read"],
    list_dir: [zh ? "列出" : "List", "list"],
    write_file: [zh ? "写入" : "Write", "write"],
    edit_file: [zh ? "编辑" : "Edit", "edit"],
    exec_command: [zh ? "终端" : "Terminal", "exec"],
    glob: [zh ? "匹配" : "Glob", "glob"],
    grep: [zh ? "搜索" : "Grep", "grep"],
    delete_file: [zh ? "删除" : "Delete", "delete"],
    todo_write: [zh ? "任务清单" : "Todo", "todo"],
    background_bash: [zh ? "后台命令" : "Background", "exec"],
    task_output: [zh ? "任务输出" : "Task output", "exec"],
    task_stop: [zh ? "停止任务" : "Stop task", "exec"],
    calculate: [zh ? "计算" : "Calculate", "calc"],
  };
  const hit = known[toolName];
  return hit ? hit[0] : toolName;
}

/** 工具类型代号（图标选择用）：read / list / write / edit / exec / calc / generic。 */
export function toolKindCode(toolName: string): string {
  const known: Record<string, string> = {
    read_file: "read",
    list_dir: "list",
    write_file: "write",
    edit_file: "edit",
    exec_command: "exec",
    glob: "glob",
    grep: "grep",
    delete_file: "delete",
    todo_write: "todo",
    background_bash: "exec",
    task_output: "exec",
    task_stop: "exec",
    calculate: "calc",
  };
  return known[toolName] ?? "generic";
}

/** 从工具参数提取文件路径（读取/写入/编辑/查阅共用）。 */
export function toolArgPath(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const path = (args as Record<string, unknown>).path;
  return typeof path === "string" && path.trim().length > 0 ? path : undefined;
}

/** 提取终端命令文本（exec_command）。 */
export function toolArgCommand(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const command = (args as Record<string, unknown>).command;
  return typeof command === "string" && command.trim().length > 0 ? command : undefined;
}

// ---- 查阅族聚合已移除（2026-09-27 用户决策）----
// list_dir / read_file 不再聚合为「查阅」组卡，直接以独立卡渲染
// （对齐 ZCode ReadToolCallBlock 独立形态）。

/** 取路径的目录部分；无目录部分（如 "." 或裸文件名）返回 undefined。 */
export function pathDirectory(path: string): string | undefined {
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx <= 0) return undefined;
  return trimmed.slice(0, idx);
}

/**
 * 判定路径是否位于工作区临时目录 `.ReinAgent/temp/` 下（分隔符无关：正斜杠/反斜杠、
 * 绝对/相对路径均可识别）。命中者不进文件更改摘要卡（一次性脚本无需审查/列出）。
 */
export function isReinAgentTempPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith(".ReinAgent/temp/") || normalized.includes("/.ReinAgent/temp/");
}

/**
 * 由行级 diff 组装 unified patch 文本（PreviewPane patch 模式的输入格式）。
 */
export function buildUnifiedPatch(path: string, oldString: string, newString: string): string {
  const diff = computeLineDiff(oldString, newString);
  const oldTotal = splitDiffLines(oldString).length || 0;
  const newTotal = splitDiffLines(newString).length || 0;
  const body = diff
    .map((line) => (line.type === "added" ? "+" : line.type === "removed" ? "-" : " ") + line.text)
    .join("\n");
  return [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${oldTotal} +1,${newTotal} @@`, body].join("\n");
}

/** 轮内编辑/写入文件的摘要输入（路径 + 前后内容），供摘要卡与 diff 统计消费。 */
export interface TurnFileChangeInput {
  path: string;
  originalContent: string;
  finalContent: string;
}

/** 提取轮内编辑/写入文件的前后内容（edit_file 用 old/new_string，write_file 用 content）。 */
export function collectTurnFileChanges(entries: TimelineEntry[]): TurnFileChangeInput[] {
  const files: TurnFileChangeInput[] = [];
  for (const entry of entries) {
    if (entry.role !== "tool") continue;
    if (entry.toolName !== "edit_file" && entry.toolName !== "write_file") continue;
    // 失败的编辑不进摘要（args 可能是半截/空值，统计无意义）。
    if (entry.isError) continue;
    const args = entry.args as Record<string, unknown> | undefined;
    if (!args) continue;
    const path = typeof args.path === "string" ? args.path : undefined;
    if (!path) continue;
    // 参数名回退：edit_file 实际签名为 target/replacement（old_string/new_string 为兼容别名）
    const originalContent =
      entry.toolName === "edit_file"
        ? typeof args.old_string === "string"
          ? args.old_string
          : typeof args.target === "string"
            ? args.target
            : ""
        : "";
    const finalContent =
      entry.toolName === "edit_file"
        ? typeof args.new_string === "string"
          ? args.new_string
          : typeof args.replacement === "string"
            ? args.replacement
            : ""
        : typeof args.content === "string"
          ? args.content
          : "";
    files.push({ path, originalContent, finalContent });
  }
  return files;
}

/** 轮内压缩标记再导出（TurnGroupView 的渲染判定走 UI 侧 compaction 模块，这里仅类型便利）。 */
export { isCompactEntry } from "./compaction.ts";
