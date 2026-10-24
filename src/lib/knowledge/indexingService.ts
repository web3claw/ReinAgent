/**
 * 知识库索引编排（TS 侧）：扫描 → 指纹比对 → 取正文 → 分块 → 增量 embedding
 * → 整源 upsert。Rust 侧只存向量与元数据（见 knowledge_index.rs）。
 *
 * 增量语义（Hetu 调研结论）：块内容未变复用旧向量；源指纹未变跳过；源消失
 * 删索引；上次失败的源强制重索引。单源 chunk 数超限截断（console.warn 如实
 * 记录，chunk_count 即截断后数量）。
 *
 * No-Fallback：未配置 embedding 服务商时手动 sweep 抛错、自动触发跳过（合法
 * 空态）；单源失败记 status=error + 错误原文，绝不静默。
 */

import { invoke } from "@tauri-apps/api/core";
import { chunkMarkdown, chunkEmbeddingInput } from "./chunker";
import { embedInputs } from "./embeddingClient";
import { resolveKnowledgeEmbeddingTarget, isKnowledgeConfigured } from "./providerBinding";
import { computeIndexPlan, diffChunks, type KnowledgeScanRow } from "./indexingPlan";
import { tauriImportFs } from "../import/scan";

/** 单源正文硬上限（字符）：防超大导入会话把 embedding 队列撑爆 */
const INDEX_MAX_SOURCE_CHARS = 200_000;
/** 单源 chunk 硬上限 */
const INDEX_MAX_CHUNKS_PER_SOURCE = 2000;

export interface KnowledgeIndexProgress {
  phase: "scan" | "embed" | "done";
  sourceTitle?: string;
  doneSources?: number;
  totalSources?: number;
  embeddedChunks?: number;
  totalEmbedChunks?: number;
}

export interface KnowledgeSweepResult {
  indexed: number;
  unchanged: number;
  deleted: number;
  errors: string[];
  /** 自动触发且未配置 embedding 时为 true（合法跳过，不是错误） */
  skippedUnconfigured?: boolean;
}

interface MessagePartRow {
  kind: string;
  payload: string;
}

interface MessageRow {
  msg_id: string;
  seq: number;
  role: string;
  parts: MessagePartRow[];
}

/** 导入任务正文 = 按 seq 顺序抽取 text 部件，带角色标签拼接。 */
async function loadImportSourceText(taskId: string): Promise<string> {
  const rows = await invoke<MessageRow[]>("conversation_load", { taskId });
  const lines: string[] = [];
  for (const row of rows) {
    for (const part of row.parts ?? []) {
      if (part.kind !== "text") continue;
      let text = "";
      try {
        const parsed = JSON.parse(part.payload) as { text?: unknown };
        if (typeof parsed.text === "string") text = parsed.text;
      } catch {
        text = "";
      }
      if (typeof text !== "string" || text.trim() === "") continue;
      const role = row.role === "user" ? "user" : "assistant";
      lines.push(`[${role}] ${text}`);
    }
  }
  return lines.join("\n\n");
}

async function loadSourceText(row: KnowledgeScanRow): Promise<string> {
  if (row.sourceType === "note") {
    const text = await tauriImportFs.readText(row.sourcePath);
    if (text == null) throw new Error(`读取笔记失败：${row.sourcePath}`);
    return text;
  }
  return loadImportSourceText(row.sourceId);
}

function sourceUpsertPayload(row: KnowledgeScanRow, status: "ok" | "error", error: string | null) {
  return {
    source: {
      id: row.sourceId,
      sourceType: row.sourceType,
      title: row.title,
      sourcePath: row.sourcePath,
      fingerprint: row.fingerprint,
      status,
      error,
    },
  };
}

/**
 * 全量扫描 + 增量索引。
 * @param opts.throwOnUnconfigured 手动触发（设置页）传 true：未配置直接抛错；
 *        自动触发（保存防抖等）传 false：未配置如实跳过。
 * @param opts.forceRebuild 先清空索引再全量重建（embedding 模型变更时用）。
 */
