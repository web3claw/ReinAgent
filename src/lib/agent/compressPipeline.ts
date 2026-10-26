/**
 * 进模型前文本压缩管线（ROADMAP ⑥，对标 Hetu CompressionPipeline 的 v1 子集）：
 * 工具输出超限时的确定性纯函数变换，替代「傻头切」——重复与噪音先折掉，
 * 实在还超限才保首尾。挂载点：tools.js buildTextToolResult（全工具单一收口）。
 *
 * v1 节点（轻有损，用户拍板）：结构化折叠 → 连续重复行 → SimHash 近重复行 →
 * 空白收敛 → headtail（首 75% + 尾 25% 预算）。
 * 不进 v1（Hetu 有但我们明确排除）：number_normalize（数值改写风险）/
 * stopwords（Hetu 默认关）/ keywords（有损打分）/ llm_summary（需模型调用）。
 *
 * 铁律：每节点硬守卫「没变短就保留输入」——字节恒不增；小文本（≤PIPELINE_MIN_BYTES）
 * 直通零开销。纯模块，node --test 直跑。
 */

export const PIPELINE_MIN_BYTES = 4096;
export const SIMHASH_HAMMING_THRESHOLD = 3;
export const HEADTAIL_HEAD_RATIO = 0.75;

const BASE64_RE = /[A-Za-z0-9+/]{80,}={0,2}/g;
const HEX_RE = /\b[0-9a-fA-F]{64,}\b/g;
/** 数字串行级判定阈值：行长 ≥ 此值且只含数字/逗号/空白且 ≥16 个数 → 整行折叠。
 * （不用嵌套量词正则——`(?:\d+[,\s]+){16,}` 在数字密集输入上灾难性回溯，实测挂死测试。） */
const DIGIT_LINE_MIN_LEN = 120;
const DIGIT_LINE_MIN_COUNT = 16;

export interface PipelineNodeStat {
  node: string;
  before: number;
  after: number;
}

export interface CompressResult {
  text: string;
  /** 各节点前后字节（只记发生变化的节点）；空数组 = 直通或全节点无变化 */
  stats: PipelineNodeStat[];
  /** headtail 是否执行（最终仍超限才为 true） */
  truncated: boolean;
  originalBytes: number;
  finalBytes: number;
}

// ==================== 字节工具（UTF-8 安全）====================

const encoder = new TextEncoder();

export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/** UTF-8 安全按字节截取前缀（二分字符数，不劈多字节字符）。 */
function utf8SafeSliceByBytes(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    // ceil 中点：true 分支 lo=mid ≥ lo+1、false 分支 hi=mid-1 ≥ lo，恒有进展
    const mid = Math.ceil((lo + hi) / 2);
    if (encoder.encode(text.slice(0, mid)).length <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo);
}

function utf8SafeSliceByBytesFromEnd(text: string, maxBytes: number): string {
  const total = utf8Bytes(text);
  if (total <= maxBytes) return text;
  // 从尾部按字节找最小起点。⚠ 必须用 floor 中点：ceil 中点在 hi=lo+1 时
  // mid===hi，true 分支 hi=mid 零进展 → 死循环（é×8000 用例实测踩中）。
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = lo + ((hi - lo) >> 1);
    if (encoder.encode(text.slice(mid)).length <= maxBytes) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return text.slice(lo);
}

// ==================== SimHash（64 位 = 双 32 位半字）====================

