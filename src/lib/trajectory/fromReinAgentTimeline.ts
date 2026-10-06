/**
 * fromReinAgentTimeline —— 本仓适配层（非 LA 源码）：把 ReinAgent 的时间线
 * （`TimelineEntry[]`，含落库恢复的条目）映射为 LA 轨迹域的账本与内容索引。
 *
 * 口径（用户定稿 2026-10-06「时间线适配版」）：
 * - 轮 = 用户条目开轮（1-based）；步 = 轮内每条 assistant 条目；工具条目归属其前面的步；
 * - 压缩条目（kind=COMPACT_KIND）→ 独立压缩段（standaloneCompactions），按时间与轮排序；
 * - 时序打点（startedAt/endedAt/thinkingStartedAt）与 apiMessage 用量、重试记录、
 *   思考内容全部进账本；无打点的历史条目如实为空（hasTiming 整体计算，不伪造）；
 * - 不做运行时埋点：无 TTFT 之外的新事实、无 header 分段（一期不产生 system 记录）。
 */

import type { TimelineEntry } from "../chat/conversationModel";
import { isCompactEntry } from "../chat/compaction.ts";
import type { TrajectoryContentIndex } from "./layout";
import { stepKey } from "./layout";
import type {
  LedgerCompaction,
  LedgerInput,
  LedgerRetry,
  LedgerStep,
  LedgerToolCall,
  LedgerTurn,
  TrajectoryLedger,
  TrajectorySourceBlock,
  TrajectoryStatus,
  TrajectoryUsage,
} from "./types";

/** 我们的条目状态 → LA 轨迹状态。 */
function mapStatus(status: string): TrajectoryStatus {
  switch (status) {
    case "streaming":
    case "running":
      return "running";
    case "error":
      return "error";
    case "stopped":
      return "aborted";
    default:
      return "complete";
  }
}

function toUsage(raw: unknown): TrajectoryUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const usage = raw as {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    totalTokens?: unknown;
    reasoningTokens?: unknown;
  };
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const input = num(usage.input);
  const output = num(usage.output);
  const cacheRead = num(usage.cacheRead);
  const cacheWrite = num(usage.cacheWrite);
  const reasoning = num(usage.reasoningTokens);
  const totalTokens = num(usage.totalTokens) ?? (input !== undefined && output !== undefined ? input + output : undefined);
  const result: TrajectoryUsage = {};
  if (totalTokens !== undefined) result.totalTokens = totalTokens;
  if (input !== undefined) result.input = input;
  if (output !== undefined) result.output = output;
  if (cacheRead !== undefined) result.cacheRead = cacheRead;
  if (cacheWrite !== undefined) result.cacheWrite = cacheWrite;
  if (reasoning !== undefined) result.reasoning = reasoning;
  return Object.keys(result).length > 0 ? result : undefined;
}

