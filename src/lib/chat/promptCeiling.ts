/**
 * promptCeiling —— 「经验上限」：Fail-Fast 学到的模型真实 prompt 天花板。
 *
 * 背景（2026-10-05 排查）：deepseek-flash 声明 `contextWindow = 1,048,576`，但实测
 * 一个 23 轮 / 226 步的会话在 **~55 万 prompt tokens** 时即以 `Connection error.`
 * 断连——服务端声明的窗口偏乐观。仅按「声明窗口 × 比例」定压缩水位线会等得太晚。
 *
 * 做法：当某轮「prompt 已达水位线，却仍以连接/上下文类错误失败」时（判据在
 * `conversationController.isContextishError`），把这次失败的 prompt 大小记为本模型
 * 的经验上限。之后 `computeCompactionWatermark` 会把它纳入，水线被压到它的
 * `OBSERVED_CEILING_SAFETY_RATIO`（0.7）以下，从而更早触发压缩。
 *
 * 存储：kv `reinagent-prompt-ceiling:<provider>/<model>`（跨重启保留）。
 * **只收紧不放宽**：保留历次失败中最小的那次，避免一次偶发抖动把水线抬高。
 * 拿不到/读失败一律返回 undefined（No-Fallback：不编造上限）。
 */

import { kvGet, kvSet } from "../storage/db";

const KEY_PREFIX = "reinagent-prompt-ceiling:";

/** 读取某模型的经验 prompt 上限（tokens）；没有/非法 → undefined。 */
export function readPromptCeiling(modelKey: string): number | undefined {
  if (!modelKey || modelKey === "/") return undefined;
  try {
    const raw = kvGet(`${KEY_PREFIX}${modelKey}`);
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch (err) {
    console.warn("[prompt-ceiling] read failed:", err);
    return undefined;
  }
}

/**
 * 记录一次「大 prompt 失败」的大小（tokens）。
 * 只收紧：已存在更小的上限时不动（避免抖动放松）；写入失败仅告警，不影响主流程。
 */
export function recordPromptCeiling(modelKey: string, failedPromptTokens: number): void {
  if (!modelKey || modelKey === "/") return;
  if (!Number.isFinite(failedPromptTokens) || failedPromptTokens <= 0) return;
  try {
    const existing = readPromptCeiling(modelKey);
    if (existing !== undefined && existing <= failedPromptTokens) return;
    kvSet(`${KEY_PREFIX}${modelKey}`, String(Math.round(failedPromptTokens)));
    console.warn(
      `[prompt-ceiling] 记录 ${modelKey} 的经验 prompt 上限 = ${Math.round(failedPromptTokens)} tokens（后续压缩水位线据此下调）`,
    );
  } catch (err) {
    console.warn("[prompt-ceiling] record failed:", err);
  }
}