function fnv32(str: string, seed: number): number {
  let hash = seed;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 词级 SimHash（[高位32, 低位32]），数字 token 归一化为 #：时间戳/计数器/ID
 * 差异的同构日志行哈希几乎一致，不同内容行汉明距离大——日志风暴折叠的关键。
 */
export function simhash64(line: string): [number, number] {
  const normalized = line.toLowerCase().replace(/\d+/g, "#");
  const tokens = normalized
    .split(/[^a-z#\u4e00-\u9fff]+/)
    .filter(Boolean);
  let hi = 0x811c9dc5;
  let lo = 0x9747b28c;
  const bitVotes = new Int8Array(64);
  for (const token of new Set(tokens)) {
    const h = fnv32(token, 0x7fffffff);
    const l = fnv32(token, 0xdeadbeef);
    for (let bit = 0; bit < 32; bit++) {
      bitVotes[bit] += (h >>> bit) & 1 ? 1 : -1;
      bitVotes[bit + 32] += (l >>> bit) & 1 ? 1 : -1;
    }
  }
  for (let bit = 0; bit < 32; bit++) {
    if (bitVotes[bit] > 0) hi |= 1 << bit;
    else hi &= ~(1 << bit);
    if (bitVotes[bit + 32] > 0) lo |= 1 << bit;
    else lo &= ~(1 << bit);
  }
  return [hi >>> 0, lo >>> 0];
}

function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
}

/** 汉明距离（SimHash 对）。纯函数，单测缝。 */
export function hammingDistance(a: [number, number], b: [number, number]): number {
  return popcount32((a[0] ^ b[0]) >>> 0) + popcount32((a[1] ^ b[1]) >>> 0);
}

// ==================== 节点实现（全部导出供单测）====================

/** ① 结构化折叠：长 hex(≥64)/base64(>80) → 占位符；数字密集行整行折叠。 */
export function foldStructuredBlobs(text: string): string {
  // hex 是 base64 字符集的子集——先匹配更具体的 hex，否则 hex 串会被当 base64 折叠
  const folded = text
    .replace(HEX_RE, (m) => `[folded:hex,${m.length}B]`)
    .replace(BASE64_RE, (m) => `[folded:base64,${m.length}B]`);
  // 数字串：行级判定（只含数字/逗号/空白、够长、数字个数达标 → 整行折叠）
  return folded
    .split("\n")
    .map((line) => {
      if (
        line.length >= DIGIT_LINE_MIN_LEN &&
        /^[\d,\s]+$/.test(line) &&
        (line.match(/\d+/g) ?? []).length >= DIGIT_LINE_MIN_COUNT
      ) {
        return `[folded:digits,${utf8Bytes(line)}B]`;
      }
      return line;
    })
    .join("\n");
}

/** ② 连续完全相同行折叠：首行 + `…[repeated ×N]`（空白行重复不记——那是空白收敛的职责）。 */
export function dedupConsecutiveLines(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let run = 1;
    while (i + run < lines.length && lines[i + run] === line) run++;
    out.push(line);
    if (run > 1 && line.trim() !== "") out.push(`…[repeated ×${run}]`);
    i += run;
  }
  return out.join("\n");
}

/**
 * ③ 相邻近重复行折叠：SimHash 汉明距离 ≤ threshold 视为同构（时间戳/计数器
 * 差异的日志风暴）；连续段（≥3 行）折叠为 首行 + `…[near-dup ×N]`。
 */
export function dedupNearDuplicateLines(
  text: string,
  threshold: number = SIMHASH_HAMMING_THRESHOLD,
): string {
  const lines = text.split("\n");
  if (lines.length < 3) return text;
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const hash = simhash64(lines[i]);
    let run = 1;
    while (
      i + run < lines.length &&
      lines[i + run].length > 0 &&
      hammingDistance(hash, simhash64(lines[i + run])) <= threshold
    ) {
      run++;
    }
    out.push(lines[i]);
    if (run > 2) out.push(`…[near-dup ×${run}]`);
    i += run;
  }
  return out.join("\n");
}

/** ④ 空白收敛：3+ 连续空行 → 1 空行；行尾空白剥除。 */
export function collapseWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** ⑥ number_normalize：≥3 位数字 token 归一为 [N]（时间戳/计数器/ID 提升近重复折叠率；≤2 位保留）。 */
export function normalizeNumbers(text: string): string {
  return text.replace(/\b\d+\b/g, (v) => (v.length <= 2 ? v : "[N]"));
}

