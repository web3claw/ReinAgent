/**
 * exitPlanModeTool.ts —— ExitPlanMode 工具（P2 尾巴 #8，对齐 ZCode contracts/tools/plan-mode.ts
 * 的 ExitPlanMode：仅计划模式可用；提交实施计划挂起等待用户批准）。
 *
 * 语义：调研完成后模型调用本工具提交完整计划 → 复用 pendingApproval 通道挂起
 * （args.kind === "plan"，UI 渲染 PlanModeCard 而非审批卡）→
 * - 用户批准：resolve { approved: true }（UI 侧同时把任务 approvalMode 切出 plan），
 *   工具返回成功提示，模型立即开始实施；
 * - 用户拒绝（可带反馈）：resolve { approved: false, feedback? }，工具返回拒绝原因，
 *   模型调整计划/继续调研（仍在计划模式，写工具依旧被拦截）。
 *
 * 模式门在 createApprovalGate：非 plan 模式直接 block（对齐 ZCode mode.plan.exitOnly）。
 * 上限：plan ≤ 20000 字符（对齐 ZCode PLAN_MODE_MAX_PLAN_CHARS）。
 */

import { Type } from "typebox";

export const EXIT_PLAN_MODE_TOOL_NAME = "exit_plan_mode";

export const PLAN_MODE_MAX_PLAN_CHARS = 20_000;

/** 允许的提示式权限（对齐 ZCode ExitPlanModeAllowedPrompt：暂只收 Bash 类） */
export interface PlanAllowedPrompt {
  tool: "Bash";
  prompt: string;
}

/** 用户决定（resolve 结构化值） */
export interface PlanApprovalDecision {
  approved: boolean;
  /** 拒绝时的调整反馈（自由文本） */
  feedback?: string;
}

/** 类型守卫：审批通道 resolve 值是否为计划批准结构 */
export function isPlanApprovalDecision(value: unknown): value is PlanApprovalDecision {
  return typeof value === "object" && value !== null && typeof (value as PlanApprovalDecision).approved === "boolean";
}

export function createExitPlanModeTool(approval: {
  request: (req: { toolName: string; toolCallId: string; args: unknown }) => Promise<unknown>;
}) {
  return {
    name: EXIT_PLAN_MODE_TOOL_NAME,
    label: "提交实施计划",
    description:
      "Submit your implementation plan for user approval (PLAN MODE ONLY, must be in plan mode). " +
      "Call this when your read-only investigation is complete: provide the complete plan as markdown " +
      "(files to change, exact edits per file, execution steps, verification). " +
      "The user approves (you may then implement immediately) or rejects with feedback (adjust and resubmit).",
    parameters: Type.Object({
      plan: Type.String({
        description: "The implementation plan to present to the user for approval (markdown).",
        minLength: 1,
        maxLength: PLAN_MODE_MAX_PLAN_CHARS,
      }),
      allowedPrompts: Type.Optional(
        Type.Array(
          Type.Object({
            tool: Type.Union([Type.Literal("Bash")], {
              description: "The tool this prompt applies to",
            }),
            prompt: Type.String({
              description: 'Semantic description of the action, e.g. "run tests", "install dependencies"',
            }),
          }),
          {
            description:
              "Prompt-based permissions needed to implement the plan. These describe categories of actions rather than specific commands.",
          },
        ),
      ),
    }),
    execute: async (toolCallId: string, params: unknown) => {
      const args = params as { plan?: string; allowedPrompts?: PlanAllowedPrompt[] };
      const plan = String(args?.plan ?? "").trim();
      if (!plan) {
        throw new Error("exit_plan_mode: plan 不能为空（trim 后至少 1 个字符）");
      }
      const truncated = plan.length > PLAN_MODE_MAX_PLAN_CHARS
        ? plan.slice(0, PLAN_MODE_MAX_PLAN_CHARS)
        : plan;
      const allowedPrompts = (args?.allowedPrompts ?? [])
        .map((p) => ({ tool: "Bash" as const, prompt: String(p?.prompt ?? "").slice(0, 200) }))
        .filter((p) => p.prompt.length > 0)
        .slice(0, 10);

      const decision = await approval.request({
        toolName: EXIT_PLAN_MODE_TOOL_NAME,
        toolCallId,
        args: { kind: "plan", plan: truncated, allowedPrompts },
      });

      if (decision === "reject") {
        return {
          content: [
            {
              type: "text" as const,
              text: "用户拒绝了该计划（未提供反馈）。请继续只读调研补全信息，或调整计划后重新调用本工具提交。仍处于计划模式：写入与执行命令依旧被拦截。",
            },
          ],
          details: { approved: false },
        };
      }

      const d = isPlanApprovalDecision(decision) ? decision : null;
      if (!d || !d.approved) {
        const feedback = d?.feedback ? `调整反馈：${d.feedback}` : "未提供反馈";
        return {
          content: [
            {
              type: "text" as const,
              text: `用户拒绝了该计划。${feedback}\n请据此调整计划后重新调用本工具提交，或继续只读调研。仍处于计划模式：写入与执行命令依旧被拦截。`,
            },
          ],
          details: { approved: false, feedback: d?.feedback },
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: "用户已批准该计划，任务已切换到执行模式。请按计划立即开始实施（可使用写入与执行工具），并在完成前用 todo_write 跟踪进度。",
          },
        ],
        details: { approved: true },
      };
    },
  };
}
