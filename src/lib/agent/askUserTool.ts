/**
 * askUserTool.ts —— AskUserQuestion 工具（对齐 ZCode handlers/ask-user-question.ts
 * 与 LiveAgent AskUserQuestionCard 的最小可用交集）。
 *
 * 语义：模型向用户提出 1..4 个问题（每题 2~4 个选项，可含推荐项），工具执行**挂起**
 * 等待用户在回合内提问卡上作答；用户提交后工具以结构化回答收敛，模型继续。
 *
 * 挂起机制：复用 pendingApproval 通道（ChatState.pendingApproval）。
 * - 工具 execute 调 approval.request({ toolName, args: { kind: "question", questions } })
 * - UI 识别 kind === "question" 渲染提问卡（而非审批卡）
 * - 用户提交：resolve 值为 **结构化答案对象**（不再是纯字符串枚举——
 *   ApprovalDecision 通道已放宽为 `string | { answers }`，见 conversationPool.resolveApproval）
 * - 用户跳过：resolve "reject"
 *
 * 约束（对齐 ZCode）：1..4 题、每题 2..4 选项、至多一个 recommended、
 * 问题 ≤200 字、选项 ≤100 字、允许自由输入（allowCustom 缺省 true）。
 */

import { Type } from "typebox";

export const ASK_USER_TOOL_NAME = "ask_user_question";

export interface AskUserQuestionOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface AskUserQuestion {
  question: string;
  options: AskUserQuestionOption[];
  allowCustom?: boolean;
}

/** 用户作答（resolve 结构化值） */
export interface AskUserAnswer {
  answers: Array<{ question: string; answer: string }>;
  /** 跳过（未作答） */
  skipped?: boolean;
  /** 超时/自动收敛时为 true */
  autoResolved?: boolean;
}

/** 类型守卫：审批通道 resolve 值是否为结构化回答 */
export function isAskUserAnswer(value: unknown): value is AskUserAnswer {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as AskUserAnswer).answers)
  );
}

export function createAskUserQuestionTool(approval: {
  request: (req: { toolName: string; toolCallId: string; args: unknown }) => Promise<unknown>;
}) {
  return {
    name: ASK_USER_TOOL_NAME,
    label: "向用户提问",
    description:
      "Ask the user 1-4 clarifying questions with 2-4 options each. " +
      "Use ONLY when you are blocked on a decision that is genuinely the user's to make " +
      "(cannot be resolved from the request, the code, or sensible defaults). " +
      "Do not use it for information already available in the request or codebase. " +
      "The user answers via an interactive card; each question may mark at most one option " +
      "as recommended. The tool returns the user's answers verbatim.",
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          question: Type.String({
            description: "The question (max 200 chars)",
            minLength: 1,
            maxLength: 200,
          }),
          options: Type.Array(
            Type.Object({
              label: Type.String({
                description: "Option label (max 100 chars)",
                minLength: 1,
                maxLength: 100,
              }),
              description: Type.Optional(
                Type.String({ description: "Option detail (max 200 chars)" }),
              ),
              recommended: Type.Optional(
                Type.Boolean({
                  description: "Mark this option as recommended (at most one per question)",
                }),
              ),
            }),
            { minItems: 2, maxItems: 4, description: "2-4 options" },
          ),
          allowCustom: Type.Optional(
            Type.Boolean({ description: "Allow free-text answer (default true)" }),
          ),
        }),
        { minItems: 1, maxItems: 4, description: "1-4 questions" },
      ),
    }),
    execute: async (toolCallId: string, params: unknown) => {
      const args = params as { questions?: AskUserQuestion[] };
      const questions = (args?.questions ?? []).slice(0, 4).map((q) => ({
        question: String(q?.question ?? "").slice(0, 200),
        options: (q?.options ?? []).slice(0, 4).map((o) => ({
          label: String(o?.label ?? "").slice(0, 100),
          description: o?.description ? String(o.description).slice(0, 200) : undefined,
          recommended: o?.recommended === true,
        })),
        allowCustom: q?.allowCustom !== false,
      }));
      if (questions.length === 0 || questions.some((q) => q.options.length < 2)) {
        throw new Error(
          "ask_user_question: 每题至少需要 1 个问题与 2 个选项（questions/options 校验失败）",
        );
      }

      // 挂起等待用户在提问卡作答；resolve 值为结构化 AskUserAnswer 或 "reject"
      const decision = await approval.request({
        toolName: ASK_USER_TOOL_NAME,
        toolCallId,
        args: { kind: "question", questions },
      });

      if (decision === "reject") {
        return {
          content: [
            {
              type: "text" as const,
              text: "用户跳过了本次提问，未提供回答。请基于现有信息继续，或在最终回复中说明缺失信息的影响。",
            },
          ],
          details: { skipped: true },
        };
      }

      const answer = isAskUserAnswer(decision) ? decision : null;
      if (!answer || answer.skipped) {
        return {
          content: [
            { type: "text" as const, text: "用户未提供回答。请基于现有信息继续。" },
          ],
          details: { skipped: true },
        };
      }

      const answerText = answer.answers
        .map((a) => `Q: ${a.question}\nA: ${a.answer}`)
        .join("\n");
      return {
        content: [{ type: "text" as const, text: `用户已回答：\n${answerText}` }],
        details: { answers: answer.answers, autoResolved: answer.autoResolved === true },
      };
    },
  };
}

/** 用户作答文本（提问卡提交时构造，测试共用）。 */
export function formatAskUserAnswer(answers: AskUserAnswer["answers"]): string {
  return answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n");
}
