/**
 * 知识库分块器（纯模块，无 Tauri 依赖，node --test 可直跑）。
 *
 * 结构化分块（对齐 docs/ROADMAP.md ① 的 Hetu 调研）：
 * 1. 按 Markdown 标题（^#{1,6}\s）切段，维护 headingPath（"## A > ### B"）；
 *    全文无标题 = 单段（headingPath 为空）。
 * 2. 段内按空行分段落，段落累积到 CHUNK_MAX_CHARS 为一块；
 * 3. 单段落超限 → 按句子（。！？.!?\n）硬切，块间保留 CHUNK_OVERLAP_CHARS 尾部重叠；
 * 4. 段末尾不足 CHUNK_MIN_MERGE_CHARS 的小块并入前一块（不超上限时）。
 *
 * embedding 输入 = headingPath + "\n\n" + content（有标题时），空标题用原文。
 */

export interface KnowledgeChunk {
  index: number;
  headingPath: string;
  content: string;
}

export const CHUNK_MAX_CHARS = 1500;
export const CHUNK_OVERLAP_CHARS = 100;
export const CHUNK_MIN_MERGE_CHARS = 200;

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

interface RawSection {
  headingPath: string;
  body: string;
}

/** 把文本切成「标题路径 + 正文」的段（无标题文档 = 单段）。 */
function splitSections(text: string): RawSection[] {
  const lines = text.split("\n");
  const sections: RawSection[] = [];
  // 标题栈：[{level, text}]，headingPath = 各级标题按 " > " 连接
  const stack: Array<{ level: number; text: string }> = [];
  let current: RawSection = { headingPath: "", body: "" };
  let sawAnyHeading = false;

  const flush = () => {
    sections.push(current);
  };

  for (const line of lines) {
    const match = HEADING_RE.exec(line);
    if (match) {
      flush();
      sawAnyHeading = true;
      const level = match[1].length;
      const title = match[2].trim();
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      stack.push({ level, text: title });
      current = {
        headingPath: stack.map((s) => `${"#".repeat(s.level)} ${s.text}`).join(" > "),
        body: "",
      };
      continue;
    }
    current.body += (current.body ? "\n" : "") + line;
  }
  flush();

  if (!sawAnyHeading) {
    // 全文无标题：整篇为单段，headingPath 为空
    return [{ headingPath: "", body: text }];
  }
  return sections;
}

/** 按句子边界硬切超长文本（保留 CHUNK_OVERLAP_CHARS 尾部重叠）。 */
function hardSplitBySentence(text: string, maxChars: number, overlapChars: number): string[] {
  const sentences = text
    .split(/(?<=[。！？.!?\n])/)
    .map((s) => s)
    .filter((s) => s.length > 0);
  const pieces: string[] = [];
  let buf = "";
  for (const sentence of sentences) {
    // 单句本身就超限：按字符硬切（无语义边界可用）
    if (sentence.length > maxChars) {
      if (buf.trim()) {
        pieces.push(buf);
        buf = "";
      }
      let cursor = 0;
      while (cursor < sentence.length) {
        const end = Math.min(cursor + maxChars, sentence.length);
        pieces.push(sentence.slice(cursor, end));
        cursor = end > cursor + maxChars - overlapChars ? end : cursor + maxChars - overlapChars;
        if (end >= sentence.length) break;
      }
      continue;
    }
    if (buf.length + sentence.length > maxChars && buf.trim()) {
      pieces.push(buf);
      const tail = buf.slice(-overlapChars);
      buf = tail;
    }
    buf += sentence;
  }
  if (buf.trim()) pieces.push(buf);
  return pieces.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** 段落 → 块（累积 + 尾部小块合并），块间不加重叠（重叠只发生在句子硬切）。 */
function sectionChunks(body: string, maxChars: number, minChars: number, overlapChars: number): string[] {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) return [];

  const blocks: string[] = [];
  let buf = "";
  for (const para of paragraphs) {
    if (para.length > maxChars) {
      if (buf.trim()) {
        blocks.push(buf);
        buf = "";
      }
      blocks.push(...hardSplitBySentence(para, maxChars, overlapChars));
      continue;
    }
    if (buf.length + para.length + 2 > maxChars && buf.trim()) {
      blocks.push(buf);
      buf = "";
    }
    buf += (buf ? "\n\n" : "") + para;
  }
  if (buf.trim()) {
    if (buf.trim().length < minChars && blocks.length > 0) {
      const prev = blocks[blocks.length - 1];
      if (prev.length + buf.length + 2 <= maxChars) {
        blocks[blocks.length - 1] = `${prev}\n\n${buf.trim()}`;
        buf = "";
      }
    }
    if (buf.trim()) blocks.push(buf);
  }
  return blocks.map((b) => b.trim()).filter((b) => b.length > 0);
}

/** 主入口：Markdown 文本 → 有序知识块。 */
export function chunkMarkdown(text: string): KnowledgeChunk[] {
  if (typeof text !== "string" || text.trim().length === 0) return [];
  const normalized = text.replace(/\r\n?/g, "\n");
  const chunks: KnowledgeChunk[] = [];
  for (const section of splitSections(normalized)) {
    for (const content of sectionChunks(
      section.body,
      CHUNK_MAX_CHARS,
      CHUNK_MIN_MERGE_CHARS,
      CHUNK_OVERLAP_CHARS,
    )) {
      chunks.push({ index: 0, headingPath: section.headingPath, content });
    }
  }
  return chunks.map((chunk, i) => ({ ...chunk, index: i }));
}

/** embedding 输入文本：标题路径前置（无标题 = 原文）。 */
export function chunkEmbeddingInput(chunk: Pick<KnowledgeChunk, "headingPath" | "content">): string {
  return chunk.headingPath ? `${chunk.headingPath}\n\n${chunk.content}` : chunk.content;
}
