/**
 * 独立调用用量记账（⑧ 用量来源维度）：不走会话池的模型调用链
 * （笔记 AI / 记忆整理 / 标题生成 / 知识库 embedding / 提交信息 / 提示词增强）在拿到真实 usage 后落账。
 * no-fallback：响应里没有 usage 就不记（绝不编 0）；记账失败只警告不阻塞主链路。
 */

import { invoke } from "@tauri-apps/api/core";

export type DirectUsageSource =
  | "note-ai"
  | "memory-organizer"
  | "title"
  | "embedding"
  | "commit-message"
  | "prompt-enhance"
  | "graph-extract";

export interface UsageRecordInput {
  source: DirectUsageSource;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs?: number;
}

export async function recordUsage(input: UsageRecordInput): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  if (!Number.isFinite(input.inputTokens) || !Number.isFinite(input.outputTokens)) return;
  try {
    await invoke("usage_record", { args: input });
  } catch (e) {
    console.warn("[usage] record failed:", e);
  }
}
