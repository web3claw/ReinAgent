/**
 * 知识图谱抽取链（ROADMAP ⑩）运行时：单轮 LLM（completeOneShotText，
 * source="graph-extract" 记账）+ Rust 去重落库。纯逻辑见 graphExtractLogic.ts。
 */

import { completeOneShotText } from "../promptEnhancement/enhance";
import type { ProviderConfig } from "../providers/modelFactory";
import { invoke } from "@tauri-apps/api/core";
import { parseGraphExtractionResponse, buildGraphExtractionPrompt } from "./graphExtractLogic";
import type { ExtractedGraph } from "./graphExtractLogic";

export * from "./graphExtractLogic";

/** 单轮抽取（模型配置由调用方解析：graph 场景绑定 → 聊天默认） */
export async function runGraphExtraction(
  config: ProviderConfig,
  title: string,
  content: string,
  signal: AbortSignal,
): Promise<ExtractedGraph> {
  const raw = await completeOneShotText(
    config,
    "你是知识图谱提取助手。只输出 JSON，不要输出其他内容。",
    buildGraphExtractionPrompt(title, content),
    "off",
    signal,
    "graph-extract",
  );
  const parsed = parseGraphExtractionResponse(raw);
  if (!parsed) {
    throw new Error("图谱抽取结果解析失败（模型未返回合法 JSON）");
  }
  return parsed;
}

export interface GraphApplyResult {
  newEntities: number;
  skippedEntities: number;
  newRelations: number;
  skippedRelations: number;
}

/** 去重落库（Rust 侧实体小写名全局去重 + 三元组去重） */
export async function applyGraphExtraction(
  sourceId: string | null,
  extracted: ExtractedGraph,
): Promise<GraphApplyResult> {
  return invoke<GraphApplyResult>("graph_apply_extraction", {
    args: { sourceId, entities: extracted.entities, relations: extracted.relations },
  });
}
