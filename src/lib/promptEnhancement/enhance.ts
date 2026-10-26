/**
 * 提示词增强执行层（移植自 PI-Desktop agent-runtime/prompt-enhancement.ts +
 * one-shot-complete.ts 的单发补全 + prompt-enhancement-timeout.ts 的 60s 硬上限）。
 *
 * 与 PI 的差异：PI 在 Electron main 用 agent-runtime 跑；本方渲染层本来就直连
 * pi-ai（runAgentTurn 同源），one-shot 补全整体放前端，复用 buildModel +
 * streamSimple 同一传输层。PI 的限流/瞬态重试梯子（runtime 会话层职责）不搬——
 * 一次性增强失败如实报错，60s 超时不换模型重试（避免双倍等待，对齐 PI）。
 */

import { recordUsage } from "../usage/recordUsage";

import type { AssistantMessage, AssistantMessageEvent, Message } from "@earendil-works/pi-ai";
import { buildModel, type ProviderConfig } from "../providers/modelFactory";
import { getStreamFnForApi } from "../providers/runAgentTurn";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
  DEFAULT_PROMPT_ENHANCEMENT_SYSTEM_PROMPT,
  renderPromptEnhancementUserTemplate,
  resolvePromptEnhancementUserTemplate,
  stripEnhancementDecorations,
} from "./templates";

export const PROMPT_ENHANCEMENT_TIMEOUT_MS = 60_000;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PromptEnhancementOptions {
  draft: string;
  /** 一次性补全用的 provider 配置（跟随 composer 或钉住的增强模型）。 */
  config: ProviderConfig;
  thinkingLevel?: ThinkingLevel;
  customTemplate?: boolean;
  userTemplate?: string;
  signal?: AbortSignal;
}

/** 60s 硬上限：abort 是尽力而为，真正释放调用方的是 Promise race。 */
export function withPromptEnhancementTimeout<T>(
  start: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = PROMPT_ENHANCEMENT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const work = start(controller.signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      fn();
    };
    const timer = window.setTimeout(() => {
      controller.abort();
      finish(() =>
        reject(
          Object.assign(new Error(`提示词增强超时（${Math.round(timeoutMs / 1000)} 秒）`), {
            errorCode: "TIMEOUT",
          }),
        ),
      );
    }, timeoutMs);
    work.then(
      (value) => finish(() => resolve(value)),
      (error) => {
        if (controller.signal.aborted) return; // 超时已 rejects
        finish(() => reject(error));
      },
    );
  });
}

/**
 * 单发补全：system + 单条 user 消息，无工具无历史，聚合文本增量返回。
 * 提示词增强与 ✨AI 提交信息（lib/git/commitMessage）共用同一传输通道。
 */