export async function knowledgeSweep(
  opts?: {
    onProgress?: (p: KnowledgeIndexProgress) => void;
    throwOnUnconfigured?: boolean;
    forceRebuild?: boolean;
  },
): Promise<KnowledgeSweepResult> {
  const onProgress = opts?.onProgress ?? (() => {});
  const throwOnUnconfigured = opts?.throwOnUnconfigured ?? true;

  if (!isKnowledgeConfigured()) {
    if (throwOnUnconfigured) {
      throw new Error("知识库未配置 embedding 服务商（设置 ▸ 知识库 中绑定后重试）");
    }
    return { indexed: 0, unchanged: 0, deleted: 0, errors: [], skippedUnconfigured: true };
  }
  const target = await resolveKnowledgeEmbeddingTarget();

  onProgress({ phase: "scan" });
  const scannedRows = await invoke<
    Array<{ sourceId: string; sourceType: "note" | "import"; title: string; sourcePath: string; fingerprint: string }>
  >("knowledge_scan_sources");
  const storedMetas = await invoke<Array<{ sourceId: string; fingerprint: string; status: string }>>(
    "knowledge_list_sources",
  );
  const plan = computeIndexPlan(scannedRows, storedMetas);

  // 源消失 → 删索引（幂等）
  for (const id of plan.toDelete) {
    await invoke("knowledge_index_delete_source", { sourceId: id });
  }

  // 模型变更（绑定换了但索引还是旧模型）：显式报错要求重建，绝不混维写入
  if (!opts?.forceRebuild && plan.toIndex.length > 0) {
    const stats = await invoke<{ modelId: string; chunkCount: number }>("knowledge_stats");
    if (stats.chunkCount > 0 && stats.modelId && stats.modelId !== target.model) {
      throw new Error(
        `embedding 模型已变更（索引：${stats.modelId}，当前绑定：${target.model}）——请在设置 ▸ 知识库 执行「清空索引」后重新「扫描并索引」`,
      );
    }
  }
  if (opts?.forceRebuild) {
    await invoke("knowledge_index_clear");
  }

  const errors: string[] = [];
  let done = 0;
  const total = plan.toIndex.length;
  for (const row of plan.toIndex) {
    done += 1;
    try {
      await knowledgeIndexRow(row, target, (embedded, totalEmbed) => {
        onProgress({
          phase: "embed",
          sourceTitle: row.title,
          doneSources: done,
          totalSources: total,
          embeddedChunks: embedded,
          totalEmbedChunks: totalEmbed,
        });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${row.title || row.sourceId}: ${message}`);
      // 失败源如实落库（status=error），sweep 继续其余源；下次 sweep 会重试
      await invoke("knowledge_index_upsert", {
        args: { ...sourceUpsertPayload(row, "error", message), chunks: [], modelId: target.model },
      }).catch(() => {});
    }
  }
  onProgress({ phase: "done" });
  return {
    indexed: total - errors.length,
    unchanged: plan.unchanged.length,
    deleted: plan.toDelete.length,
    errors,
  };
}

/**
 * 单源索引（笔记保存防抖 / 导入完成防抖用）。源已不存在 → 删除索引行。
 * 未配置 embedding 时静默跳过（自动触发的合法空态）。
 */
export async function knowledgeIndexSingleSource(
  sourceId: string,
  onProgress?: (p: KnowledgeIndexProgress) => void,
): Promise<{ indexed: boolean; deleted: boolean; skippedUnconfigured?: boolean }> {
  if (!isKnowledgeConfigured()) {
    return { indexed: false, deleted: false, skippedUnconfigured: true };
  }
  const target = await resolveKnowledgeEmbeddingTarget();
  const rows = await invoke<
    Array<{ sourceId: string; sourceType: "note" | "import"; title: string; sourcePath: string; fingerprint: string }>
  >("knowledge_scan_sources");
  const row = rows.find((r) => r.sourceId === sourceId);
  if (!row) {
    await invoke("knowledge_index_delete_source", { sourceId }).catch(() => {});
    return { indexed: false, deleted: true };
  }
  await knowledgeIndexRow(row, target, (embedded, totalEmbed) => {
    onProgress?.({
      phase: "embed",
      sourceTitle: row.title,
      doneSources: 1,
      totalSources: 1,
      embeddedChunks: embedded,
      totalEmbedChunks: totalEmbed,
    });
  });
  return { indexed: true, deleted: false };
}

/** 索引单个数据源：取正文 → 分块 → 增量 embedding → 整源 upsert。 */
async function knowledgeIndexRow(
  row: KnowledgeScanRow,
  target: { baseUrl: string; apiKey: string; model: string },
  onEmbedProgress?: (embedded: number, total: number) => void,
): Promise<void> {
  let text = await loadSourceText(row);
  if (text.length > INDEX_MAX_SOURCE_CHARS) {
    console.warn(
      `[knowledge] 源 ${row.sourceId} 正文 ${text.length} 字符超上限，截断至 ${INDEX_MAX_SOURCE_CHARS}`,
    );
    text = text.slice(0, INDEX_MAX_SOURCE_CHARS);
  }
  let chunks = chunkMarkdown(text);
  if (chunks.length > INDEX_MAX_CHUNKS_PER_SOURCE) {
    console.warn(
      `[knowledge] 源 ${row.sourceId} 分块 ${chunks.length} 超上限，截断至 ${INDEX_MAX_CHUNKS_PER_SOURCE}`,
    );
    chunks = chunks.slice(0, INDEX_MAX_CHUNKS_PER_SOURCE);
  }

  // 增量：与库内旧块按内容比对，未变块复用向量
  const oldChunks = await invoke<
    Array<{ index: number; headingPath: string; content: string; embedding: number[] }>
  >("knowledge_get_chunks", { sourceId: row.sourceId });
  const diff = diffChunks(oldChunks, chunks);

  if (diff.toEmbed.length > 0) {
    const inputs = diff.toEmbed.map((i) => chunkEmbeddingInput(chunks[i]));
    let embeddedCount = 0;
    onEmbedProgress?.(0, inputs.length);
    const batchSize = 16;
    const vectors = new Map<number, number[]>();
    for (let start = 0; start < inputs.length; start += batchSize) {
      const result = await embedInputs(target, inputs.slice(start, start + batchSize));
      result.vectors.forEach((vec, offset) => {
        vectors.set(diff.toEmbed[start + offset], vec);
      });
      embeddedCount += result.vectors.length;
      onEmbedProgress?.(embeddedCount, inputs.length);
    }
    // 组装最终块序列：复用 + 新向量，按下标对齐
    const finalChunks = chunks.map((chunk, i) => ({
      index: i,
      headingPath: chunk.headingPath,
      content: chunk.content,
      embedding: diff.reusable[i] ?? vectors.get(i),
    }));
    if (finalChunks.some((c) => !Array.isArray(c.embedding) || c.embedding.length === 0)) {
      throw new Error("向量组装出现空洞（内部错误，拒绝写库）");
    }
    await invoke("knowledge_index_upsert", {
      args: { ...sourceUpsertPayload(row, "ok", null), chunks: finalChunks, modelId: target.model },
    });
    return;
  }

  // 无需新 embedding：全部复用（或空文档）→ 直接 upsert 元数据与块
  const finalChunks = chunks.map((chunk, i) => ({
    index: i,
    headingPath: chunk.headingPath,
    content: chunk.content,
    embedding: diff.reusable[i],
  }));
  await invoke("knowledge_index_upsert", {
    args: { ...sourceUpsertPayload(row, "ok", null), chunks: finalChunks, modelId: target.model },
  });
}
