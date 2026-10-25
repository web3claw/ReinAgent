/**
 * 笔记增强包（ROADMAP ④）纯函数层：标签色 hash、tag: 搜索解析、划词 AI
 * prompt 分区构造。纯模块（无 Tauri 依赖），node --test 直跑；UI 与
 * notesService 从这里导入。
 */

/** 标签固定色板（语义 token 由 UI 层映射；这里只产 index） */
export const TAG_PALETTE_SIZE = 8;

/** tag 名 → 稳定色板 index（FNV-1a 32 位，跨会话稳定——同一标签恒同色）。 */
export function tagColorIndex(tag: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < tag.length; i++) {
    hash ^= tag.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % TAG_PALETTE_SIZE;
}

/** 搜索词解析：`tag:xxx 其他词` → { tag: "xxx", query: "其他词" }；无前缀 → tag=null。 */
export function parseTagSearch(searchTerm: string): { tag: string | null; query: string } {
  const trimmed = (searchTerm ?? "").trim();
  const match = /^tag:(\S+)\s*(.*)$/.exec(trimmed);
  if (!match) return { tag: null, query: trimmed };
  return { tag: match[1], query: match[2].trim() };
}

/** 笔记是否命中过滤（标题/文件名/snippet 常规词 + tag: 标签任一命中）。 */
export function noteMatchesSearch(
  note: { title: string; fileName: string; snippet: string },
  tagsOfNote: string[] | undefined,
  searchTerm: string,
): boolean {
  const { tag, query } = parseTagSearch(searchTerm);
  if (tag) {
    const tagHit = (tagsOfNote ?? []).some((t) => t.toLowerCase() === tag.toLowerCase());
    if (!tagHit) return false;
    if (!query) return true;
  }
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    note.title.toLowerCase().includes(q) ||
    note.fileName.toLowerCase().includes(q) ||
    note.snippet.toLowerCase().includes(q)
  );
}

// ==================== 划词 AI prompt 分区（ROADMAP ④ 防整篇回显）====================

export interface InlineAiPromptParams {
  instruction: string;
  /** 选区文本（空 = 无选区，整篇为待处理） */
  selection: string;
  noteTitle: string;
  fullMarkdown: string;
  selectionChars: number;
  fullChars: number;
}

/**
 * 构造「待处理文本 vs 背景参考」分区的行内 AI prompt（照 Hetu 整套语义）：
 * - 有选区：选区是唯一待处理对象；标题+全文只是理解语境的背景，
 *   **明令禁止背景出现在输出**（防整篇回显覆盖——ROADMAP 警示的核心事故）。
 * - 无选区：整篇为待处理（现状语义保持）。
 */
export function buildInlineAiPrompt(params: InlineAiPromptParams): string {
  const { instruction, selection, noteTitle, fullMarkdown, selectionChars, fullChars } = params;
  const systemConstraints = [
    "只输出处理后的结果文本本身。",
    "不要前后缀说明、不要代码块包裹（除非原文就是代码块）、不要复述指令。",
  ].join("\n");
  if (!selection.trim()) {
    return [
      `任务：${instruction}`,
      "",
      `待处理文本（笔记《${noteTitle}》全文，${fullChars} 字符）：`,
      "<<<TEXT",
      fullMarkdown,
      "TEXT>>>",
      "",
      systemConstraints,
    ].join("\n");
  }
  return [
    `任务：${instruction}`,
    "",
    `待处理文本（用户选中的 ${selectionChars} 字符，只处理这一段）：`,
    "<<<SELECTION",
    selection,
    "SELECTION>>>",
    "",
    "背景参考（笔记《" + noteTitle + "》全文，仅供理解语境；严禁把背景内容复述进输出，输出中不得出现选区之外的原文）：",
    "<<<CONTEXT",
    fullMarkdown,
    "CONTEXT>>>",
    "",
    systemConstraints,
  ].join("\n");
}