export async function completeOneShotText(
  config: ProviderConfig,
  systemPrompt: string,
  userText: string,
  thinkingLevel: ThinkingLevel,
  signal: AbortSignal,
  usageSource?: import("../usage/recordUsage").DirectUsageSource,
  /** 截断续写轮数上限（⑨ Wiki 长文用：stopReason=length 或围栏未闭合时携带全文续写；缺省 0 = 不续写） */
  maxContinueRounds?: number,
): Promise<string> {
  const model = buildModel(config);
  const stream = await getStreamFnForApi(model.api);
  // getStreamFnForApi 返回三家协议函数的联合（收窄为 never），这里与 runTurn 同样按宽松签名调用
  const streamFn = stream as (
    model: any,
    context: ReturnType<typeof normalizeContext>,
    options?: { apiKey?: string; signal?: AbortSignal; reasoning?: ThinkingLevel },
  ) => AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> };

  /** 单轮调用：返回 (正文, 终止原因)。空正文按原语义抛错。 */
  const callOnce = async (prompt: string): Promise<{ text: string; stopReason: string }> => {
    const message: Message = { role: "user", content: prompt, timestamp: Date.now() } as Message;
    const context = normalizeContext({ systemPrompt, messages: [message] });
    const eventStream = streamFn(model, context, {
      apiKey: config.apiKey,
      signal,
      reasoning: thinkingLevel,
    });
    let text = "";
    let errorMessage: string | null = null;
    for await (const event of eventStream) {
      if (event.type === "text_delta") text += event.delta;
      else if (event.type === "error") {
        if (event.reason === "aborted") throw new Error("增强已中止");
        errorMessage = event.error?.errorMessage ?? "模型请求失败";
        break;
      }
    }
    if (errorMessage) throw new Error(errorMessage);
    const final = await eventStream.result().catch(() => null);
    const stopReason = String(final?.stopReason ?? "");
    if (stopReason === "aborted") throw new Error("增强已中止");
    if (!text.trim() && final) {
      // 兜底：从最终消息的 text 块聚合（某些协议增量事件不含全部文本）
      const blocks = Array.isArray(final.content) ? final.content : [];
      text = blocks
        .filter((b) => (b as { type?: string }).type === "text")
        .map((b) => (b as { text?: string }).text ?? "")
        .join("");
    }
    if (stopReason === "error" && !text.trim()) {
      throw new Error(final?.errorMessage ?? "模型请求失败");
    }
    if (!text.trim()) throw Object.assign(new Error("模型返回了空结果"), { errorCode: "PROMPT_ENHANCEMENT_EMPTY" });
    // 用量记账（⑧）：final.usage 是 pi-ai 真实值，缺 usage（部分网关不回）则不记（no-fallback）
    if (usageSource && final?.usage) {
      const u = final.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
      void recordUsage({
        source: usageSource,
        provider: String(config.provider ?? ""),
        model: String(config.modelId ?? ""),
        inputTokens: u.input ?? 0,
        outputTokens: u.output ?? 0,
        cacheReadTokens: u.cacheRead,
        cacheWriteTokens: u.cacheWrite,
      });
    }
    return { text, stopReason };
  };

  const first = await callOnce(userText);
  let text = first.text;
  // 截断续写（⑨ Wiki）：stopReason=length 或代码围栏未闭合（奇数个 ```）时继续；
  // 续写 prompt 携带全部已有内容，模型从截断处接着输出
  for (let round = 0; round < (maxContinueRounds ?? 0); round++) {
    const fences = (text.match(/```/g) ?? []).length;
    const truncated = first.stopReason === "length" || fences % 2 === 1;
    if (!truncated) break;
    const last = await callOnce(
      `以下是一篇文档已生成的内容，输出在末尾被截断（可能停在句子中途或未闭合的代码块内）。\n请从截断处继续输出剩余内容：不要重复已有内容，不要输出解释或过渡语（例如「好的，继续」），保持原有格式续写下去。\n若停在代码块内，请先补全该代码块（含收尾的 \`\`\`）。\n\n【已有内容】\n${text}`,
    );
    text = `${text}${last.text}`;
  }
  return text;
}

/** 增强草稿：模板渲染 → one-shot 补全 → 清洗（剥包裹引号/前缀标签）。 */
export async function enhancePromptDraft(options: PromptEnhancementOptions): Promise<string> {
  const { draft, config, signal } = options;
  const thinkingLevel = options.thinkingLevel ?? "off";
  const userTemplate = resolvePromptEnhancementUserTemplate({
    customTemplate: options.customTemplate,
    userTemplate: options.userTemplate,
  });
  const userText = renderPromptEnhancementUserTemplate(userTemplate, draft);
  const raw = await withPromptEnhancementTimeout((timeoutSignal) => {
    const merged = signal
      ? AbortSignal.any([timeoutSignal, signal])
      : timeoutSignal;
    return completeOneShotText(config, DEFAULT_PROMPT_ENHANCEMENT_SYSTEM_PROMPT, userText, thinkingLevel, merged, "prompt-enhance");
  });
  const cleaned = stripEnhancementDecorations(raw);
  if (!cleaned.trim()) {
    throw Object.assign(new Error("模型返回了空结果"), { errorCode: "PROMPT_ENHANCEMENT_EMPTY" });
  }
  return cleaned;
}
