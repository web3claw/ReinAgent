/**
 * 词级 diff（v2 尾巴 ④，笔记版本对照用）：按 token 切分（CJK 单字 / 拉丁词 /
 * 数字串 / 空白），双向 LCS 对齐，产出 same/add/del 片段流。
 * 零依赖纯函数，node --test 直测。规模护栏：token 上限各 2000，超出整体降级为单段替换。
 */

export type WordDiffType = "same" | "add" | "del";

export interface WordDiffSegment {
  type: WordDiffType;
  text: string;
}

/** token 切分：连续 CJK 字符逐字成 token、拉丁/数字连续串成词、空白成段 */
export function tokenizeForDiff(text: string): string[] {
  const tokens: string[] = [];
  let buf = "";
  let bufKind: "cjk" | "word" | "space" | null = null;
  const kindOf = (ch: string): "cjk" | "word" | "space" => {
    if (/\s/.test(ch)) return "space";
    if (/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/.test(ch)) return "cjk";
    return "word";
  };
  for (const ch of text) {
    const kind = kindOf(ch);
    if (kind !== bufKind && buf) {
      tokens.push(buf);
      buf = "";
    }
    bufKind = kind;
    buf += ch;
  }
  if (buf) tokens.push(buf);
  return tokens;
}

/** 词级 diff 片段流（LCS DP；规模超限降级为整体 add/del 单段） */
export function wordDiff(a: string, b: string): WordDiffSegment[] {
  const MAX_TOKENS = 2000;
  const at = tokenizeForDiff(a);
  const bt = tokenizeForDiff(b);
  if (at.length === 0 && bt.length === 0) return [];
  if (at.length === 0) return [{ type: "add", text: b }];
  if (bt.length === 0) return [{ type: "del", text: a }];
  if (at.length > MAX_TOKENS || bt.length > MAX_TOKENS) {
    return [
      { type: "del", text: a },
      { type: "add", text: b },
    ];
  }

  // LCS 长度表
  const m = at.length;
  const n = bt.length;
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = at[i] === bt[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // 回溯产出片段（相邻同类型合并）
  const raw: WordDiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (at[i] === bt[j]) {
      raw.push({ type: "same", text: at[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({ type: "del", text: at[i] });
      i++;
    } else {
      raw.push({ type: "add", text: bt[j] });
      j++;
    }
  }
  while (i < m) raw.push({ type: "del", text: at[i++] });
  while (j < n) raw.push({ type: "add", text: bt[j++] });

  const merged: WordDiffSegment[] = [];
  for (const seg of raw) {
    const last = merged[merged.length - 1];
    if (last && last.type === seg.type) last.text += seg.text;
    else merged.push({ ...seg });
  }
  return merged;
}

/** 渲染辅助：diff 片段流 → 逐段 React 无关的纯数据（统计 + 片段截断） */
export function wordDiffStats(segments: WordDiffSegment[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const seg of segments) {
    if (seg.type === "add") added += seg.text.length;
    else if (seg.type === "del") removed += seg.text.length;
  }
  return { added, removed };
}
