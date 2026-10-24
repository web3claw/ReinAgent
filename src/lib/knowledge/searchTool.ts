/**
 * search_knowledge 工具：模型主动检索本地知识库（笔记 + 导入的外部会话）。
 *
 * 与 composer「知识库」开关（自动注入）互补：开关管每轮自动注入 top5，
 * 本工具让模型按需带自拟 query 检索（未配置 embedding 时返回说明文本而非
 * 静默失败——对模型如实，与 No-Fallback 一致）。只读，无需审批。
 */

import { Type } from "typebox";
import { invoke } from "@tauri-apps/api/core";
import { embedInputs } from "./embeddingClient";
import { resolveKnowledgeEmbeddingTarget, isKnowledgeConfigured } from "./providerBinding";
import { formatKnowledgeSection, formatKnowledgeHitLines, type KnowledgeSearchHit } from "./knowledgeFormat";
import { KNOWLEDGE_QUERY_MAX_CHARS } from "./injection";

export function createKnowledgeSearchTool() {
  return {
    name: "search_knowledge",
    label: "知识库检索",
    description:
      "Search the local knowledge base (user's notes and imported external AI sessions) by semantic similarity. " +
      "Use it whenever the user's request may relate to content stored in notes or past imported conversations " +
      "(preferences, prior decisions, research notes). Returns the top matching chunks with source titles.",
    parameters: Type.Object({
      query: Type.String({
        description: `Semantic search query text (max ${KNOWLEDGE_QUERY_MAX_CHARS} chars, will be truncated).`,
      }),
      topK: Type.Optional(
        Type.Number({
          description: "Maximum number of chunks to return (1-20, default 5).",
        }),
      ),
    }),
    execute: async (_toolCallId: string, toolParams: unknown) => {
      const args = (toolParams ?? {}) as { query?: unknown; topK?: unknown };
      const query = typeof args.query === "string" ? args.query.trim().slice(0, KNOWLEDGE_QUERY_MAX_CHARS) : "";
      if (query.length === 0) {
        throw new Error("search_knowledge: query 不能为空");
      }
      if (!isKnowledgeConfigured()) {
        return {
          content: [
            {
              type: "text" as const,
              text: "知识库未配置 embedding 服务商（设置 ▸ 知识库 中绑定后可用）。本次检索未执行。",
            },
          ],
          details: { configured: false },
        };
      }
      const topKRaw = typeof args.topK === "number" && Number.isFinite(args.topK) ? Math.floor(args.topK) : 5;
      const topK = Math.min(Math.max(topKRaw, 1), 20);
      try {
        const target = await resolveKnowledgeEmbeddingTarget();
        const { vectors } = await embedInputs(target, [query]);
        const hits = await invoke<KnowledgeSearchHit[]>("knowledge_search", {
          args: { queryEmbedding: vectors[0], topK },
        });
        if (hits.length === 0) {
          return {
            content: [{ type: "text" as const, text: `知识库中没有与「${query}」相关的命中。` }],
            details: { hits: 0 },
          };
        }
        const text = `${formatKnowledgeSection(hits)}\n\n命中来源：\n${formatKnowledgeHitLines(hits)}`;
        return { content: [{ type: "text" as const, text }], details: { hits: hits.length } };
      } catch (err) {
        // No-Fallback：错误原文上抛（库统一转 isError toolResult）
        throw new Error(`search_knowledge 检索失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
