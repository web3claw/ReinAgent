/**
 * 知识源跳转（图谱/检索增强 v2）：把知识源 source_id 路由到对应视图——
 * - `note:<notebook>:<file>` → 笔记页打开该笔记（App 的 targetNoteToOpen 通道）
 * - `wiki:<docId>` → Wiki 页选中该文档
 * - `import-*`（导入会话）→ 对应历史任务
 * 统一走 window 事件 `reinagent-open-knowledge-source`（App 监听），
 * 对齐 prefill/messageTheme 的事件广播先例，免三层 prop 钻孔。
 */

export const OPEN_KNOWLEDGE_SOURCE_EVENT = "reinagent-open-knowledge-source";

export type KnowledgeSourceTarget =
  | { kind: "note"; notebookRelPath: string; fileName: string }
  | { kind: "wiki"; docId: string }
  | { kind: "import"; taskId: string }
  | { kind: "unknown" };

/**
 * source_id → 跳转目标。
 * 笔记 sourceId 形如 `notebook:file.md`（根笔记本无冒号前缀则整串是文件名）。
 * wiki 形如 `wiki:<docId>`；导入为 `import-...`。
 */
export function parseKnowledgeSourceId(sourceId: string): KnowledgeSourceTarget {
  const id = (sourceId ?? "").trim();
  if (!id) return { kind: "unknown" };
  if (id.startsWith("wiki:")) {
    const docId = id.slice("wiki:".length);
    return docId ? { kind: "wiki", docId } : { kind: "unknown" };
  }
  if (id.startsWith("import-") || id.startsWith("import:")) {
    return { kind: "import", taskId: id.startsWith("import:") ? id.slice("import:".length) : id };
  }
  const idx = id.indexOf(":");
  if (idx > 0 && idx < id.length - 1) {
    return { kind: "note", notebookRelPath: id.slice(0, idx), fileName: id.slice(idx + 1) };
  }
  // 无冒号 = 根笔记本文件名
  if (/\.(md|markdown)$/i.test(id)) {
    return { kind: "note", notebookRelPath: "", fileName: id };
  }
  return { kind: "unknown" };
}

/** 跳转请求（App 侧监听执行；无 Tauri/浏览器环境静默无副作用） */
export function requestOpenKnowledgeSource(sourceId: string): void {
  if (typeof window === "undefined") return;
  const target = parseKnowledgeSourceId(sourceId);
  if (target.kind === "unknown") return;
  window.dispatchEvent(new CustomEvent(OPEN_KNOWLEDGE_SOURCE_EVENT, { detail: target }));
}

/** 图谱实体 → 首个可跳转的关系来源（无则 null） */
export function firstNavigableSourceId(
  relations: { sourceId: string | null }[],
): string | null {
  for (const rel of relations) {
    if (rel.sourceId && parseKnowledgeSourceId(rel.sourceId).kind !== "unknown") {
      return rel.sourceId;
    }
  }
  return null;
}
