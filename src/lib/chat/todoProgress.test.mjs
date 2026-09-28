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

const { extractLatestTodos, todoProgress } = await import("./todoProgress.ts");

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