function safeJson(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export interface TrajectoryTimelineBuild {
  ledger: TrajectoryLedger;
  content: TrajectoryContentIndex;
}

/**
 * 构建账本与内容索引。
 *
 * @param messages 当前任务的时间线（内存态即权威，落库条目水合后同样适用）。
 * @returns 账本（供 deriveTrajectoryLayout）与内容索引（正文补齐）。
 */
export function buildTrajectoryFromTimeline(
  messages: readonly TimelineEntry[],
): TrajectoryTimelineBuild {
  const turns: LedgerTurn[] = [];
  const standaloneCompactions: LedgerCompaction[] = [];
  const userByTurn = new Map<number, { text?: string; blocks?: readonly { type: string; content: string; filePath?: string; fileSource?: "absolute" | "relative" | "file-url" }[] }>();
  const userByMessageId = new Map<string, { text?: string }>();
  const turnByMessageId = new Map<string, number>();
  const turnByMessageIndex = new Map<number, number>();
  const assistantByStep = new Map<
    string,
    { text?: string; thinking?: string; blocks?: TrajectorySourceBlock[] }
  >();
  const toolByCallId = new Map<string, { args?: string; result?: string; isError?: boolean }>();
  let hasTiming = false;

  let currentTurn: LedgerTurn | null = null;
  let currentStep: LedgerStep | null = null;
  let turnNumber = 0;

  const closeTurn = () => {
    if (currentTurn !== null) {
      // 轮终态：任一 error → error；任一 aborted → aborted；任一 running → running；否则 complete
      const items: TrajectoryStatus[] = [
        ...currentTurn.steps.map((step) => step.status),
        ...currentTurn.compactions.map((compaction) => compaction.status),
      ];
      const status: TrajectoryStatus = items.includes("running")
        ? "running"
        : items.includes("error")
          ? "error"
          : items.includes("aborted")
            ? "aborted"
            : "complete";
      const startedAts = [
        ...currentTurn.inputs.map((input) => input.at),
        ...currentTurn.steps.map((step) => step.startedAt),
      ].filter((value): value is number => value !== null);
      const endedAts = currentTurn.steps
        .map((step) => step.endedAt)
        .filter((value): value is number => value !== null);
      currentTurn = {
        ...currentTurn,
        status,
        startedAt: startedAts.length > 0 ? Math.min(...startedAts) : null,
        endedAt: endedAts.length > 0 ? Math.max(...endedAts) : null,
      };
      turns.push(currentTurn);
      currentTurn = null;
      currentStep = null;
    }
  };

  messages.forEach((entry, messageIndex) => {
    if (entry.startedAt !== undefined) hasTiming = true;

    if (isCompactEntry(entry)) {
      const compaction: LedgerCompaction = {
        turn: null,
        startedAt: entry.startedAt ?? null,
        endedAt: entry.endedAt ?? null,
        status: "complete",
      };
      standaloneCompactions.push(compaction);
      currentStep = null;
      return;
    }

    if (entry.role === "user") {
      closeTurn();
      turnNumber += 1;
      // 原始块（对齐 LA userSourceBlocks）：正文 text 块 + 附件块（attachment:<kind>）
      const blocks: TrajectorySourceBlock[] = [];
      if (entry.text) blocks.push({ type: "text", content: entry.text });
      for (const attachment of entry.attachments ?? []) {
        blocks.push({
          type: `attachment:${attachment.kind}`,
          content:
            safeJson({
              fileName: attachment.name,
              path: attachment.path,
              kind: attachment.kind,
            }) ?? attachment.name,
          imageAlt: attachment.name,
          filePath: attachment.path,
          fileSource: "absolute" as const,
        });
      }
      const input: LedgerInput = {
        kind: "user",
        turn: turnNumber,
        at: entry.startedAt ?? null,
        messageId: entry.id,
        messageIndex,
        ...(entry.text ? { text: entry.text } : {}),
      };
      currentTurn = {
        turn: turnNumber,
        startedAt: entry.startedAt ?? null,
        endedAt: null,
        status: "running",
        inputs: [input],
        steps: [],
        compactions: [],
      };
      const userContent = {
        ...(entry.text ? { text: entry.text } : {}),
        ...(blocks.length > 0 ? { blocks } : {}),
      };
      userByTurn.set(turnNumber, userContent);
      userByMessageId.set(entry.id, userContent);
      turnByMessageId.set(entry.id, turnNumber);
      turnByMessageIndex.set(messageIndex, turnNumber);
      return;
    }

    if (entry.role === "assistant") {
      // 游离的 assistant（理论上不可达：时间线以 user 开轮）→ 归入当前轮或丢弃
      if (currentTurn === null) return;
      const usage = toUsage((entry.apiMessage as { usage?: unknown } | undefined)?.usage);
      const retries: LedgerRetry[] = (entry.retryAttempts ?? []).map((attempt) => ({
        attempt: attempt.attempt,
        at: entry.startedAt ?? 0,
        ...(attempt.maxAttempts === undefined ? {} : { maxRetries: attempt.maxAttempts }),
        ...(attempt.plannedDelayMs === undefined ? {} : { delayMs: attempt.plannedDelayMs }),
        ...(attempt.errorMessage ? { error: attempt.errorMessage } : {}),
      }));
      const step: LedgerStep = {
        turn: currentTurn.turn,
        step: currentTurn.steps.length + 1,
        startedAt: entry.startedAt ?? null,
        // 我们的 thinkingStartedAt 语义 = 首个思考 delta（即 LA 的首 token 时刻）；
        // 无思考的消息没有该打点 → null（TTFT 如实缺席，不估算）。
        firstTokenAt: entry.thinkingStartedAt ?? null,
        endedAt: entry.endedAt ?? null,
        status: mapStatus(entry.status),
        ...(entry.error ? { error: entry.error } : {}),
        provider: (entry.apiMessage as { provider?: string } | undefined)?.provider,
        model: (entry.apiMessage as { model?: string } | undefined)?.model,
        api: (entry.apiMessage as { api?: string } | undefined)?.api,
        stopReason: (entry.apiMessage as { stopReason?: string } | undefined)?.stopReason,
        ...(usage === undefined ? {} : { usage }),
        retries,
        failovers: [],
        transports: [],
        tools: [],
      };
      // 原始块（对齐 LA roundSourceBlocks）：thinking/text 块；工具卡在其后追加 tool-call 块
      const assistantBlocks: TrajectorySourceBlock[] = [];
      if (entry.thinking) assistantBlocks.push({ type: "thinking", content: entry.thinking });
      if (entry.text) assistantBlocks.push({ type: "text", content: entry.text });
      assistantByStep.set(stepKey(currentTurn.turn, step.step), {
        ...(entry.text ? { text: entry.text } : {}),
        ...(entry.thinking ? { thinking: entry.thinking } : {}),
        blocks: assistantBlocks,
      });
      currentTurn = { ...currentTurn, steps: [...currentTurn.steps, step] };
      currentStep = currentTurn.steps[currentTurn.steps.length - 1];
      return;
    }

    if (entry.role === "tool") {
      // 工具归属前面的步；无步可归（异常形状）时忽略
      if (currentTurn === null || currentStep === null) return;
      const callId = entry.toolCallId || entry.id;
      const args = safeJson(entry.args);
      const tool: LedgerToolCall = {
        callId,
        name: entry.toolName || "tool",
        ...(args === undefined ? {} : { args }),
        startedAt: entry.startedAt ?? null,
        endedAt: entry.endedAt ?? null,
        status: mapStatus(entry.status),
        isError: entry.isError === true,
        ...(entry.resultText ? { summary: entry.resultText } : {}),
        subagentRunIds: [],
      };
      // 原始块（对齐 LA toolContent）：tool-call 块 + 输出块（优先取 apiMessage 原件 content，
      // 图片块转 data URL；无原件时退回 resultText 文本块）
      const toolBlocks: TrajectorySourceBlock[] =
        args === undefined
          ? []
          : [{ type: "tool-call", content: args, callId, toolName: tool.name }];
      const outputBlocks: TrajectorySourceBlock[] = [];
      const apiContent = (entry.apiMessage as { content?: unknown } | undefined)?.content;
      if (Array.isArray(apiContent)) {
        apiContent.forEach((raw, index) => {
          const block = raw as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
          if (block.type === "text" && typeof block.text === "string") {
            outputBlocks.push({ type: "text", content: block.text });
          } else if (
            block.type === "image" &&
            typeof block.data === "string" &&
            typeof block.mimeType === "string"
          ) {
            outputBlocks.push({
              type: "image",
              content: `[${block.mimeType} image]`,
              imageSrc: `data:${block.mimeType};base64,${block.data}`,
              imageAlt: `${tool.name} output ${index + 1}`,
            });
          }
        });
      }
      if (outputBlocks.length === 0 && entry.resultText) {
        outputBlocks.push({ type: "text", content: entry.resultText });
      }
      toolByCallId.set(callId, {
        ...(args === undefined ? {} : { args }),
        ...(entry.resultText ? { result: entry.resultText } : {}),
        isError: entry.isError === true,
        ...(toolBlocks.length > 0 ? { blocks: toolBlocks } : {}),
        ...(outputBlocks.length > 0 ? { outputBlocks } : {}),
      });
      // 该工具调用同步追加到所属 assistant 步的原始块（LA roundSourceBlocks 含 tool 块）
      const stepContent = assistantByStep.get(stepKey(currentTurn.turn, currentStep.step));
      if (stepContent?.blocks !== undefined && args !== undefined) {
        stepContent.blocks.push({ type: "tool-call", content: args, callId, toolName: tool.name });
      }
      const stepIndex = currentTurn.steps.findIndex(
        (candidate) => candidate.step === currentStep?.step,
      );
      if (stepIndex === -1) return;
      const updated: LedgerStep = {
        ...currentTurn.steps[stepIndex],
        tools: [...currentTurn.steps[stepIndex].tools, tool],
      };
      const steps = currentTurn.steps.slice();
      steps[stepIndex] = updated;
      currentTurn = { ...currentTurn, steps };
      currentStep = updated;
      return;
    }
  });
  closeTurn();

  const turnOrder = turns.map((turn) => turn.turn);
  const content: TrajectoryContentIndex = {
    userByTurn,
    userByMessageId,
    userByMessageIndex: new Map(),
    turnByMessageId,
    turnByMessageIndex,
    turnOrder,
    assistantByStep,
    assistantEntries: [],
    toolByCallId,
    toolEntries: [],
  };

  const ledger: TrajectoryLedger = {
    turns,
    headers: new Map(),
    standaloneCompactions,
    hasTiming,
  };
  return { ledger, content };
}
