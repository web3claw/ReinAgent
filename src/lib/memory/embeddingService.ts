/**
 * 记忆向量服务（记忆升级包，ROADMAP ③）：把记忆条目按 body_hash 差分
 * 向量化进 memory-index.sqlite3（Rust memory_embed_* 命令），复用知识库的
 * embedding 绑定（providerBinding）与出站客户端（embeddingClient）。
 *
 * - 未绑定 embedding 服务商 → sweep 如实跳过（合法空态，记忆回退静态索引）；
 * - 绑定模型变更 → 清空全部记忆向量后全量重嵌（dimensions 一致性由 Rust
 *   fail-fast 兜底）；
 * - 触发：App 启动一次 + 记忆写路径（write/update/delete/accept/applyBatch）
 *   防抖 1.5s（autoIndex 同款模式）；失败仅 console.warn（旁路不扰主流程）。
 */

import { invoke } from "@tauri-apps/api/core";
import { embedInputs } from "../knowledge/embeddingClient.ts";
import { isKnowledgeConfigured, resolveKnowledgeEmbeddingTarget } from "../knowledge/providerBinding.ts";
import { planMemoryEmbedDiff } from "./embedPlan.ts";

export interface MemoryEmbedScanEntry {
  scope: string;
  workdirHash: string;
  slug: string;
  bodyHash: string;
  memoryType: string;
  embedText: string;
}

export interface MemoryEmbedStoredRow {
  scope: string;
  workdirHash: string;
  slug: string;
  bodyHash: string;
  dims: number;
}

export interface MemoryEmbedScanResponse {
  entries: MemoryEmbedScanEntry[];
  stored: MemoryEmbedStoredRow[];
  modelId: string;
  dims: number | null;
}

export interface MemoryEmbedDiff {
  toEmbed: MemoryEmbedScanEntry[];
  toDelete: Array<{ scope: string; workdirHash: string; slug: string }>;
}

export interface MemoryEmbedSweepResult {
  embedded: number;
  removed: number;
  skippedUnconfigured?: boolean;
}

export async function memoryEmbedSweep(): Promise<MemoryEmbedSweepResult> {
  if (!isKnowledgeConfigured()) {
    return { embedded: 0, removed: 0, skippedUnconfigured: true };
  }
  const target = await resolveKnowledgeEmbeddingTarget();
  const scan = await invoke<MemoryEmbedScanResponse>("memory_embed_scan");
  const diff = planMemoryEmbedDiff(scan, target.model);
  if (diff.toDelete.length > 0) {
    await invoke("memory_embed_delete_keys", { keys: diff.toDelete });
  }
  if (diff.toEmbed.length === 0) {
    return { embedded: 0, removed: diff.toDelete.length };
  }
  const inputs = diff.toEmbed.map((entry) => entry.embedText);
  const batchSize = 16;
  const vectors: number[][] = [];
  for (let start = 0; start < inputs.length; start += batchSize) {
    const result = await embedInputs(target, inputs.slice(start, start + batchSize));
    vectors.push(...result.vectors);
  }
  const items = diff.toEmbed.map((entry, i) => ({
    scope: entry.scope,
    workdirHash: entry.workdirHash,
    slug: entry.slug,
    bodyHash: entry.bodyHash,
    embedding: vectors[i],
  }));
  const embedded = await invoke<number>("memory_embed_upsert", {
    args: { items, modelId: target.model },
  });
  return { embedded, removed: diff.toDelete.length };
}

// ---- 防抖调度（autoIndex 同款）----

const DEBOUNCE_MS = 1500;
let sweepTimer: ReturnType<typeof setTimeout> | null = null;
let sweepInFlight = false;

/** 记忆写路径防抖触发；in-flight 期间的新触发合并为一次尾巴重扫。 */
export function scheduleMemoryEmbed(delayMs = DEBOUNCE_MS): void {
  if (sweepTimer) clearTimeout(sweepTimer);
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    void runSweepQuietly();
  }, delayMs);
}

async function runSweepQuietly(): Promise<void> {
  if (sweepInFlight) {
    scheduleMemoryEmbed(500);
    return;
  }
  sweepInFlight = true;
  try {
    await memoryEmbedSweep();
  } catch (err) {
    console.warn("[memory] 向量化 sweep 失败（语义召回将滞后）:", err instanceof Error ? err.message : err);
  } finally {
    sweepInFlight = false;
  }
}
