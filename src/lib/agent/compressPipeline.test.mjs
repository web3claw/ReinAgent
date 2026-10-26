/**
 * 压缩管线专项测试（ROADMAP ⑥）：5 节点 + SimHash + 硬守卫 + headtail。
 * 运行：node --test src/lib/agent/compressPipeline.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  compressToolText,
  foldStructuredBlobs,
  dedupConsecutiveLines,
  dedupNearDuplicateLines,
  collapseWhitespace,
  simhash64,
  hammingDistance,
  utf8Bytes,
  PIPELINE_MIN_BYTES,
  normalizeNumbers,
  scoreKeyLine,
  extractKeyLines,
  removeStopwords,
} = await import("./compressPipeline.ts");

// ① 小文本直通（含空串）——零开销零行为变化
test("小文本直通：≤minBytes 或 ≤maxBytes 原样返回", () => {
  for (const small of ["", "ok", "x".repeat(100), "中".repeat(200), "a".repeat(5000)]) {
    const r = compressToolText(small, 8192);
    assert.equal(r.text, small);
    assert.equal(r.truncated, false);
    assert.deepEqual(r.stats, []);
  }
  // 超过 minBytes 但未超工具上限：同样直通（管线只在原本会被截断时介入）
  const mid = "u".repeat(6000);
  assert.equal(compressToolText(mid, 8192).text, mid);
});

// ② 结构化折叠
test("foldStructuredBlobs：hex/base64/数字行折叠，正常代码与中文不受影响", () => {
  // ⚠ 样本必须区分字符集："A"×120 同时是合法 hex——base64 样本要含非 hex 字母
  const b64 = "QkFTRTY0QUNDT1VOVFJFR09JTg".repeat(5); // 130B 连续 base64 字符
  const hex = "a1b2c3d4".repeat(16); // 128 hex chars
  const digits = Array.from({ length: 60 }, (_, i) => i).join(", "); // ≥120 字符才触发行级数字折叠
  // 数字行必须独立成行（行级判定 /^[\d,\s]+$/——带前缀的行不折叠）
  const out = foldStructuredBlobs(`token: ${b64}\nsha: ${hex}\ncounts:\n${digits}`);
  assert.ok(out.includes("[folded:base64,130B]"), out);
  assert.ok(out.includes("[folded:hex,128B]"), out);
  assert.ok(out.includes("[folded:digits,"), out);
  // 正常内容不受影响
  const code = "const x = 42;\nconsole.log(中文输出);";
  assert.equal(foldStructuredBlobs(code), code);
  // 短 token 不折叠（日常单词安全）
  assert.equal(foldStructuredBlobs("ABCdef"), "ABCdef");
});

// ③ 连续重复行折叠
test("dedupConsecutiveLines：连续相同行折叠 ×N 计数准确；空白行重复静默收敛为单行", () => {
  const out = dedupConsecutiveLines(["retry", "retry", "retry", "done", "", ""].join("\n"));
  assert.equal(out, "retry\n…[repeated ×3]\ndone\n");
});

// ④ SimHash 近重复行
test("SimHash：同构日志（时间戳/计数不同）距离小，不同日志距离大", () => {
  const a = simhash64("2026-10-24T10:00:01 INFO worker heartbeat ok seq=12");
  const b = simhash64("2026-10-24T10:00:02 INFO worker heartbeat ok seq=13");
  const c = simhash64("ERROR Failed to connect database: timeout after 30s");
  assert.ok(hammingDistance(a, b) <= 3, `同构日志应近重复（实际 ${hammingDistance(a, b)}）`);
  assert.ok(hammingDistance(a, c) > 3, `不同日志不应误判（实际 ${hammingDistance(a, c)}）`);
});

test("dedupNearDuplicateLines：时间戳递增日志风暴折叠为一行+计数，不同行不受影响", () => {
  const storm = Array.from({ length: 50 }, (_, i) => `2026-10-24T10:00:${String(i).padStart(2, "0")} INFO worker heartbeat ok`);
  const unique = ["start", ...storm, "all done", "shutdown complete"];
  const out = dedupNearDuplicateLines(unique.join("\n"));
  assert.ok(out.includes("…[near-dup ×50]"), "50 行风暴应折叠");
  assert.ok(out.startsWith("start\n"), "前导独立行保留");
  assert.ok(out.includes("all done") && out.includes("shutdown complete"), "尾随独立行保留");
  // 逐行断言近重复行不折叠
  const diverse = ["alpha one", "beta two", "gamma three"].join("\n");
  assert.equal(dedupNearDuplicateLines(diverse), diverse);
});

// ⑤ 空白收敛
test("collapseWhitespace：3+ 空行收敛、行尾空白剥除", () => {
  assert.equal(collapseWhitespace("a\n\n\n\nb   \nc  "), "a\n\nb\nc");
});

// ⑥ 硬守卫：不可压缩文本零放大
test("硬守卫：每行唯一的不可压缩文本，字节恒不增", () => {
  const unique = Array.from({ length: 3000 }, (_, i) => `unique-line-${i}-payload-abcdefgh`).join("\n");
  const before = utf8Bytes(unique);
  const r = compressToolText(unique, 8192);
  assert.ok(r.finalBytes <= before, `最终 ≤ 原始（${r.finalBytes} vs ${before}）`);
  for (const s of r.stats) {
    assert.ok(s.after < s.before, `节点 ${s.node} 不得放大（${s.before} → ${s.after}）`);
  }
});

// ⑦ headtail：首尾保留 + UTF-8 安全
test("headtail：首部与尾部锚串都保留，CJK 不劈（无替换字符）", () => {
  // 每行唯一（行号素数扰动）——避免被近重复节点折叠短路，专测 headtail 本体
  // 字母也逐行变化（base36）——数字扰动会被 SimHash 归一化吞掉，必须变 token 集合
  // 每行含 error（关键行 +6）→ 关键行总量超预算 → extractKeyLines 如实退回原文 → 由 headtail 兜底
  const lines = Array.from({ length: 3000 }, (_, i) => `uniq ${i.toString(36)} ${(i * 7919).toString(36)} error line`);
  const text = `HEAD_ANCHOR_START\n${lines.join("\n")}\nTAIL_ANCHOR_END_错误堆栈在这`;
  const r = compressToolText(text, 8192);
  assert.equal(r.truncated, true);
  assert.ok(r.text.includes("HEAD_ANCHOR_START"), "首部锚保留");
  assert.ok(r.text.includes("TAIL_ANCHOR_END_错误堆栈在这"), "尾部锚必须保留（headtail 核心价值）");
  assert.ok(!r.text.includes("\uFFFD"), "不得产生替换字符");
  assert.ok(r.finalBytes <= 8192, `≤ 上限（实际 ${r.finalBytes}）`);
  assert.match(r.text, /…\[compressed: 原 \d+ 字节/);
});

// ⑧ 组合场景：200KB 真实形态日志
test("组合：日志风暴+base64+尾部关键行 → 压到 exec 30KB 内且尾部保留", () => {
  const parts = [];
  parts.push("=== boot ===");
  // 无 '=' 的连续 base64 字符串（'=' 会打断 80+ 连续段）
  const b64 = "QkFTRTY0QUNDT1VOVFJFR09JTg".repeat(30); // ~810B
  parts.push(`cert: ${b64}`);
  for (let i = 0; i < 3000; i++) {
    parts.push(`2026-10-24T12:${String(i % 60).padStart(2, "0")}:00 INFO request handled id=${100000 + i} ms=${i * 3 % 900}`);
  }
  parts.push("=== FATAL ===");
  parts.push("java.lang.OutOfMemoryError: Java heap space");
  parts.push("TAIL_MARKER_FINAL_STACKTRACE");
  const text = parts.join("\n");
  const total = utf8Bytes(text);
  assert.ok(total > 150_000, `前置：构造 ≥150KB（实际 ${total}）`);
  const r = compressToolText(text, 30_000);
  assert.ok(r.finalBytes <= 30_000, `压到 30KB 内（实际 ${r.finalBytes}）`);
  assert.ok(r.text.includes("TAIL_MARKER_FINAL_STACKTRACE"), "尾部关键行保留");
  assert.ok(r.text.includes("OutOfMemoryError"), "FATAL 行保留");
  assert.ok(r.stats.length >= 2, `至少两个节点生效（${r.stats.map((s) => s.node).join(",")}）`);
  const reduction = ((1 - r.finalBytes / total) * 100).toFixed(1);
  assert.ok(Number(reduction) > 80, `压缩率 >80%（实际 ${reduction}%）`);
});

// ===== v2 尾巴 ⑥：三新节点 =====

test("normalizeNumbers：≥3 位数字归一为 [N]，≤2 位保留", () => {
  assert.equal(normalizeNumbers("id=100000 port=8080 n=3"), "id=[N] port=[N] n=3");
  assert.equal(normalizeNumbers("v2 at 2026-10-26"), "v2 at [N]-10-26"); // 仅 ≥3 位归一（Hetu 同款）
});

test("scoreKeyLine：错误/结论/路径加分，流水行负分", () => {
  assert.ok(scoreKeyLine("error: build failed at src/main.rs") >= 8);
  assert.ok(scoreKeyLine("## 结论：使用方案 A 部署") >= 5); // 标题+决策，长度不受惩罚
  assert.ok(scoreKeyLine("waiting...") < 0);
  assert.equal(scoreKeyLine("   "), 0);
});

test("extractKeyLines：长文本保留首尾与关键行、折叠流水带标记", () => {
  const parts = ["HEAD_CONTEXT_LINE"];
  for (let i = 0; i < 200; i++) parts.push(`processing chunk ${i} all ok waiting`);
  parts.push("FATAL: panic at src/exec.rs:120 exit");
  parts.push("TAIL_SUMMARY_DONE");
  const text = parts.join("\n");
  const out = extractKeyLines(text);
  assert.ok(out.length < text.length, "应压缩");
  assert.ok(out.includes("HEAD_CONTEXT_LINE"), "首 3 行保留");
  assert.ok(out.includes("TAIL_SUMMARY_DONE"), "尾 3 行保留");
  assert.ok(out.includes("panic"), "错误行保留");
  assert.ok(out.includes("折叠"), "折叠标记存在");
  // 短文本 / 少行直通
  assert.equal(extractKeyLines("short"), "short");
  const few = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
  assert.equal(extractKeyLines(few), few);
});

test("removeStopwords：剥离虚词保留实词；管线默认关、显式开启生效", () => {
  assert.equal(removeStopwords("the quick fox 和 quick test"), " quick fox 和 quick test".replace(/ {2,}/g, " "));
  assert.ok(!removeStopwords("the and of").includes("the"));
  const big = Array.from({ length: 60 }, (_, i) => `plain flowing line number ${i} status ok`).join("\n") + "\nERROR: boom\nTAIL";
  const r1 = compressToolText(big, 800);
  assert.ok(!r1.stats.some((s) => s.node === "removeStopwords"), "默认不启用");
  const r2 = compressToolText(big, 800, { stopwords: true });
  assert.ok(Array.isArray(r2.stats), "显式开启不报错");
});
