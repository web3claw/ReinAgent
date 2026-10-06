/**
 * 任务清单纯逻辑测试（todoProgress.ts）。
 * 运行：node --test src/lib/chat/taskProgress.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Node 直跑需 resolve 钩子补扩展名；bun 原生支持 .ts 且 1.4.x 无 registerHooks —— 动态导入 + 能力检测。
const { registerHooks } = await import("node:module");
if (typeof registerHooks === "function") registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
      const url = new URL(specifier, context.parentURL);
      if (!/\.[a-z0-9]+$/i.test(url.pathname)) {
        for (const ext of [".js", ".ts", ".mjs", ".json"]) {
          const candidate = new URL(url.href + ext);
          if (existsSync(fileURLToPath(candidate))) {
            return { url: candidate.href, shortCircuit: true };
          }
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const { extractLatestTodos, extractTodoLists, todoProgress } = await import("./todoProgress.ts");

const todoEntry = (id, todos) => ({
  id,
  role: "tool",
  toolName: "todo_write",
  toolCallId: `call-${id}`,
  args: { todos },
  status: "done",
  text: "",
  thinking: "",
  resultText: "",
  isError: false,
});

test("extractLatestTodos：取末条 todo_write（覆盖语义）", () => {
  const messages = [
    todoEntry("t1", [{ content: "旧项", status: "pending" }]),
    { id: "a1", role: "assistant", text: "x", thinking: "", status: "done" },
    todoEntry("t2", [
      { content: "新一", status: "completed" },
      { content: "新二", status: "in_progress" },
    ]),
  ];
  const todos = extractLatestTodos(messages);
  assert.equal(todos.length, 2, "应取末条清单而非合并");
  assert.equal(todos[0].content, "新一");
  assert.equal(todos[1].status, "in_progress");
});

test("extractLatestTodos：无清单/空清单/非法形状 → null（不渲染假进度）", () => {
  assert.equal(extractLatestTodos([]), null, "空时间线");
  assert.equal(
    extractLatestTodos([{ id: "a", role: "assistant", text: "hi", thinking: "", status: "done" }]),
    null,
    "无 todo 条目",
  );
  assert.equal(extractLatestTodos([todoEntry("t", [])]), null, "空清单不渲染");
  assert.equal(
    extractLatestTodos([{ id: "t", role: "tool", toolName: "todo_write", args: {}, status: "done", text: "", thinking: "", resultText: "", isError: false, toolCallId: "c" }]),
    null,
    "缺 todos 字段",
  );
});

test("extractLatestTodos：未知状态归一为 pending（不臆测）", () => {
  const todos = extractLatestTodos([todoEntry("t", [{ content: "x", status: "weird" }])]);
  assert.equal(todos[0].status, "pending");
});

test("todoProgress：done/total/current/percent 口径", () => {
  const p1 = todoProgress([
    { content: "a", status: "completed" },
    { content: "b", status: "in_progress" },
    { content: "c", status: "pending" },
    { content: "d", status: "completed" },
  ]);
  assert.equal(p1.total, 4);
  assert.equal(p1.done, 2);
  assert.equal(p1.current.content, "b");
  assert.equal(p1.percent, 50);

  const p2 = todoProgress([{ content: "a", status: "completed" }]);
  assert.equal(p2.percent, 100, "全完成即 100%");
  assert.equal(p2.current, null);

  const p3 = todoProgress([]);
  assert.equal(p3.percent, 0, "空清单 0%（不除零）");
});

// ---- extractTodoLists（多胶囊并排，用户定稿「按内容新增」口径，2026-10-06）----

test("extractTodoLists：内容不同 → 按时间正序各成一份快照", () => {
  const messages = [
    todoEntry("t1", [{ content: "清单一", status: "pending" }]),
    { id: "a1", role: "assistant", text: "x", thinking: "", status: "done" },
    todoEntry("t2", [
      { content: "清单二A", status: "pending" },
      { content: "清单二B", status: "in_progress" },
    ]),
  ];
  const lists = extractTodoLists(messages);
  assert.equal(lists.length, 2, "两份不同内容的清单各成一个快照");
  assert.equal(lists[0].todos[0].content, "清单一");
  assert.equal(lists[1].todos[1].content, "清单二B");
  assert.notEqual(lists[0].key, lists[1].key, "内容不同 key 必不同");
  assert.equal(JSON.parse(lists[1].key)[0].content, "清单二A", "key = 规范化内容的 JSON 签名");
});

test("extractTodoLists：内容相同的重复写入 → 不新增（同一份清单）", () => {
  const same = [
    { content: "步骤一", status: "completed" },
    { content: "步骤二", status: "in_progress" },
  ];
  const messages = [todoEntry("t1", same), todoEntry("t2", same)];
  assert.equal(extractTodoLists(messages).length, 1, "相同内容重复写入只保留一份");
  // 同轮进度推进（内容变化）→ 新增而非合并
  const progress = [
    todoEntry("t1", [{ content: "步骤一", status: "in_progress" }]),
    todoEntry("t2", [{ content: "步骤一", status: "completed" }]),
  ];
  assert.equal(extractTodoLists(progress).length, 2, "内容不同即新增（按内容新增口径）");
});

test("extractTodoLists：显式空数组 = 清空全部；缺字段 = 跳过不清空", () => {
  const base = [todoEntry("t1", [{ content: "甲", status: "pending" }])];
  assert.deepEqual(extractTodoLists([...base, todoEntry("t2", [])]), [], "显式空数组清空所有快照");
  const kept = extractTodoLists([
    ...base,
    { id: "t2", role: "tool", toolName: "todo_write", args: {}, status: "done", text: "", thinking: "", resultText: "", isError: false, toolCallId: "c" },
  ]);
  assert.equal(kept.length, 1, "缺 todos 字段跳过，既有快照保留");
  const dropped = extractTodoLists([...base, todoEntry("t2", [{ status: "pending" }])]);
  assert.equal(dropped.length, 1, "条目缺 content 的非法清单跳过，不清空");
});

test("extractLatestTodos：与 extractTodoLists 末条快照一致", () => {
  const messages = [
    todoEntry("t1", [{ content: "旧", status: "pending" }]),
    todoEntry("t2", [{ content: "新", status: "in_progress" }]),
  ];
  const lists = extractTodoLists(messages);
  const latest = extractLatestTodos(messages);
  assert.equal(latest.length, 1);
  assert.equal(latest[0].content, lists[lists.length - 1].todos[0].content);
  assert.equal(extractLatestTodos([todoEntry("t", [])]), null, "仅空清单 → null");
});
