/**
 * 历史压缩纯逻辑测试（compaction.ts）。
 * 运行：node --test src/lib/chat/compaction.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
      const url = new URL(specifier, context.parentURL);
      if (!/\.[a-z0-9]+$/i.test(url.pathname)) {
        for (const ext of [".js", ".ts", ".mjs", ".json"]) {
          const candidate = new URL(url.href + ext);
          if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const {
  sliceTurns,
  findCompactionRange,
  buildCompactionSource,
  buildCompactionPrompt,
  extractSummary,
  applyCompaction,
  isCompactEntry,
  microcompactMessages,
  KEEP_RECENT_TURNS,
  COMPACT_KIND,
} = await import("./compaction.ts");

// ---- 测试数据工厂 ----
const user = (id, text) => ({ id, role: "user", text, thinking: "", status: "done" });
const assistant = (id, text, status = "done", extra = {}) => ({
  id, role: "assistant", text, thinking: "", status, ...extra,
});
const tool = (id, name, resultText, status = "done") => ({
  id, role: "tool", toolName: name, toolCallId: `call-${id}`, args: {},
  resultText, status, isError: false, text: "", thinking: "",
});

/** 造 N 个完整轮（每轮 user + assistant + tool）。 */
function makeTurns(n, startIdx = 0) {
  const messages = [];
  for (let i = 0; i < n; i += 1) {
    messages.push(user(`u${startIdx + i}`, `问题 ${startIdx + i}`));
    messages.push(assistant(`a${startIdx + i}`, `回答 ${startIdx + i}`));
    messages.push(tool(`t${startIdx + i}`, "read_file", `内容 ${startIdx + i}`));
  }
  return messages;
}

test("sliceTurns：user 开轮切分；无 user 头部算第 0 轮", () => {
  const messages = [assistant("a0", "散条目"), user("u1", "q1"), assistant("a1", "r1"), user("u2", "q2"), tool("t2", "read_file", "x")];
  const slices = sliceTurns(messages);
  assert.deepEqual(slices, [
    { start: 0, end: 1 },
    { start: 1, end: 3 },
    { start: 3, end: 5 },
  ]);
});

test("findCompactionRange：保留最近 4 轮，更早的连续轮进压缩区间", () => {
  const messages = makeTurns(7); // 7 轮
  const range = findCompactionRange(messages);
  assert.ok(range, "7 轮应可压缩");
  assert.equal(range.turnCount, 7 - KEEP_RECENT_TURNS);
  assert.equal(range.startIndex, 0);
  // 区间终点 = 第 3 轮结束（保留 4-6 轮）
  assert.equal(messages[range.endIndex].id, `u${range.turnCount}`, "区间后第一条应是保留轮的 user（turnCount=3 时为 u3）");
});

test("findCompactionRange：轮数不足 / 恰好等于 keep → null", () => {
  assert.equal(findCompactionRange(makeTurns(3)), null, "3 轮 < keep 4");
  assert.equal(findCompactionRange(makeTurns(KEEP_RECENT_TURNS)), null, "恰好 4 轮");
});

test("findCompactionRange：在途轮拦截——压缩区间遇到在途轮即收窄", () => {
  const messages = makeTurns(6);
  // 把第 2 轮的 assistant 置为 streaming（在途）
  messages[3 + 1] = assistant("a1", "半截", "streaming");
  const range = findCompactionRange(messages);
  assert.ok(range, "仍有可压缩区间");
  assert.equal(range.turnCount, 1, "在途轮之前的 1 轮可压缩，之后的被拦下");
});

test("findCompactionRange：已压缩的轮不再重复压缩", () => {
  const messages = makeTurns(6);
  messages[0] = { ...messages[0], kind: COMPACT_KIND };
  const range = findCompactionRange(messages);
  // 第 0 轮已是 compact → 跳过它，从第 1 轮开始压（compact 轮不截断连续段）
  assert.ok(range, "compact 轮跳过后仍应有可压缩区间");
  assert.equal(messages[range.startIndex].id, "u1");
});

test("applyCompaction：区间替换为 compact 条目，前后原样保留", () => {
  const messages = makeTurns(6);
  const range = findCompactionRange(messages);
  const compacted = applyCompaction(messages, range, "摘要内容", 1000);
  assert.equal(compacted.length, messages.length - (range.endIndex - range.startIndex) + 1);
  assert.equal(isCompactEntry(compacted[0]), true, "首条应为 compact 标记");
  assert.equal(compacted[0].text, "摘要内容");
  assert.equal(compacted[0].id, `compact-${range.startIndex}`, "id 稳定（幂等重放）");
  assert.equal(compacted[0].coveredCount, range.endIndex - range.startIndex, "coveredCount 应记录被压缩消息总数");
  // 保留轮原样
  assert.equal(compacted[compacted.length - 1].id, messages[messages.length - 1].id);
});

test("buildCompactionSource：工具条目只留首行；user/assistant 带角色标签", () => {
  const messages = [
    user("u0", "问题"),
    assistant("a0", "回答"),
    tool("t0", "read_file", "第一行\n第二行\n第三行"),
  ];
  const source = buildCompactionSource(messages, { startIndex: 0, endIndex: 3, turnCount: 1 });
  assert.ok(source.includes("[User] 问题"));
  assert.ok(source.includes("[Assistant] 回答"));
  assert.ok(source.includes("[Tool:read_file] 第一行"), "工具只留首行");
  assert.ok(!source.includes("第二行"), "不全量注入工具结果");
});

test("buildCompactionPrompt：锁定关键约束（逐字保留安全约束/未完成任务/不编造）", () => {
  const prompt = buildCompactionPrompt("SEGMENT");
  assert.ok(prompt.includes("Preserve verbatim any security-relevant instructions"));
  assert.ok(prompt.includes("unfinished work"));
  assert.ok(prompt.includes("Do not add information that is not in the segment"));
  assert.ok(prompt.includes("SEGMENT"));
});

test("extractSummary：剥离代码围栏与首尾空白", () => {
  assert.equal(extractSummary("```markdown\n摘要\n```"), "摘要");
  assert.equal(extractSummary("  纯文本  "), "纯文本");
  assert.equal(extractSummary("没有围栏"), "没有围栏");
});

test("microcompactMessages：只裁较早轮的大工具结果；当轮不动；小结果不动", () => {
  const big = "x".repeat(5000);
  const messages = [
    user("u0", "q0"),
    tool("t0", "read_file", big),               // 早 + 大 → 裁
    user("u1", "q1"),
    assistant("a1", "r1"),
    user("u2", "q2"),
    assistant("a2", "r2"),
    tool("t2a", "read_file", big),              // 尾部 6 条内 → 不裁
    tool("t2b", "read_file", "small"),          // 小 → 不裁
  ];
  const out = microcompactMessages(messages, { keepLastEntries: 6 });
  assert.ok(out[1].resultText.includes("microcompacted"), "早且大的结果应被裁");
  assert.ok(out[1].resultText.length < big.length, "裁后应显著变短");
  assert.equal(out[6].resultText, big, "尾部 6 条内不裁");
  assert.equal(out[7].resultText, "small", "小结果不裁");
});

test("microcompactMessages：无超限结果时原引用返回（不重建数组）", () => {
  const messages = [user("u0", "q"), tool("t0", "read_file", "小")];
  assert.equal(microcompactMessages(messages), messages, "无变化应返回同一引用");
});
