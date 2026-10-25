/**
 * 看板模型纯函数测试：状态机镜像 / 简报组装 / run 终态分流。
 * 运行：node --test src/lib/kanban/kanban.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  KANBAN_COLUMNS,
  isValidTransition,
  triggersExecution,
  buildCardBrief,
  resolveRunVerdict,
  priorityBarClass,
} = await import("./model.ts");

test("状态机：白名单合法迁移", () => {
  assert.equal(isValidTransition("Backlog", "Todo"), true);
  assert.equal(isValidTransition("Todo", "InProgress"), true);
  assert.equal(isValidTransition("InProgress", "InReview"), true);
  assert.equal(isValidTransition("InReview", "Done"), true);
  assert.equal(isValidTransition("InReview", "Todo"), true, "评论重跑");
  assert.equal(isValidTransition("Blocked", "Todo"), true);
  assert.equal(isValidTransition("Done", "Archived"), true);
  assert.equal(isValidTransition("Archived", "Backlog"), true);
  assert.equal(isValidTransition("Todo", "Todo"), true, "同列=no-op");
});

test("状态机：非法迁移拒绝（与 Rust 白名单一致）", () => {
  assert.equal(isValidTransition("Backlog", "Done"), false);
  assert.equal(isValidTransition("Todo", "Done"), false, "必须经 InReview");
  assert.equal(isValidTransition("Done", "InProgress"), false);
  assert.equal(isValidTransition("Blocked", "Done"), false);
  assert.equal(isValidTransition("Archived", "Done"), false);
  assert.equal(isValidTransition("InReview", "Backlog"), false);
});

test("状态机：Todo 是唯一执行触发点", () => {
  assert.equal(triggersExecution("Todo"), true);
  for (const col of KANBAN_COLUMNS) {
    if (col === "Todo") continue;
    assert.equal(triggersExecution(col), false, `${col} 不应触发执行`);
  }
});

test("简报：标题/描述/优先级/无人值守约定", () => {
  const brief = buildCardBrief(
    { title: "修复登录 Bug", description: "用户反馈 401", priority: "high", workspacePath: "/repo", column: "Todo" },
    [],
  );
  assert.ok(brief.includes("# 看板任务：修复登录 Bug"));
  assert.ok(brief.includes("用户反馈 401"));
  assert.ok(brief.includes("优先级：高"));
  assert.ok(brief.includes("工作区：/repo"));
  assert.ok(brief.includes("无人值守"));
  assert.ok(brief.includes("阻塞"), "说明提问会被标阻塞");
  assert.ok(!brief.includes("历史评论"), "无评论不渲染该节");
});

test("简报：评论按时间追加，超长截断如实标注", () => {
  const brief = buildCardBrief(
    { title: "T", description: "", priority: "medium", workspacePath: "", column: "Todo" },
    [
      { author: "user", body: "请补充性能数据" },
      { author: "agent", body: "已补充" },
      { author: "user", body: "x".repeat(2500) },
    ],
  );
  assert.ok(brief.includes("## 历史评论"));
  assert.ok(brief.indexOf("请补充性能数据") < brief.indexOf("已补充"), "时间顺序");
  assert.ok(brief.includes("…[truncated]"), "超长评论截断标注");
});

test("终态分流：awaitingDecision → blocked/Blocked（automation 轮询修不掉的场景）", () => {
  const v = resolveRunVerdict({ taskId: "t1", outcome: "done", awaitingDecision: true });
  assert.equal(v.runStatus, "blocked");
  assert.equal(v.nextColumn, "Blocked");
  assert.ok(v.reason.includes("等待你的回答"));
});

test("终态分流：done → succeeded/InReview；error → failed/Blocked", () => {
  const ok = resolveRunVerdict({ taskId: "t1", outcome: "done" });
  assert.equal(ok.runStatus, "succeeded");
  assert.equal(ok.nextColumn, "InReview");
  const bad = resolveRunVerdict({ taskId: "t1", outcome: "error", error: "401 unauthorized" });
  assert.equal(bad.runStatus, "failed");
  assert.equal(bad.nextColumn, "Blocked");
  assert.equal(bad.error, "401 unauthorized");
  const empty = resolveRunVerdict({ taskId: "t1", outcome: "stopped" });
  assert.equal(empty.runStatus, "failed");
  assert.ok(empty.error.length > 0, "无错误文本时给兜底说明");
});

test("优先级色条：四档映射且未知回退", () => {
  assert.equal(priorityBarClass("urgent"), "bg-red-500");
  assert.equal(priorityBarClass("high"), "bg-amber-500");
  assert.equal(priorityBarClass("medium"), "bg-blue-500");
  assert.equal(priorityBarClass("low"), "bg-slate-400");
  assert.equal(priorityBarClass("unknown"), "bg-slate-400");
});
