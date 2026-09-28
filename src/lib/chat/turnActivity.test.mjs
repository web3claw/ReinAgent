import test from "node:test";
import assert from "node:assert/strict";
import {
  groupTurns,
  formatWorkDuration,
  resolveTurnWorkState,
  turnDurationMs,
  isAttentionRequired,
  effectiveWorkMs,
  computeDiffStat,
  toolKindLabel,
  toolKindCode,
  toolArgPath,
  toolArgCommand,
} from "./turnActivity.ts";

const msg = (id, role, text, status = "done", extra = {}) => ({ id, role, text, status, ...extra });

// ---- groupTurns：按用户提问切轮 ----

test("groupTurns 用户开轮，assistant/tool 归入当前轮", () => {
  const timeline = [
    msg("u1", "user", "Q1"),
    msg("a1", "assistant", "A1"),
    msg("t1", "tool", "", "done"),
    msg("a2", "assistant", "A2"),
    msg("u2", "user", "Q2"),
    msg("a3", "assistant", "A3"),
  ];
  const turns = groupTurns(timeline);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].key, "u1");
  assert.equal(turns[0].activity.length, 3);
  assert.equal(turns[0].lastAssistant.id, "a2");
  assert.equal(turns[1].key, "u2");
  assert.equal(turns[1].activity.length, 1);
});

test("groupTurns 无 user 消息的历史数据也能成轮（key 用首条活动 id）", () => {
  const turns = groupTurns([msg("a1", "assistant", "A")]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].key, "a1");
  assert.equal(turns[0].userMessage, undefined);
});

test("groupTurns 运行判定与工时聚合", () => {
  const timeline = [
    msg("u1", "user", "Q"),
    msg("a1", "assistant", "", "done", { startedAt: 1000, endedAt: 2000 }),
    msg("t1", "tool", "", "running", { startedAt: 2500 }),
  ];
  const [turn] = groupTurns(timeline);
  assert.equal(turn.running, true, "工具执行中 → 轮运行中");
  assert.equal(turn.startedAt, 1000, "工时起点取最早 startedAt");
  assert.equal(turn.endedAt, undefined, "运行中不产出 endedAt");
});

test("groupTurns 完成轮工时取最早开始 / 最晚结束", () => {
  const timeline = [
    msg("u1", "user", "Q"),
    msg("t1", "tool", "", "done", { startedAt: 1500, endedAt: 3000 }),
    msg("a1", "assistant", "A", "done", { startedAt: 1000, endedAt: 4000 }),
  ];
  const [turn] = groupTurns(timeline);
  assert.equal(turn.running, false);
  assert.equal(turn.startedAt, 1000);
  assert.equal(turn.endedAt, 4000);
});

// ---- resolveTurnWorkState / turnDurationMs：状态条三态 + No-Fallback ----

test("resolveTurnWorkState：运行中/完成/已停止/无时长四态", () => {
  const running = groupTurns([msg("u", "user", "Q"), msg("a", "assistant", "", "streaming", { startedAt: 1000 })])[0];
  assert.equal(resolveTurnWorkState(running), "running");

  const completed = groupTurns([msg("u", "user", "Q"), msg("a", "assistant", "A", "done", { startedAt: 1000, endedAt: 3500 })])[0];
  assert.equal(resolveTurnWorkState(completed), "completed");

  const stopped = groupTurns([msg("u", "user", "Q"), msg("a", "assistant", "部分", "stopped")])[0];
  assert.equal(resolveTurnWorkState(stopped), "stopped");

  const legacy = groupTurns([msg("u", "user", "Q"), msg("a", "assistant", "A", "done")])[0];
  assert.equal(resolveTurnWorkState(legacy), "no-duration", "历史消息无打点 → 已处理，绝不伪造时长");
});

test("turnDurationMs：运行中按 now 现算，完成按 endedAt 冻结", () => {
  const running = groupTurns([msg("u", "user", "Q"), msg("a", "assistant", "", "streaming", { startedAt: 1000 })])[0];
  assert.equal(turnDurationMs(running, 4600), 3600);
  const completed = groupTurns([msg("u", "user", "Q"), msg("a", "assistant", "A", "done", { startedAt: 1000, endedAt: 3500 })])[0];
  assert.equal(turnDurationMs(completed, 999999), 2500, "完成态不吃当前时钟");
  const legacy = groupTurns([msg("u", "user", "Q"), msg("a", "assistant", "A", "done")])[0];
  assert.equal(turnDurationMs(legacy), undefined);
});

