/**
 * 知识库检索注入（meta_user 通道）：
 * - buildKnowledgeSection(userQuery)：composer「知识库」开关打开时，每轮发送前
 *   以用户消息为 query 做语义检索，命中块包 <knowledge-source> 注入 meta_user
 *   （对齐 buildMentionBlock 的「上下文非指令」防注入语义，格式化在 knowledgeFormat.ts）。
 * - 合法空态：未配置 embedding / 空索引 / 空查询 → 空串（段不进 meta_user）。
 * - 检索失败：toast.warning 显示完整错误原文 + 返回空串（不阻断回合）。
 */

import { invoke } from "@tauri-apps/api/core";
import { embedInputs } from "./embeddingClient";
import { resolveKnowledgeEmbeddingTarget, isKnowledgeConfigured, getKnowledgeSettings } from "./providerBinding";
import { formatKnowledgeSection, type KnowledgeSearchHit } from "./knowledgeFormat";
import { toast } from "../../components/lw/ui/toast";

export const KNOWLEDGE_QUERY_MAX_CHARS = 2000;
const KNOWLEDGE_SEARCH_DEFAULT_TOP_K = 5;
const KNOWLEDGE_SEARCH_MAX_TOP_K = 20;

/**
 * 检索并生成注入段。开关判定在调用方（assembleTurnContext 按 per-task/global
 * 开关决定是否调用）；本函数只处理「配置/索引/查询」三个空态与失败路径。
 */
export async function buildKnowledgeSection(userQuery: string): Promise<string> {
  const query = (userQuery ?? "").trim().slice(0, KNOWLEDGE_QUERY_MAX_CHARS);
  if (query.length === 0) return "";
  if (!isKnowledgeConfigured()) return "";
  const settings = getKnowledgeSettings();
  const topK = Math.min(Math.max(settings.topK || KNOWLEDGE_SEARCH_DEFAULT_TOP_K, 1), KNOWLEDGE_SEARCH_MAX_TOP_K);
  try {
    const target = await resolveKnowledgeEmbeddingTarget();
    const { vectors } = await embedInputs(target, [query]);
    const hits = await invoke<KnowledgeSearchHit[]>("knowledge_search", {
      args: { queryEmbedding: vectors[0], topK },
    });
    return formatKnowledgeSection(hits);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[knowledge] 检索失败（本轮无知识库注入，回合继续）:", message);
    toast.warning(`知识库检索失败：${message}`);
    return "";
  }
}
