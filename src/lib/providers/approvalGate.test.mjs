/**
 * runAgentTurn 审批门的矩阵测试（createApprovalGate 直驱）。
 *
 * faux 数据源只会调用 list_dir（read 类），走 runAgentTurn 端到端覆盖不了
 * write/exec × plan/ask/edit/full 的完整矩阵，故按产品同款做法直驱导出的纯工厂。
 *
 * 运行：node --test src/lib/providers/approvalGate.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ---- 让裸 node 能解析「无扩展名的相对导入」（仅相对说明符，裸包不动）----
registerHooks({
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

// 必须在 registerHooks 之后：这是**真实**产品模块（唯一被测对象）。
const { createApprovalGate } = await import("./runAgentTurn.ts");

/** 构造 beforeToolCall 的上下文（只用门读取的字段：toolCall.id/name、args）。 */
function ctx(name, args = {}) {
  return { toolCall: { type: "toolCall", id: `call-${name}`, name, arguments: args }, args };
}

/** 带调用记录的协调器；request 按 script 顺序出队决策。 */
function scriptedCoordinator(script = []) {
  const requests = [];
  const allowedAlways = new Set();
  return {
    requests,
    allowedAlways,
    isAlwaysAllowed: (toolName) => allowedAlways.has(toolName),
    allowAlways: (toolName) => allowedAlways.add(toolName),
    request: (req) => {
      requests.push(req);
      const next = script.shift();
      return next === undefined ? Promise.resolve("allow") : Promise.resolve(next);
    },
  };
}

/** 断言结果为拦截（block 标志为真；reason 文案不参与比较）。 */
function assertBlocked(result, message) {
  assert.equal(result?.block, true, message);
}

/** 断言结果为放行（undefined 或无 block 标志）。 */
function assertAllowed(result, message) {
  assert.equal(result, undefined, message);
}

test("1 · 模式矩阵：plan 拦 write/exec 且不发请求；ask/edit/full 按语义放行或请求", async () => {
  // ---- plan：write/exec 一律 block，协调器零调用 ----
  const planCoord = scriptedCoordinator();
  const planGate = createApprovalGate("plan", planCoord);
  assertBlocked(await planGate(ctx("write_file", { path: "a.ts" })), "plan 应拦 write_file");
  assertBlocked(await planGate(ctx("edit_file", { path: "a.ts" })), "plan 应拦 edit_file");
  assertBlocked(await planGate(ctx("exec_command", { command: "ls" })), "plan 应拦 exec_command");
  assert.equal(planCoord.requests.length, 0, "plan 模式不得发起审批请求");
  assertAllowed(await planGate(ctx("read_file", { path: "a.ts" })), "plan 应放行 read_file");
  assertAllowed(await planGate(ctx("list_dir", {})), "plan 应放行 list_dir");

  // ---- ask：write/exec 都请求；read 直通 ----
  const askCoord = scriptedCoordinator(["allow", "reject"]);
  const askGate = createApprovalGate("ask", askCoord);
  assertAllowed(await askGate(ctx("write_file", { path: "a.ts" })), "ask + 批准 → 放行 write");
  assertBlocked(await askGate(ctx("exec_command", { command: "rm -rf /" })), "ask + 拒绝 → block exec");
  assert.deepEqual(askCoord.requests.map((r) => r.toolName), ["write_file", "exec_command"], "请求顺序与工具名");
  assertAllowed(await askGate(ctx("list_dir", {})), "ask 直通 read 类");
  assert.equal(askCoord.requests.length, 2, "read 类不得进入请求队列");

  // ---- edit：write 自动放行，exec 需请求 ----
  const editCoord = scriptedCoordinator(["allow"]);
  const editGate = createApprovalGate("edit", editCoord);
  assertAllowed(await editGate(ctx("write_file", { path: "a.ts" })), "edit 自动放行 write");
  assert.equal(editCoord.requests.length, 0, "edit 的 write 不得发请求");
  assertAllowed(await editGate(ctx("exec_command", { command: "ls" })), "edit + 批准 → 放行 exec");
  assert.equal(editCoord.requests.length, 1, "edit 的 exec 应恰好发一次请求");

  // ---- full：什么都不请求（runAgentTurn 在 full 下根本不注入门，这里双保险）----
  const fullCoord = scriptedCoordinator();
  const fullGate = createApprovalGate("full", fullCoord);
  assertAllowed(await fullGate(ctx("write_file", { path: "a.ts" })));
  assertAllowed(await fullGate(ctx("exec_command", { command: "ls" })));
  assert.equal(fullCoord.requests.length, 0, "full 模式零请求");
});

test("2 · 决策语义：always 写入免审集合；reject 的 block 带 reason；未知工具保守视为 write", async () => {
  const coord = scriptedCoordinator(["always", "allow"]);
  const gate = createApprovalGate("ask", coord);

  assert.equal(await gate(ctx("exec_command", { command: "ls" })), undefined, "always → 放行");
  assert.ok(coord.allowedAlways.has("exec_command"), "决策应写入免审集合");

  assert.equal(await gate(ctx("exec_command", { command: "ls" })), undefined, "免审集合命中 → 不再请求直接放行");
  assert.equal(coord.requests.length, 1, "免审命中不得再次发请求");

  assert.equal(
    await gate(ctx("some_unknown_tool", {})),
    undefined,
    "未知工具保守视为 write → ask 模式走请求（批准后放行）",
  );
  assert.equal(coord.requests.length, 2, "未知工具应恰好发一次请求");
  assert.equal(coord.requests[1].toolName, "some_unknown_tool", "请求应携带工具名");

  const rejectGate = createApprovalGate("ask", scriptedCoordinator(["reject"]));
  const rejected = await rejectGate(ctx("write_file", { path: "a.ts" }));
  assert.equal(rejected?.block, true, "拒绝必须 block");
  assert.match(rejected?.reason ?? "", /拒绝/, "block reason 应向模型说明被用户拒绝");
});

test("3 · 挂起期间 abort → 以 reject 收场（钩子尊重 abort signal，Promise 必定 settle）", async () => {
  // request 永不 resolve，模拟 UI 一直不点；abort 触发后门必须立即以 reject 放行。
  const coord = {
    requests: [],
    isAlwaysAllowed: () => false,
    allowAlways: () => undefined,
    request: () => new Promise(() => {}),
  };
  const gate = createApprovalGate("ask", coord);
  const controller = new AbortController();
  const pending = gate(ctx("write_file", { path: "a.ts" }), controller.signal);
  controller.abort();
  const result = await pending;
  assert.equal(result?.block, true, "abort 后应以 block 收场（Promise 必定 settle，不悬挂）");
});
