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

const { extractLatestTodos, extractTodoLists, todoProgress, selectVisibleCapsules } =
  await import("./todoProgress.ts");

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

// ---- extractTodoLists（归并口径，用户定稿 2026-10-08：
//      同一份清单原地实时更新；完成封存后才新开；显式空数组清空）----

test("extractTodoLists：同一份清单进度推进 → 原地更新，只有一个胶囊", () => {
  const messages = [
    todoEntry("t1", [
      { content: "步骤一", status: "pending" },
      { content: "步骤二", status: "pending" },
    ]),
    todoEntry("t2", [
      { content: "步骤一", status: "in_progress" },
      { content: "步骤二", status: "pending" },
    ]),
    todoEntry("t3", [
      { content: "步骤一", status: "completed" },
      { content: "步骤二", status: "completed" },
    ]),
  ];
  const lists = extractTodoLists(messages);
  assert.equal(lists.length, 1, "未完成清单推进只保留一个胶囊（不堆未完成）");
  assert.equal(lists[0].todos[0].status, "completed", "显示末次状态");
  assert.equal(lists[0].completed, true);
  // 条目内容集合不变 → key 恒定（关闭态得以延续）
  assert.equal(lists[0].key, JSON.stringify(["步骤一", "步骤二"].sort()));
});

test("extractTodoLists：中途加/删任务、改措辞 → 仍原地更新（同一胶囊）", () => {
  const messages = [
    todoEntry("t1", [{ content: "A", status: "pending" }]),
    todoEntry("t2", [
      { content: "A", status: "in_progress" },
      { content: "B", status: "pending" },
    ]), // 加任务
    todoEntry("t3", [
      { content: "A 的细化描述", status: "in_progress" },
      { content: "B", status: "pending" },
    ]), // 改措辞
  ];
  const lists = extractTodoLists(messages);
  assert.equal(lists.length, 1, "未完成期间的一切变化都原地刷新，不新开胶囊");
  assert.equal(lists[0].todos.length, 2);
  assert.equal(lists[0].todos[0].content, "A 的细化描述");
});

test("extractTodoLists：全部完成后 → 封存；再来含未完成项的新清单才新开", () => {
  const messages = [
    todoEntry("t1", [{ content: "甲", status: "completed" }]),
    todoEntry("t2", [{ content: "乙", status: "pending" }]),
  ];
  const lists = extractTodoLists(messages);
  assert.equal(lists.length, 2, "完成的封存、新工作新开");
  assert.equal(lists[0].completed, true, "旧胶囊是完成态（不会永远卡在未完成）");
  assert.equal(lists[1].completed, false);
  // 全完成后再来一份全完成清单 → 原地更新末个（不新开空壳）
  const done2 = extractTodoLists([
    ...messages,
    todoEntry("t3", [{ content: "乙", status: "completed" }]),
  ]);
  assert.equal(done2.length, 2, "仅状态推进到全完成 → 不新增胶囊");
  assert.equal(done2[1].completed, true);
});

test("extractTodoLists：不变式——除末个外其余胶囊必然都是已完成态", () => {
  const messages = [
    todoEntry("t1", [{ content: "批次1", status: "completed" }]),
    todoEntry("t2", [{ content: "批次2a", status: "completed" }]),
    todoEntry("t3", [{ content: "批次2a", status: "completed" }]),
    todoEntry("t4", [{ content: "批次3", status: "in_progress" }]),
  ];
  const lists = extractTodoLists(messages);
  for (let i = 0; i < lists.length - 1; i++) {
    assert.equal(lists[i].completed, true, `第 ${i} 个胶囊应为已完成态`);
  }
  assert.equal(lists[lists.length - 1].completed, false);
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

// ---- selectVisibleCapsules（UI 上限控量：最多 3 个，优先淘汰最老的已完成）----

const snap = (content, completed) => ({
  key: JSON.stringify([content]),
  todos: [{ content, status: completed ? "completed" : "pending" }],
  completed,
});

test("selectVisibleCapsules：不超上限原样返回（时间正序）", () => {
  const lists = [snap("a", true), snap("b", false)];
  assert.deepEqual(selectVisibleCapsules(lists, 3), lists);
  assert.deepEqual(selectVisibleCapsules([], 3), []);
});

test("selectVisibleCapsules：超出时淘汰最老的已完成，未完成的末个必留", () => {
  // 4 个：前三个已完成，末个进行中 → 应藏掉最老的"a"，保留 b/c/d
  const lists = [snap("a", true), snap("b", true), snap("c", true), snap("d", false)];
  const visible = selectVisibleCapsules(lists, 3);
  assert.equal(visible.length, 3);
  assert.deepEqual(
    visible.map((l) => l.todos[0].content),
    ["b", "c", "d"],
    "藏最老已完成、保留最新的进行中",
  );
  assert.equal(visible[visible.length - 1].completed, false, "进行中的末个永不被藏");
});

test("selectVisibleCapsules：多个已完成时从最老的开始淘汰", () => {
  const lists = [snap("a", true), snap("b", true), snap("c", true), snap("d", true), snap("e", false)];
  const visible = selectVisibleCapsules(lists, 3);
  assert.deepEqual(
    visible.map((l) => l.todos[0].content),
    ["c", "d", "e"],
    "超 2 个 → 淘汰最老的 a、b",
  );
});

test("selectVisibleCapsules：全部已完成（无进行中）时也按最老淘汰且不超上限", () => {
  const lists = [snap("a", true), snap("b", true), snap("c", true), snap("d", true)];
  const visible = selectVisibleCapsules(lists, 3);
  assert.equal(visible.length, 3);
  assert.deepEqual(
    visible.map((l) => l.todos[0].content),
    ["b", "c", "d"],
  );
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
