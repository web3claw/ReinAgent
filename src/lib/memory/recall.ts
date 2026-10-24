/**
 * 记忆语义召回（记忆升级包，ROADMAP ③）：
 * 知识库 embedding 已绑定时，发送前以用户消息为查询做记忆语义检索
 * （打分公式在 Rust memory_semantic_search：相似度/重要度/衰减/频次 + 回写），
 * 命中块替换静态记忆索引进 meta_user。
 *
 * 返回契约：
 * - string：语义召回节（可能为空串=无命中，此时仅保留 MemoryManager 规则段）
 * - null：回退现有静态索引（未绑定 / 检索失败 toast + 诚实降级）
 */

import { invoke } from "@tauri-apps/api/core";
import { embedInputs } from "../knowledge/embeddingClient";
import { isKnowledgeConfigured, resolveKnowledgeEmbeddingTarget } from "../knowledge/providerBinding";
import { formatMemoryRecall, type MemorySemanticHit } from "./recallFormat.ts";
import { toast } from "../../components/lw/ui/toast";

export const MEMORY_RECALL_QUERY_MAX_CHARS = 2000;
const MEMORY_RECALL_TOP_K = 5;

/**
 * 语义召回。调用方（runAgentTurn）拿到 null 时走现有静态索引路径。
 * 查询 = 最后一条用户消息（截 2000 字符）。
 */
export async function buildMemoryRecallSection(userQuery: string): Promise<string | null> {
  const query = (userQuery ?? "").trim().slice(0, MEMORY_RECALL_QUERY_MAX_CHARS);
  if (query.length === 0) return null;
  if (!isKnowledgeConfigured()) return null;
  try {
    const target = await resolveKnowledgeEmbeddingTarget();
    const { vectors } = await embedInputs(target, [query]);
    const hits = await invoke<MemorySemanticHit[]>("memory_semantic_search", {
      args: { queryEmbedding: vectors[0], topK: MEMORY_RECALL_TOP_K, workdir: undefined },
    });
    return formatMemoryRecall(hits);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[memory] 语义召回失败（回退静态索引）:", message);
    toast.warning(`记忆语义召回失败，已回退静态索引：${message}`);
    return null;
  }
}
