/**
 * extractionEngine —— 聊天后隐藏记忆抽取引擎（P1-8，LA extractionEngine 轻量适配）。
 *
 * 架构对齐 LA：一个隐藏的独立 LLM 回合（用户不可见），system = 抽取提示词、
 * user = 自包含上下文块（指令 → 稳定块 → 易变块，稳定前缀吃 prompt cache），
 * 工具 = 只读 MemoryManager + 强制 SubmitMemoryPlan。提交的计划逐条校验后
 * 折叠成一次 memory_apply_batch 事务落库（extractor 写入标 unreviewed）。
 *
 * 与 LA 的差异：模型调用不走 LA 的 runAssistantWithTools，而是复用我们的
 * runTurn（agentRuntime 嵌套循环，同子代理模式）；候选/拒绝列表经既有
 * memory_list / memory_recent_rejections 命令加载。
 */

import type { ChatMessage } from "../../chat/conversationModel.js";
import { createMemoryManagerTool } from "../memoryManagerTool.js";
import { memoryApplyBatch, memoryList, memoryRecentRejections } from "../api.js";
import type { MemoryReviewerMode } from "../schema.js";
import {
  buildAlreadyWrittenBlock,
  buildConversationSummaryBlock,
  buildExistingCandidatesBlock,
  buildExtractionInstructionPrompt,
  buildRecentRejectionsBlock,
  buildWorkspaceMutationsBlock,
  EXTRACTION_SYSTEM_PROMPT,
} from "../prompts/extraction.js";
import {
  buildConversationWindowBlock,
  deriveWorkspaceMutations,
  extractLatestUserText,
} from "./context.js";
import {
  buildPlanReceiptText,
  createSubmitMemoryPlanTool,
  parsePlanSubmission,
  planToApplyBatchArgs,
  validateSubmittedPlan,
  SUBMIT_MEMORY_PLAN_TOOL_NAME,
} from "./planTool.js";
import { EXTRACTION_TIMEOUT_MS } from "../config.js";

/** 抽取模型注入面（由钩子从当轮 sendOptions 构造——复用主回合的模型凭证）。 */
export interface ExtractionModelDeps {
  model: any;
  stream: (model: any, context: any, options?: any) => any;
  api: string;
  label: string;
  getApiKey: (provider: string) => any;
  thinkingLevel?: string;
}

export interface MemoryExtractionEngineParams {
  taskId: string;
  workspaceRoot?: string;
  /** 本轮对话消息（引擎内部取对话窗口与最近用户文本）。 */
  messages: ChatMessage[];
  model: ExtractionModelDeps;
  reviewerMode?: MemoryReviewerMode;
  conversationSummary?: string;
  alreadyWrittenSlugs?: readonly string[];
  /** 控制器因「短确认词可能回答记忆确认」而放行的运行——候选里没有可确认
   *  项时直接 skip（不花 LLM）。 */
  confirmationDeferralOnly?: boolean;
  signal?: AbortSignal;
  now?: () => number;
}

export interface MemoryExtractionResult {
  ok: boolean;
  skipped?: string;
  aborted?: boolean;
  errorMessage?: string;
  /** 校验通过的条目数（回执给状态行）。 */
  acceptedCount?: number;
  receipt?: string;
}

const EMPTY: Pick<MemoryExtractionResult, "acceptedCount" | "receipt"> = {};

function resolveLocalDate(now: () => number): string {
  const d = new Date(now());
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 包装 signal：在父 signal 之上叠加超时（对齐 LA createTimeoutSignal）。 */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("memory extraction timeout")), timeoutMs);
  const forward = () => controller.abort(new Error("aborted"));
  signal?.addEventListener("abort", forward, { once: true });
  controller.signal.addEventListener("abort", () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  });
  return controller.signal;
}