// —— 关键行打分（Hetu ScoreKeyLine 同构）——
const ERROR_SIGNALS = /错误|失败|异常|报错|超时|拒绝|无法|不能|不存在|冲突|回滚|error|exception|fail(?:ed|ure)?|panic|fatal|traceback|❌|⛔/i;
const WARN_SIGNALS = /警告|注意|小心|退而求其次|降级|warn(?:ing)?|deprecat|⚠/i;
const DECISION_SIGNALS = /结论|决定|方案|必须|不要|禁止|建议|原因|根因|待办|下一步|TODO|FIXME|NOTE:|说明[：:]|修复|新增|删除|改动/i;
const PATH_SIGNALS = /(?:[A-Za-z]:\\|\/|\\)[\w.-]+(?:[/\\][\w.-]+)*|\b[\w-]+\.(?:rs|ts|tsx|js|jsx|json|md|py|sql|yml|yaml|xml|css|html|sh|ps1|png|jpg|log|txt|db)\b/i;
const COMMAND_SIGNALS = /^\s*(?:\$|>|PS\s?[A-Z]:\\|cargo|bun|npm|pnpm|yarn|git|gh|curl|python|node|docker|kubectl|systemctl)\b/;
const HEADING_SIGNALS = /^\s*(?:#{1,6}\s|\d+[.)]\s|[一二三四五六七八九十]+[、.]|[-*+]\s+\S)/;
const NOISE_SIGNALS = /^\s*(?:\d+%|\.{3,}|={3,}|-{3,}|等待中|加载中|处理中|loading|waiting|retry|heartbeat|ping)\s*$/;

/** 行信息量打分：正分=值得保留，负分=流水行 */
export function scoreKeyLine(line: string): number {
  const trimmed = line.trim();
  if (trimmed.length === 0) return 0;
  let score = 0;
  if (ERROR_SIGNALS.test(trimmed)) score += 6;
  if (WARN_SIGNALS.test(trimmed)) score += 3;
  if (DECISION_SIGNALS.test(trimmed)) score += 3;
  if (PATH_SIGNALS.test(trimmed)) score += 2;
  if (COMMAND_SIGNALS.test(trimmed)) score += 2;
  if (HEADING_SIGNALS.test(trimmed)) score += 2;
  if (trimmed.includes("→") || trimmed.includes("=>") || trimmed.includes("%")) score += 1;
  if (trimmed.length < 15) score -= 3;
  if (NOISE_SIGNALS.test(trimmed)) score -= 5;
  return score;
}

/**
 * ⑦ keywords 关键行抽取（Hetu ExtractKeyLines 同构）：长文本里大部分是流水行，
 * 按信息量打分保留错误/结论/路径/命令等关键行（首尾各 3 行固定保留），其余按预算
 * 裁掉并折叠为一行提示。关键行不足以压到预算内时返回原文，交给 headtail 处理。
 */
export function extractKeyLines(text: string): string {
  const MIN_CHARS = 2500;
  if (text.length < MIN_CHARS) return text;
  const lines = text.split("\n");
  if (lines.length < 25) return text;

  const scores = lines.map(scoreKeyLine);
  const keep = lines.map((_, i) => i < 3 || i >= lines.length - 3 || scores[i] > 0);
  let used = lines.reduce((acc, l, i) => (keep[i] ? acc + l.length + 1 : acc), 0);
  const budget = Math.max(1500, Math.floor(text.length / 3));
  if (used > budget) {
    // 优先丢分数最低、最长的流水行（首尾 3 行保护带之外、得分 <4 的可丢行）
    const droppable = lines
      .map((_, i) => i)
      .filter((i) => i >= 3 && i < lines.length - 3 && keep[i] && scores[i] < 4)
      .sort((a, b) => scores[a] - scores[b] || lines[b].length - lines[a].length);
    for (const i of droppable) {
      if (used <= budget) break;
      keep[i] = false;
      used -= lines[i].length + 1;
    }
  }
  if (used > budget) return text;

  const output: string[] = [];
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (skipped > 0) {
        output.push(`…[折叠 ${skipped} 行流水]`);
        skipped = 0;
      }
      output.push(lines[i]);
    } else {
      skipped += 1;
    }
  }
  if (skipped > 0) output.push(`…[折叠 ${skipped} 行流水]`);
  return output.join("\n");
}

// —— stopwords（默认关；CompressOptions.stopwords 显式开启才生效）——
const CN_STOPWORDS = new Set(["的", "了", "着", "地", "得", "之", "而已", "的话", "一个", "我们", "你们", "他们", "以及", "然后", "因此", "其实", "就是"]);
const EN_STOPWORDS = new Set(["the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do", "does", "did", "will", "would", "could", "should", "may", "might", "can", "shall", "to", "of", "in", "for", "on", "with", "at", "by", "from", "as", "into", "through", "during", "before", "after", "above", "below", "between", "and", "but", "or", "so", "yet", "both", "either", "each", "every", "all", "any", "few", "more", "most", "other", "some", "such", "same", "than", "too", "very", "just", "about", "also", "if", "then", "now", "here", "there", "when", "where", "why", "how", "it", "its", "this", "that", "these", "those"]);

