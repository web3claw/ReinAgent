/**
 * goalState.ts —— 会话目标（/goal）纯逻辑（ZCode session goal 语义移植 v1）。
 *
 * ZCode 参考：`contracts/src/tools/target.ts`（formatGoalStateForModel / escapeGoalPromptText /
 * GoalObjectiveSchema）、`bootstrap/src/app/session-facade.ts`（/goal stop/pause/resume/clear
 * 子命令与状态变更提醒文本）、`runtime/methods/goal-state-reminder.ts`。
 *
 * v1 范围（用户确认的简化）：目标按任务持久化 + 每轮注入 meta_user（权威状态块）+
 * show/set/replace/pause/resume/clear 子命令。**不做** ZCode 的高级状态机——
 * token 预算/用量与时长统计（本应用未跟踪，绝不捏造数字伪装——缺行不假数据）、
 * 状态变更 model-only 提醒消息（本应用 meta 块每轮重算，新状态下一轮请求自动可见）、
 * goal 自动续跑/蒸腾/验证器（属重量级子系统，另行评估）。
 */

export type GoalStatus = "active" | "paused";

/** 任务级会话目标（存于 AppTask.goal；随任务同步持久化）。 */
export interface TaskGoal {
  objective: string;
  status: GoalStatus;
  updatedAt: number;
}

export type GoalCommand =
  | { action: "show" }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "clear" }
  | { action: "set"; objective: string };

/**
 * 解析 `/goal` 参数（ZCode 用法：`/goal [pause|resume|clear|replace <objective>|<objective>]`）。
 *
 * 适配说明：ZCode 按「首 token 命中子命令」解析；本实现要求 pause/resume/clear 为**整串
 * 精确匹配**（大小写不敏感），因此 `/goal clear the build cache` 会被当作目标文本而非
 * clear 子命令——避免正常目标被误吞；要设定恰好以这些词开头的目标，用 `replace` 显式别名。
 */
export function parseGoalCommand(args: string): GoalCommand {
  const trimmed = (args ?? "").trim();
  if (trimmed.length === 0) return { action: "show" };
  const lower = trimmed.toLowerCase();
  if (lower === "pause") return { action: "pause" };
  if (lower === "resume") return { action: "resume" };
  if (lower === "clear") return { action: "clear" };
  if (lower === "replace") return { action: "set", objective: "" };
  if (lower.startsWith("replace ")) {
    return { action: "set", objective: trimmed.slice("replace ".length).trim() };
  }
  return { action: "set", objective: trimmed };
}

/** 目标文本是用户提供的不可信内容：包装进 <untrusted_objective> 前做转义（ZCode 同款）。 */
export function escapeGoalPromptText(input: string): string {
  return input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * 目标状态 → 模型可见的权威状态块（每轮并入 meta_user；无目标/空目标返回 ""）。
 * 对齐 ZCode formatGoalStateForModel 的结构（Status + <untrusted_objective> 包装），
 * 省略其 token 预算/用量/时长三行（本应用不跟踪这些指标，不捏造）。
 */
export function formatGoalStateForModel(goal: TaskGoal | null | undefined): string {
  if (!goal || goal.objective.trim().length === 0) return "";
  const lines = [
    "# Session goal",
    "Current session goal state (authoritative):",
    `Status: ${goal.status}`,
    "Objective (user-provided):",
    "<untrusted_objective>",
    escapeGoalPromptText(goal.objective),
    "</untrusted_objective>",
  ];
  if (goal.status === "paused") {
    // ZCode goalStateChangeReminderText("paused") 原文语义（本应用随每轮注入而非提醒消息）
    lines.push(
      "The goal is paused. Do not continue pursuing it unless the user resumes or replaces the goal.",
    );
  }
  return lines.join("\n");
}
