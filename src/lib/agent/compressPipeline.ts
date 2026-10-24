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
  const postPipelineBytes = utf8Bytes(current);
  if (postPipelineBytes > maxBytes) {
    current = headtailKeepEnds(current, maxBytes, originalBytes, postPipelineBytes);
    return { text: current, stats, truncated: true, originalBytes, finalBytes: utf8Bytes(current) };
  }
  return { text: current, stats, truncated: false, originalBytes, finalBytes: postPipelineBytes };
}