// ---- formatWorkDuration：最多两段非零单位 ----

test("formatWorkDuration 中文：分秒两段", () => {
  assert.equal(formatWorkDuration((3 * 60 + 48) * 1000), "3 分 48 秒");
});

test("formatWorkDuration 整秒进位与单段", () => {
  assert.equal(formatWorkDuration(500), "1 秒");
  assert.equal(formatWorkDuration(59_000), "59 秒");
  assert.equal(formatWorkDuration(60_000), "1 分");
});

test("formatWorkDuration 最多保留两段最靠前非零单位", () => {
  // 1天2时3分4秒 → 取「1 天 2 时」
  const ms = ((1 * 24 + 2) * 3600 + 3 * 60 + 4) * 1000;
  assert.equal(formatWorkDuration(ms), "1 天 2 时");
});

test("formatWorkDuration 英文紧凑单位", () => {
  assert.equal(formatWorkDuration((3 * 60 + 48) * 1000, "en-US"), "3m 48s");
});

// ---- computeDiffStat：+N/－N 行数口径 ----

test("computeDiffStat edit_file 按 old/new 行数统计", () => {
  const stat = computeDiffStat("edit_file", { old_string: "a\nb\nc", new_string: "x\ny" });
  assert.deepEqual(stat, { added: 2, removed: 3 });
});

test("computeDiffStat write_file 全新增", () => {
  assert.deepEqual(computeDiffStat("write_file", { content: "l1\nl2" }), { added: 2, removed: 0 });
});

test("computeDiffStat 其余工具与空参数返回 null", () => {
  assert.equal(computeDiffStat("read_file", { path: "/a" }), null);
  assert.equal(computeDiffStat("edit_file", { old_string: "", new_string: "" }), null);
  assert.equal(computeDiffStat("edit_file", null), null);
});

// ---- toolKindLabel / toolKindCode / 参数提取 ----

test("toolKindLabel 已知工具映射，未知工具如实回退原名", () => {
  assert.equal(toolKindLabel("read_file"), "读取");
  assert.equal(toolKindLabel("exec_command", "en-US"), "Terminal");
  assert.equal(toolKindLabel("mystery_tool"), "mystery_tool");
  assert.equal(toolKindCode("exec_command"), "exec");
  assert.equal(toolKindCode("mystery_tool"), "generic");
});

test("toolArgPath / toolArgCommand 提取字符串参数", () => {
  assert.equal(toolArgPath({ path: "/a/b.txt" }), "/a/b.txt");
  assert.equal(toolArgPath({ path: "  " }), undefined);
  assert.equal(toolArgCommand({ command: "ls -la" }), "ls -la");
  assert.equal(toolArgCommand(null), undefined);
});

// ---- computeLineDiff：行级 LCS diff ----

import { computeLineDiff, computeToolDiffLines, DIFF_MAX_LINES } from "./turnActivity.ts";

test("computeLineDiff 相同文本全为 context", () => {
  const diff = computeLineDiff("a\nb", "a\nb");
  assert.deepEqual(diff.map((l) => l.type), ["context", "context"]);
});

test("computeLineDiff 替换：先删后增", () => {
  const diff = computeLineDiff("a\nb\nc", "a\nx\nc");
  assert.deepEqual(diff.map((l) => l.type), ["context", "removed", "added", "context"]);
  assert.equal(diff[1].text, "b");
  assert.equal(diff[2].text, "x");
});

test("computeLineDiff 插入与删除", () => {
  assert.deepEqual(
    computeLineDiff("a\nc", "a\nb\nc").map((l) => l.type),
    ["context", "added", "context"],
  );
  assert.deepEqual(
    computeLineDiff("a\nb\nc", "a\nc").map((l) => l.type),
    ["context", "removed", "context"],
  );
});

test("computeLineDiff CRLF 归一化且吞掉结尾换行噪声", () => {
  assert.deepEqual(computeLineDiff("a\r\nb\r\n", "a\nb").map((l) => l.type), ["context", "context"]);
});

test("computeLineDiff 空串与全删全增", () => {
  assert.deepEqual(computeLineDiff("", "x\ny").map((l) => l.type), ["added", "added"]);
  assert.deepEqual(computeLineDiff("x\ny", "").map((l) => l.type), ["removed", "removed"]);
  assert.deepEqual(computeLineDiff("", ""), []);
});

