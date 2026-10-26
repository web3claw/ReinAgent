/**
 * 知识图谱抽取链（ROADMAP ⑩，Hetu ExtractAsync 移植）：
 * 笔记/知识源内容 → 单轮 LLM（场景模型 graph → 回退聊天默认）→ JSON 解析容错 →
 * Rust graph_apply_extraction 去重落库。无场景绑定时调用方传聊天默认配置；
 * 模型未配置/解析失败如实抛错（no-fallback，绝不静默空图谱）。
 * 用量经 completeOneShotText(source="graph-extract") 记账（⑧ 体系）。
 */

/**
 * 知识图谱抽取纯逻辑（零依赖，node --test 直测）：
 * prompt 组装 / 响应解析容错 / DTO。
 */

export const GRAPH_ENTITY_TYPES = ["concept", "person", "organization", "technology", "project"] as const;
export const GRAPH_RELATION_TYPES = ["belong_to", "related_to", "depends_on", "contains", "compared_with"] as const;

export interface ExtractedEntity {
  name: string;
  type: string;
  description: string;
}
export interface ExtractedRelation {
  source: string;
  target: string;
  relation: string;
  description: string;
}
export interface ExtractedGraph {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

/** 抽取 prompt（Hetu 同款：封闭枚举 + JSON 示例 + 防过度提取约束） */
export function buildGraphExtractionPrompt(title: string, content: string): string {
  const jsonExample = `{
  "entities": [
    {"name": "实体名称", "type": "${GRAPH_ENTITY_TYPES.join("|")}", "description": "简短描述"}
  ],
  "relations": [
    {"source": "实体名称", "target": "实体名称", "relation": "${GRAPH_RELATION_TYPES.join("|")}", "description": "关系描述"}
  ]
}`;
  return `请从以下文档内容中提取关键实体和它们之间的关系。

标题：${title}

内容：
${content}

请以 JSON 格式返回，不要包含任何其他文字或 markdown 代码块标记：
${jsonExample}

注意：
- type 必须是 ${GRAPH_ENTITY_TYPES.join("、")} 之一
- relation 必须是 ${GRAPH_RELATION_TYPES.join("、")} 之一
- 只提取真正重要的实体和关系，不要过度提取`;
}

/**
 * 解析模型返回：剥 markdown 代码围栏 / 前后杂质文本 → 首个 { 到末个 } 截取 →
 * JSON.parse → 形状校验（数组 + name/source·target 为字符串）。失败返回 null（调用方如实报错）。
 */
export function parseGraphExtractionResponse(raw: string): ExtractedGraph | null {
  const text = raw.trim();
  // 剥 ```json ... ``` 围栏
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as { entities?: unknown; relations?: unknown };
  const entities: ExtractedEntity[] = [];
  if (Array.isArray(obj.entities)) {
    for (const e of obj.entities) {
      if (typeof e !== "object" || e === null) continue;
      const rec = e as Record<string, unknown>;
      if (typeof rec.name !== "string" || !rec.name.trim()) continue;
      entities.push({
        name: rec.name.trim(),
        type: typeof rec.type === "string" ? rec.type : "",
        description: typeof rec.description === "string" ? rec.description.trim() : "",
      });
    }
  }
  const relations: ExtractedRelation[] = [];
  if (Array.isArray(obj.relations)) {
    for (const r of obj.relations) {
      if (typeof r !== "object" || r === null) continue;
      const rec = r as Record<string, unknown>;
      if (typeof rec.source !== "string" || typeof rec.target !== "string") continue;
      if (!rec.source.trim() || !rec.target.trim()) continue;
      relations.push({
        source: rec.source.trim(),
        target: rec.target.trim(),
        relation: typeof rec.relation === "string" ? rec.relation : "",
        description: typeof rec.description === "string" ? rec.description.trim() : "",
      });
    }
  }
  if (entities.length === 0 && relations.length === 0) return null;
  return { entities, relations };
}
