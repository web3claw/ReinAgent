import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildWebRemoteControlMobileTaskHomeModel,
  compareWebRemoteControlTasksByTime,
  getWebRemoteControlTaskStatusClassName,
  getWorkspaceLatestUpdatedAt,
  groupWebRemoteControlTasksByWorkspace,
  sortWebRemoteControlTasksByTime,
} from "./taskHomeModel.ts";
import {
  getTaskTimelineGroupMessage,
  groupTaskTimelineItems,
  resolveTaskTimelineGroupKey,
} from "./timelineGroups.ts";

// ---------------- taskHomeModel ----------------

const workspaces = [
  { workspacePath: "E:/proj-a", label: "proj-a", kind: "local", workspacePurpose: "project" },
  { workspacePath: "E:/proj-b", label: "proj-b", kind: "local", workspacePurpose: "project" },
];

function task(overrides) {
  return {
    taskId: "t1",
    title: "任务一",
    workspacePath: "E:/proj-a",
    workspaceLabel: "proj-a",
    workspaceKind: "local",
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

test("buildWebRemoteControlMobileTaskHomeModel: 工作区分组 + 总数 + 默认展开活动工作区", () => {
  const model = buildWebRemoteControlMobileTaskHomeModel({
    activeTaskId: "t2",
    activeWorkspacePath: "E:/proj-a",
    sortBy: "updated",
    result: {
      workspaces,
      tasks: [
        task({ taskId: "t1" }),
        task({ taskId: "t2", workspacePath: "E:/proj-a" }),
        task({ taskId: "t3", workspacePath: "E:/proj-b", workspaceLabel: "proj-b" }),
      ],
      activeWorkspaceKey: "E:/proj-a",
      activeTaskId: "t2",
    },
  });
  assert.equal(model.totalTaskCount, 3);
  assert.equal(model.totalWorkspaceCount, 2);
  assert.equal(model.activeTaskId, "t2");
  assert.ok(model.defaultExpandedWorkspaceKeys.has("E:/proj-a"));
  const groupA = model.groups.find((g) => g.workspaceKey === "E:/proj-a");
  assert.equal(groupA.tasks.length, 2);
});

test("pinned 任务拆独立分区，普通列表不再重复", () => {
  const model = buildWebRemoteControlMobileTaskHomeModel({
    activeTaskId: null,
    activeWorkspacePath: "E:/proj-a",
    result: {
      workspaces,
      tasks: [task({ taskId: "p1", pinned: true }), task({ taskId: "t1" })],
    },
  });
  assert.equal(model.pinnedTasks.length, 1);
  assert.equal(model.pinnedTasks[0].taskId, "p1");
  const flat = model.groups.flatMap((g) => g.tasks);
  assert.ok(!flat.some((t) => t.taskId === "p1"));
  assert.equal(model.totalTaskCount, 2);
});

test("compareWebRemoteControlTasksByTime: 运行层置顶且按创建时间稳定排序", () => {
  const sorted = sortWebRemoteControlTasksByTime(
    [
      task({ taskId: "old-done", createdAt: 1, updatedAt: 50 }),
      task({ taskId: "running-b", createdAt: 10, updatedAt: 5, displayStatus: "running" }),
      task({ taskId: "running-a", createdAt: 20, updatedAt: 2, displayStatus: "running" }),
      task({ taskId: "new-done", createdAt: 2, updatedAt: 999 }),
    ],
    "updated",
  );
  assert.deepEqual(
    sorted.map((t) => t.taskId),
    // running 层 createdAt 倒序（running-a 更新创建 → 前面），非运行层 updatedAt 倒序
    ["running-a", "running-b", "new-done", "old-done"],
  );
});

test("比较器：非运行层 updatedAt 决胜；运行层禁止 updatedAt 决胜（稳定 tie-break taskId）", () => {
  const cmp = compareWebRemoteControlTasksByTime("updated");
  assert.ok(cmp(task({ taskId: "a", updatedAt: 10 }), task({ taskId: "b", updatedAt: 5 })) < 0);
  const runningCmp = compareWebRemoteControlTasksByTime("updated");
  const left = task({ taskId: "a", createdAt: 5, updatedAt: 1, displayStatus: "running" });
  const right = task({ taskId: "b", createdAt: 5, updatedAt: 999, displayStatus: "running" });
  // 运行层同 createdAt → taskId 倒序决胜（实现 = right.taskId.localeCompare(left.taskId)）
  assert.equal(runningCmp(left, right), "b".localeCompare("a"));
});

test("groupWebRemoteControlTasksByWorkspace: hasUnread 聚合 + 未知工作区任务忽略", () => {
  const groups = groupWebRemoteControlTasksByWorkspace({
    workspaces,
    tasks: [task({ taskId: "t1", unreadAt: 3000 }), task({ taskId: "ghost", workspacePath: "E:/nowhere" })],
  });
  const a = groups.find((g) => g.workspaceKey === "E:/proj-a");
  assert.equal(a.hasUnread, true);
  assert.equal(a.tasks.length, 1);
  const b = groups.find((g) => g.workspaceKey === "E:/proj-b");
  assert.equal(b.hasUnread, false);
  assert.equal(b.tasks.length, 0);
});

test("getWebRemoteControlTaskStatusClassName: 四态类名", () => {
  assert.match(getWebRemoteControlTaskStatusClassName("running"), /bg-accent/);
  assert.match(getWebRemoteControlTaskStatusClassName("completed"), /bg-success/);
  assert.match(getWebRemoteControlTaskStatusClassName("error"), /bg-destructive/);
  assert.match(getWebRemoteControlTaskStatusClassName("idle"), /bg-surface/);
});

test("getWorkspaceLatestUpdatedAt: 空数组 null，多任务取最大", () => {
  assert.equal(getWorkspaceLatestUpdatedAt([]), null);
  assert.equal(getWorkspaceLatestUpdatedAt([task({ updatedAt: 5 }), task({ updatedAt: 9 })]), 9);
});

// ---------------- timelineGroups ----------------

const NOW = new Date("2026-10-11T12:00:00+08:00").getTime();
const DAY = 24 * 60 * 60 * 1000;

test("resolveTaskTimelineGroupKey: 今天/昨天/前三天/更早", () => {
  assert.equal(resolveTaskTimelineGroupKey(NOW, NOW, "zh-CN").kind, "today");
  assert.equal(resolveTaskTimelineGroupKey(NOW - DAY, NOW, "zh-CN").kind, "yesterday");
  const three = resolveTaskTimelineGroupKey(NOW - 3 * DAY, NOW, "zh-CN");
  assert.equal(three.kind, "daysAgo");
  assert.equal(three.daysAgo, 3);
  // 45 天前（2026-08-27）早于上月起点（9-01）→ older；40 天前恰是 9-01 会落 lastMonth
  assert.equal(resolveTaskTimelineGroupKey(NOW - 40 * DAY, NOW, "zh-CN").kind, "lastMonth");
  assert.equal(resolveTaskTimelineGroupKey(NOW - 45 * DAY, NOW, "zh-CN").kind, "older");
});

test("resolveTaskTimelineGroupKey: 中文周一起始（本周/上周）", () => {
  // 2026-10-11 是周日。按 zh-CN（周起始=周一），本周一是 10-05。
  // 10-05（周一）距 now 6 天 → daysAgo 分支优先（dayDiff<=3 才截获，6 落周判断 → 本周）
  const tuesdayThisWeek = new Date("2026-10-06T10:00:00+08:00").getTime();
  const mondayThisWeek = new Date("2026-10-05T10:00:00+08:00").getTime();
  const sundayLastWeek = new Date("2026-10-04T10:00:00+08:00").getTime();
  assert.equal(resolveTaskTimelineGroupKey(tuesdayThisWeek, NOW, "zh-CN").kind, "thisWeek");
  assert.equal(resolveTaskTimelineGroupKey(mondayThisWeek, NOW, "zh-CN").kind, "thisWeek");
  assert.equal(resolveTaskTimelineGroupKey(sundayLastWeek, NOW, "zh-CN").kind, "lastWeek");
  // en-US（周起始=周日）对照：now=周日 10-11、item=周四 10-08（dayDiff=3→改 10-07，dayDiff=4）：
  // zh-CN 本周一=10-05 → 10-07 属本周；en-US 本周日=10-11 → 10-07 落上周
  const thursday = new Date("2026-10-07T10:00:00+08:00").getTime();
  assert.equal(resolveTaskTimelineGroupKey(thursday, NOW, "zh-CN").kind, "thisWeek");
  assert.equal(resolveTaskTimelineGroupKey(thursday, NOW, "en-US").kind, "lastWeek");
});

test("groupTaskTimelineItems: 同组聚合、daysAgo 键含天数", () => {
  const items = [
    task({ taskId: "a", updatedAt: NOW }),
    task({ taskId: "b", updatedAt: NOW - 3600_000 }),
    task({ taskId: "c", updatedAt: NOW - DAY }),
    task({ taskId: "d", updatedAt: NOW - 2 * DAY }),
  ];
  const groups = groupTaskTimelineItems(items, { sortBy: "updated", now: NOW, locale: "zh-CN" });
  assert.deepEqual(
    groups.map((g) => g.label.kind),
    ["today", "yesterday", "daysAgo"],
  );
  assert.equal(groups[0].items.length, 2);
});

test("getTaskTimelineGroupMessage: daysAgo 带占位值，其余按 kind 映射", () => {
  assert.deepEqual(getTaskTimelineGroupMessage({ kind: "daysAgo", daysAgo: 3 }), {
    id: "taskTimeline.daysAgo",
    values: { days: "3" },
  });
  assert.deepEqual(getTaskTimelineGroupMessage({ kind: "today" }), { id: "taskTimeline.today" });
});
