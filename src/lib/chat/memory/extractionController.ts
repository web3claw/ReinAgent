/**
 * extractionController —— 每会话记忆抽取编排（P1-8，LA extractionController 适配）。
 *
 * - 每会话至多一个在飞 run；运行中新请求只保留最新一个排队（coalesce-skip）；
 * - 零成本预门控（gating.extractionSkipReason）：空消息/过短/问候/致谢/30s 节流/
 *   同一用户消息不重抽——不花 LLM；
 * - 短确认词（可能回答记忆确认问题）defer 到引擎里裁决（confirmationDeferralOnly）；
 * - fire-and-forget：绝不阻塞聊天，失败只 console.warn。
 */

import type { ChatMessage } from "../../chat/conversationModel.js";
import {
  extractionSkipReason,
  isConfirmationDeferral,
  type ExtractionSkipReason,
} from "../../memory/extraction/gating.js";
import {
  runMemoryExtraction,
  type ExtractionModelDeps,
  type MemoryExtractionResult,
} from "../../memory/extraction/extractionEngine.js";

export interface MemoryExtractionRequest {
  taskId: string;
  sessionId: string;
  workspaceRoot?: string;
  messages: ChatMessage[];
  model: ExtractionModelDeps;
  reviewerMode?: Parameters<typeof runMemoryExtraction>[0]["reviewerMode"];
  /** 短确认词 defer：引擎里候选裁决后决定 skip 或放行。 */
  confirmationDeferralOnly?: boolean;
  signal?: AbortSignal;
  now?: () => number;
}

interface ConversationExtractionState {
  running: boolean;
  /** 最新排队请求（运行中新请求覆盖旧的）。 */
  queued: MemoryExtractionRequest | null;
  /** 上次完成/认领的运行时间（30s 节流）。 */
  lastRunAt?: number;
  /** 上次已抽取覆盖的用户消息标识。 */
  lastExtractedUserKey?: string;
  inFlight: AbortController | null;
}

const states = new Map<string, ConversationExtractionState>();
const MAX_TRACKED_CONVERSATIONS = 128;

/** 用户消息标识：内容哈希近似即可（长度 + 首尾截片）。 */
function userMessageKey(messages: ChatMessage[]): string | undefined {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return undefined;
  const text = lastUser.text.trim();
  if (!text) return undefined;
  return `${text.length}:${text.slice(0, 64)}:${text.slice(-32)}`;
}

function stateFor(sessionId: string): ConversationExtractionState {
  let state = states.get(sessionId);
  if (!state) {
    state = { running: false, queued: null, inFlight: null };
    states.set(sessionId, state);
    // LRU 上限：超限清最旧（无 in-flight 的）
    if (states.size > MAX_TRACKED_CONVERSATIONS) {
      for (const key of states.keys()) {
        const s = states.get(key);
        if (s && !s.running) {
          states.delete(key);
          break;
        }
      }
    }
  }
  return state;
}

function executeQueued(sessionId: string, request: MemoryExtractionRequest): Promise<MemoryExtractionResult> {
  const state = stateFor(sessionId);
  state.running = true;
  const now = request.now ?? (() => Date.now());
  const controller = new AbortController();
  state.inFlight = controller;
  const messages = request.messages;

  return runMemoryExtraction({
    taskId: request.taskId,
    workspaceRoot: request.workspaceRoot,
    messages,
    model: request.model,
    reviewerMode: request.reviewerMode,
    signal: controller.signal,
    now,
  })
    .then((result) => {
      if (result.ok && !result.skipped) {
        state.lastRunAt = now();
        const key = userMessageKey(messages);
        if (key) state.lastExtractedUserKey = key;
      } else if (result.ok && result.skipped === "throttled-min-interval") {
        state.lastRunAt = now();
      }
      return result;
    })
    .catch((err) => {
      console.warn("[memory-extraction] run failed (non-blocking):", err);
      return { ok: false, errorMessage: String(err) } as MemoryExtractionResult;
    })
    .finally(() => {
      state.running = false;
      state.inFlight = null;
      // 运行期间排了新请求 → 接力执行
      const next = state.queued;
      state.queued = null;
      if (next) {
        void executeQueued(sessionId, next);
      }
    });
}

/**
 * 请求一次抽取（fire-and-forget）。门控不过直接跳过；在飞则 coalesce。
 * 返回跳过原因（仅供调试/遥测；调用方不需要 await）。
 */
export function requestMemoryExtraction(request: MemoryExtractionRequest): ExtractionSkipReason | null {
  const state = stateFor(request.sessionId);
  const latestUser = [...request.messages].reverse().find((m) => m.role === "user");
  const skip = extractionSkipReason({
    latestUserText: latestUser?.text ?? "",
    lastRunAt: state.lastRunAt,
    lastExtractedUserKey: state.lastExtractedUserKey,
    currentUserKey: userMessageKey(request.messages),
    now: request.now?.() ?? undefined,
  });
  if (skip) return skip;
  if (state.running) {
    // coalesce：只保留最新排队请求
    state.queued = request;
    return null;
  }
  const latestUserText = latestUser?.text ?? "";
  const deferralOnly =
    isConfirmationDeferral(null, latestUserText) || undefined;
  void executeQueued(request.sessionId, {
    ...request,
    confirmationDeferralOnly: deferralOnly,
  });
  return null;
}

/** 会话销毁时中止在飞抽取（池 destroyTask 调用）。 */
export function disposeMemoryExtraction(sessionId: string): void {
  const state = states.get(sessionId);
  if (!state) return;
  state.queued = null;
  state.inFlight?.abort(new Error("conversation disposed"));
  states.delete(sessionId);
}

/** 测试隔离。 */
export function __resetMemoryExtractionForTests(): void {
  for (const state of states.values()) state.inFlight?.abort(new Error("reset"));
  states.clear();
}