/** ⑧ stopwords：剥离中英虚词（激进有损，默认关）。 */
export function removeStopwords(text: string): string {
  const words = text.split(/(\s+|[，。！？；：""（）\r\n])/);
  const out: string[] = [];
  for (const w of words) {
    if (!w || /^\s+$/.test(w) || w.length <= 1) out.push(w);
    else if (CN_STOPWORDS.has(w) || EN_STOPWORDS.has(w)) out.push(" ");
    else out.push(w);
  }
  return out.join("").replace(/ {2,}/g, " ");
}

/** ⑤ headtail：首 HEAD_RATIO 预算 + 标记 + 尾部余量（UTF-8 安全）。 */
export function headtailKeepEnds(
  text: string,
  maxBytes: number,
  originalBytes: number,
  postPipelineBytes: number,
): string {
  const marker = `\n…[compressed: 原 ${originalBytes} 字节 → 管线后 ${postPipelineBytes}，保留首尾 ${maxBytes}]\n`;
  const markerBytes = utf8Bytes(marker);
  const budget = Math.max(0, maxBytes - markerBytes);
  const headBudget = Math.floor(budget * HEADTAIL_HEAD_RATIO);
  const tailBudget = budget - headBudget;
  const head = utf8SafeSliceByBytes(text, headBudget);
  const tail = tailBudget > 0 ? utf8SafeSliceByBytesFromEnd(text, tailBudget) : "";
  return head + marker + tail;
}

// ==================== 编排 ====================

function applyNode(
  name: string,
  input: string,
  fn: (s: string) => string,
  stats: PipelineNodeStat[],
): string {
  const output = fn(input);
  // 硬守卫：没变短就保留输入（字节恒不增；等长也直接保留减少无谓 diff）
  if (output.length >= input.length) return input;
  stats.push({ node: name, before: utf8Bytes(input), after: utf8Bytes(output) });
  return output;
}

export interface CompressOptions {
  minBytes?: number;
  simhashThreshold?: number;
  /** 停用词剥离（激进有损，默认关；Hetu stopwords 节点同款语义） */
  stopwords?: boolean;
}

/**
 * 管线入口：文本 + 工具上限 → 压缩结果。
 * ≤ minBytes 直通；否则跑节点 1-4，仍超限才 headtail。
 */
export function compressToolText(
  text: string,
  maxBytes: number,
  opts?: CompressOptions,
): CompressResult {
  const minBytes = opts?.minBytes ?? PIPELINE_MIN_BYTES;
  const originalBytes = utf8Bytes(text);
  const stats: PipelineNodeStat[] = [];
  if (originalBytes <= minBytes || originalBytes <= maxBytes) {
    return { text, stats, truncated: false, originalBytes, finalBytes: originalBytes };
  }
  let current = applyNode("foldStructuredBlobs", text, foldStructuredBlobs, stats);
  current = applyNode("dedupConsecutiveLines", current, dedupConsecutiveLines, stats);
  current = applyNode(
    "dedupNearDuplicateLines",
    current,
    (s) => dedupNearDuplicateLines(s, opts?.simhashThreshold ?? SIMHASH_HAMMING_THRESHOLD),
    stats,
  );
  current = applyNode("collapseWhitespace", current, collapseWhitespace, stats);
  current = applyNode("normalizeNumbers", current, normalizeNumbers, stats);
  if (opts?.stopwords) {
    current = applyNode("removeStopwords", current, removeStopwords, stats);
  }
  let postPipelineBytes = utf8Bytes(current);
  // 关键行抽取（自适应）：仅在去重后仍超上限（否则必被 headtail 盲截）时运行——
  // 用语义行保留替代盲目首尾截断；仍超限才落到 headtail
  if (postPipelineBytes > maxBytes) {
    current = applyNode("extractKeyLines", current, extractKeyLines, stats);
    postPipelineBytes = utf8Bytes(current);
    if (postPipelineBytes > maxBytes) {
      current = headtailKeepEnds(current, maxBytes, originalBytes, postPipelineBytes);
      return { text: current, stats, truncated: true, originalBytes, finalBytes: utf8Bytes(current) };
    }
    // 关键行抽取已压到限内：内容已折叠（stats 可见），不算 truncated
    return { text: current, stats, truncated: false, originalBytes, finalBytes: postPipelineBytes };
  }
  return { text: current, stats, truncated: false, originalBytes, finalBytes: postPipelineBytes };
}