export async function runMemoryExtraction(
  params: MemoryExtractionEngineParams,
): Promise<MemoryExtractionResult> {
  const now = params.now ?? (() => Date.now());
  const workdir = params.workspaceRoot?.trim() ?? "";
  if (params.signal?.aborted) {
    return { ok: false, aborted: true, ...EMPTY };
  }

  const localDate = resolveLocalDate(now);
  let candidates: { slug: string; memoryType?: string; scope?: string; description?: string; unreviewed?: boolean; confidence?: string; updatedAt?: number }[] = [];
  let rejections: { slug: string; rejectedAt?: number; reason?: string | null }[] = [];
  try {
    const [listResp, rejectResp] = await Promise.all([
      memoryList({ workdir: workdir || undefined, limit: 30 }),
      memoryRecentRejections({ workdir: workdir || undefined, sinceDays: 7 }),
    ]);
    candidates = (listResp.entries ?? []).map((e: any) => ({
      slug: e.slug,
      memoryType: e.memoryType ?? e.type,
      scope: e.scope,
      description: e.description,
      unreviewed: e.unreviewed,
      confidence: e.confidence,
      updatedAt: e.updatedAt,
    }));
    rejections = (rejectResp.entries ?? []).map((e: any) => ({
      slug: e.slug,
      rejectedAt: e.rejectedAt ?? e.rejected_at,
      reason: e.reason ?? null,
    }));
  } catch (err) {
    // 候选/拒绝列表加载失败不放弃抽取——上下文块退化为 (none)，如实继续
    console.warn("[memory-extraction] candidate load failed (continuing with empty blocks):", err);
  }
  if (params.signal?.aborted) {
    return { ok: false, aborted: true, ...EMPTY };
  }

  // 短确认词特例的最终裁决：候选里没有可确认的 unreviewed 非 daily 条目 → 无事可做
  if (params.confirmationDeferralOnly) {
    const hasConfirmable = candidates.some(
      (entry) => entry.unreviewed === true && entry.memoryType !== "daily",
    );
    if (!hasConfirmable) {
      return { ok: true, skipped: "user-message-too-short", ...EMPTY };
    }
  }

  const latestUserText = extractLatestUserText(params.messages as any);
  if (!latestUserText.trim()) {
    return { ok: true, skipped: "empty-user-message", ...EMPTY };
  }

  const workspaceMutations = deriveWorkspaceMutations(params.messages as any, workdir || undefined);
  const summaryBlock = buildConversationSummaryBlock(params.conversationSummary);
  // 块序「稳定 → 易变」：指令打头、对话窗口垫底（前缀缓存字节级匹配，见 LA 注释）
  const hiddenPromptText = [
    buildExtractionInstructionPrompt({
      localDate,
      workdir: workdir || undefined,
      reviewerMode: params.reviewerMode,
    }),
    "",
    ...(summaryBlock ? [summaryBlock] : []),
    buildRecentRejectionsBlock(rejections),
    buildExistingCandidatesBlock(candidates),
    buildAlreadyWrittenBlock(params.alreadyWrittenSlugs ?? []),
    buildWorkspaceMutationsBlock(workspaceMutations),
    buildConversationWindowBlock(params.messages as any),
  ].join("\n\n");

  const planContext = {
    hasWorkdir: Boolean(workdir),
    rejectedSlugs: new Set(rejections.map((entry) => entry.slug)),
    alreadyWrittenSlugs: new Set(params.alreadyWrittenSlugs ?? []),
  };

  // 提交捕获：SubmitMemoryPlan 的 execute 收 args、校验、折叠 batch、生成回执
  let submission: ReturnType<typeof parsePlanSubmission> | null = null;
  const submitTool = createSubmitMemoryPlanTool();
  const submitExecutor = {
    ...submitTool,
    execute: async (_toolCallId: string, args: unknown) => {
      const parsed = parsePlanSubmission(args);
      const result = validateSubmittedPlan(parsed, planContext);
      const applyArgs = planToApplyBatchArgs(result.accepted);
      if (applyArgs.decisions.length > 0) {
        await memoryApplyBatch({
          workdir: workdir || undefined,
          conversationId: params.taskId,
          trigger: "memory-extraction",
          localDate,
          ...applyArgs,
        });
      }
      return {
        content: [{ type: "text" as const, text: buildPlanReceiptText(result) }],
      };
    },
  };

  const readManager = createMemoryManagerTool({
    workdir: workdir || "",
    mode: "ro",
    actor: "extractor",
  });

  const signal = withTimeout(params.signal, EXTRACTION_TIMEOUT_MS);
  const { runTurn } = await import("../../agent/agentRuntime.js");
  try {
    await runTurn({
      model: params.model.model,
      stream: params.model.stream,
      api: params.model.api,
      label: params.model.label,
      getApiKey: params.model.getApiKey,
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: hiddenPromptText, timestamp: now() }],
      tools: [readManager, submitExecutor] as any[],
      signal,
      // LA：主回合最多 5 个抽取回合；不提交 plan 时模型自然继续，超时/步数兜底
      maxSteps: 5,
      thinkingLevel: (params.model.thinkingLevel ?? "off") as any,
      onEvent: () => {},
    });
  } catch (err) {
    if (params.signal?.aborted) {
      return { ok: false, aborted: true, ...EMPTY };
    }
    return { ok: false, errorMessage: String(err), ...EMPTY };
  }

  if (!submission) {
    // 模型没提交计划（LA 会对催一轮；简化为如实放弃——下一轮自然重试）
    return { ok: false, errorMessage: "model never called SubmitMemoryPlan", ...EMPTY };
  }
  const validated = validateSubmittedPlan(submission, planContext);
  return {
    ok: true,
    acceptedCount: validated.accepted.length,
    receipt: buildPlanReceiptText(validated),
  };
}

export { SUBMIT_MEMORY_PLAN_TOOL_NAME };
