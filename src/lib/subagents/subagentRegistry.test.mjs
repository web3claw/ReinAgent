/**
 * subagentRegistry 测试（P1-6 增量）：生命周期 / 快照稳定性 / 微任务合并通知 /
 * stopRun 幂等 / controls 分离。
 * 运行：bun test src/lib/subagents/subagentRegistry.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  __resetForTests,
  finishRun,
  getRun,
  getRunSignal,
  getSubagentRunSnapshot,
  registerRun,
  stopRun,
  subscribeSubagentRuns,
  updateRun,
} from "./subagentRegistry.ts";

test("生命周期：register → finish，快照不可变更新", () => {
  __resetForTests();
  const before = getSubagentRunSnapshot();
  const id = registerRun({
    type: "Explore",
    description: "调研",
    prompt: "p",
    background: true,
    startedAt: 1000,
  });
  const during = getSubagentRunSnapshot();
  assert.notEqual(before, during, "登记后快照引用必须变化");
  assert.equal(during.length, 1);
  assert.equal(during[0].status, "running");
  assert.ok(id.startsWith("sub-"), `id 形态：${id}`);
  assert.ok(getRunSignal(id) instanceof AbortSignal, "后台运行有独立 AbortSignal");

  finishRun(id, "completed", { summary: "报告", toolUseCount: 2, durationMs: 500 });
  const after = getSubagentRunSnapshot();
  assert.equal(after[0].status, "completed");
  assert.equal(after[0].summary, "报告");
  assert.ok(after[0].endedAt, "收束时写 endedAt");
  assert.equal(getRunSignal(id), undefined, "收束后清理 controls");
  // 不可变：during 的对象未被原地改写
  assert.equal(during[0].status, "running", "旧快照对象保持 running（不可变更新）");
});

test("通知微任务合并：同步多次变更只触发一轮监听", async () => {
  __resetForTests();
  let calls = 0;
  const unsubscribe = subscribeSubagentRuns(() => {
    calls += 1;
  });
  const a = registerRun({ type: "Explore", description: "a", prompt: "p", background: false, startedAt: 1 });
  const b = registerRun({ type: "Explore", description: "b", prompt: "p", background: false, startedAt: 1 });
  updateRun(a, { summary: "x" });
  finishRun(b, "completed", { summary: "y" });
  assert.equal(calls, 0, "同步阶段不触发（微任务合并）");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 1, "同一同步流程的多笔变更合并为一轮通知");
  unsubscribe();
});

test("stopRun：后台运行可停（abort）；未知/已结束返回 false（幂等）", () => {
  __resetForTests();
  assert.equal(stopRun("nope"), false, "未知 id 幂等 false");
  const id = registerRun({ type: "Explore", description: "d", prompt: "p", background: true, startedAt: 1 });
  assert.equal(stopRun(id), true, "运行中后台可停");
  assert.equal(getRunSignal(id).aborted, true, "signal 已 abort");
  assert.equal(stopRun(id), true, "仍是 running 状态再次 stop 仍返回 true（引擎负责收束）");
  finishRun(id, "stopped", { summary: "" });
  assert.equal(stopRun(id), false, "已终态再 stop 幂等 false");
});