test("computeLineDiff 行数上限保护", () => {
  const big = Array.from({ length: 600 }, (_, i) => `l${i}`).join("\n");
  const diff = computeLineDiff("", big);
  assert.equal(diff.length, DIFF_MAX_LINES);
});

// ---- computeDiffStat 升级为 LCS 精确口径 ----

test("computeDiffStat 公共行计为 context（不再粗估总行数）", () => {
  const stat = computeDiffStat("edit_file", { old_string: "a\nb\nc", new_string: "a\nx\nc" });
  assert.deepEqual(stat, { added: 1, removed: 1 });
});

// ---- computeToolDiffLines：工具卡 diff 视图数据 ----

test("computeToolDiffLines edit/write 有数据，其余为 null", () => {
  const edit = computeToolDiffLines("edit_file", { old_string: "a", new_string: "b" });
  assert.equal(edit.length, 2);
  const write = computeToolDiffLines("write_file", { content: "l1\nl2" });
  assert.equal(write.length, 2);
  assert.equal(computeToolDiffLines("read_file", { path: "/a" }), null);
  assert.equal(computeToolDiffLines("edit_file", { old_string: "", new_string: "" }), null);
});

// ---- A1：attention 判据（挂起审批 / 等人类工具） ----

test("isAttentionRequired：pendingApproval 非空即 true（会话级最强信号）", () => {
  const turns = groupTurns([msg("u1", "user", "Q"), msg("a1", "assistant", "A", "done")]);
  assert.equal(isAttentionRequired(turns[0], { toolName: "write_file" }), true);
  assert.equal(isAttentionRequired(turns[0], null), false);
  assert.equal(isAttentionRequired(turns[0], undefined), false);
});

test("isAttentionRequired：running 的等人类工具为 true；done/其他工具为 false", () => {
  const running = groupTurns([
    msg("u1", "user", "Q"),
    msg("t1", "tool", "", "running", { toolName: "ask_user", args: {} }),
  ]);
  assert.equal(isAttentionRequired(running[0], null), true, "running 的 ask_user 表示在等用户");

  const done = groupTurns([
    msg("u1", "user", "Q"),
    msg("t1", "tool", "", "done", { toolName: "ask_user", args: {} }),
  ]);
  assert.equal(isAttentionRequired(done[0], null), false, "已回答完的 ask_user 不再要人介入");

  const other = groupTurns([
    msg("u1", "user", "Q"),
    msg("t1", "tool", "", "running", { toolName: "exec_command", args: {} }),
  ]);
  assert.equal(isAttentionRequired(other[0], null), false, "普通工具运行中不属于 attention");
});

test("isAttentionRequired：exit_plan_mode 运行中为 true（计划待批）", () => {
  const turns = groupTurns([
    msg("u1", "user", "Q"),
    msg("t1", "tool", "", "running", { toolName: "exit_plan_mode", args: {} }),
  ]);
  assert.equal(isAttentionRequired(turns[0], null), true);
});

// ---- A1：隐藏窗口停表（effectiveWorkMs） ----

test("effectiveWorkMs：无隐藏时段 = 墙钟；隐藏段被扣除", () => {
  assert.equal(effectiveWorkMs(1000, 6000, []), 5000, "无隐藏即墙钟");
  // 全程隐藏 → 工时 0
  assert.equal(effectiveWorkMs(1000, 6000, [[1000, 6000]]), 0);
  // 半程隐藏 → 扣一半
  assert.equal(effectiveWorkMs(1000, 6000, [[2000, 4000]]), 3000);
});

test("effectiveWorkMs：隐藏段按与 [start, now] 的交集裁剪（乱序/越界容忍）", () => {
  // 隐藏段起点早于轮起点 / 终点晚于当前：只计交集
  assert.equal(effectiveWorkMs(5000, 10_000, [[0, 7000]]), 3000);
  assert.equal(effectiveWorkMs(5000, 10_000, [[8000, Number.POSITIVE_INFINITY]]), 3000);
  // 乱序多段：先远端后近端
  assert.equal(effectiveWorkMs(0, 10_000, [[7000, 9000], [1000, 3000]]), 6000);
});

test("effectiveWorkMs：非法区间（hi<=lo）不计；结果不为负", () => {
  assert.equal(effectiveWorkMs(0, 1000, [[500, 400]]), 1000, "倒置区间不计");
  assert.equal(effectiveWorkMs(0, 1000, [[0, 5000]]), 0, "超长隐藏段封顶为 0 而非负");
});
