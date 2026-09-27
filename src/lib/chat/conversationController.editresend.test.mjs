/**
 * conversationController.editResend / 重试对齐（LiveAgent 迁移）回归。
 *
 * 覆盖：
 *  1. editResend 硬截断：锚点前缀保留、原位替换新 user 条目（新 id）、其后旧分支全删；
 *  2. editResend 防呆：流式中拒绝、锚点不存在拒绝、原历史保持不变；
 *  3. editResend 清空轮次级字段（retryAttempts/retrying）并作为全新一轮重跑；
 *  4. 自动重试对齐 LiveAgent：已提交内容（text_delta）后的失败不再重试，直接收敛 error；
 *  5. 自动重试期间失败尝试的尾部 error 行不留在时间线（详情进重试记录）。
 *
 * 运行：node --test src/lib/chat/conversationController.editresend.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { initialState, toApiMessages } from "./conversationModel.js";
import { createConversationController } from "./conversationController.js";

/** 与 race.test.mjs 同款的可控假 runAgentTurn 编排器。 */
function makeHarness() {
  const calls = [];
  let state = initialState();
  const turnBeginIds = [];
  const controller = createConversationController({
    taskId: "task-1",
    onTurnBegin: (turnId) => turnBeginIds.push(turnId),
    getState: () => state,
    setState: (updater) => {
      state = updater(state);
    },
    runAgentTurn: (params) => {
      const call = { signal: params.signal, params, reachedAgentEnd: false };
      call.emit = (ev) => {
        if (ev && ev.type === "agent_end") call.reachedAgentEnd = true;
        return params.onEvent(ev, params.signal);
      };
      call.resolve = (overrides = {}) =>
        Promise.resolve({
          messages: [],
          aborted: params.signal.aborted,
          reachedAgentEnd: call.reachedAgentEnd,
          stopReason: undefined,
          errorMessage: undefined,
          ...overrides,
        });
      calls.push(call);
      return call.promise = new Promise((resolve) => { call.settle = resolve; });
    },
    getOptions: () => ({ source: "faux", config: {}, systemPrompt: "sys" }),
  });
  return { controller, getState: () => state, calls, turnBeginIds };
}

const settle = async (ticks = 8) => {
  for (let i = 0; i < ticks; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
/** 轮询等待重试退避走完、下一次尝试发出（并行负载下固定 sleep 会抖）。 */
const waitFor = async (predicate, deadlineMs = 3000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > deadlineMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
};
const projection = (state) =>
  state.messages.map((m) =>
    m.role === "tool" ? `tool/${m.status}` : `${m.role}/${m.status}:${m.text}`,
  );

test("editResend 硬截断：前缀保留 + 原位替换（新 id）+ 其后旧分支全删 + 全新一轮重跑", async () => {
  const { controller, getState, calls, turnBeginIds } = makeHarness();

  // 第一轮正常完成
  assert.equal(controller.send("第一问"), true);
  await settle();
  calls[0].emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
  calls[0].settle({ reachedAgentEnd: true });
  await settle();
  assert.equal(getState().status, "idle");

  // 第二轮进行到一半：助手正文已流出
  assert.equal(controller.send("第二问"), true);
  await settle();
  calls[1].emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
  calls[1].settle({ reachedAgentEnd: true });
  await settle();

  const before = projection(getState());
  assert.equal(before.length, 4, "两轮共 4 条");

  // 编辑第一轮的提问 → 其后（第一轮回复 + 第二轮全部）应被截断
  const anchorId = getState().messages[0].id;
  assert.equal(controller.editResend(anchorId, "第一问（改）"), true);
  await settle();

  const after = getState().messages;
  assert.equal(after.length, 2, "替换后的 user + 同步建的流式助手行（与 send 同构）");
  assert.equal(after[0].role, "user");
  assert.equal(after[0].text, "第一问（改）");
  assert.notEqual(after[0].id, anchorId, "替换条目必须是新 id（对齐 LiveAgent：新消息而非原地改写）");
  assert.equal(after[1].role, "assistant");
  assert.equal(after[1].status, "streaming", "替换后应立即开始新一轮流式");
  assert.equal(turnBeginIds.at(-1), after[0].id, "新轮 id 应打检查点轮边界");

  // 库的 message_start 见末条 assistant 正在 streaming → 不重复建行（兼容分支）
  calls[2].emit({ type: "message_start", message: { role: "assistant" } });
  await settle();
  assert.equal(getState().messages.length, 2, "message_start 不得重复建行");
  calls[2].emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
  calls[2].settle({ reachedAgentEnd: true });
  await settle();
  const history = calls[2].params.messages;
  assert.equal(history.length, 1, "重建历史只含替换后的 user");
  assert.equal(history[0].content, "第一问（改）");
});

test("editResend 防呆：流式中拒绝 / 锚点不存在拒绝 / 历史保持不变", async () => {
  const { controller, getState, calls } = makeHarness();

  assert.equal(controller.send("A"), true);
  await settle();
  // 流式中：拒绝且不追加任何消息
  const before = projection(getState());
  assert.equal(controller.editResend(getState().messages[0].id, "改"), false);
  assert.deepEqual(projection(getState()), before, "流式中编辑重发不得改动时间线");

  // 结束第一轮后：不存在的锚点拒绝
  calls[0].emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
  calls[0].settle({ reachedAgentEnd: true });
  await settle();
  assert.equal(controller.editResend("m999", "改"), false);
  assert.equal(controller.editResend(getState().messages[1].id, "改"), false, "assistant 不是合法切点（只能锚 user）");
  const after = projection(getState());
  assert.equal(after.length, 2, "拒绝路径不得改动历史");
});

test("editResend 清空轮次级重试状态并作为全新一轮开始", async () => {
  const { controller, getState, calls } = makeHarness();

  assert.equal(controller.send("A"), true);
  await settle();
  // 第一次尝试失败（可重试）→ 重试记录落账；第二次尝试失败（不可重试）→ 收敛 error
  calls[0].settle({ reachedAgentEnd: false, errorMessage: "429 rate limit exceeded" });
  await settle();
  assert.ok(
    await waitFor(() => calls.length >= 2),
    "前置：退避后第二次尝试应已发起",
  );
  assert.ok((getState().retryAttempts?.length ?? 0) >= 1, "前置：第一轮应已有重试记录");
  calls[1].settle({ reachedAgentEnd: false, errorMessage: "401 unauthorized" });
  await settle();
  assert.equal(getState().status, "error", "前置：第一轮应已收敛为错误终态");

  const anchorId = getState().messages[0].id;
  assert.equal(controller.editResend(anchorId, "A（重问）"), true);
  await settle();
  assert.equal(getState().retryAttempts?.length ?? 0, 0, "编辑重发必须清空上一轮的重试记录");
  assert.notEqual(getState().retrying, true, "编辑重发不得残留重试中标记");
  assert.equal(getState().status, "streaming");
});

test("自动重试对齐 LiveAgent：已提交内容后的失败不再重试，直接收敛 error", async () => {
  const { controller, getState, calls } = makeHarness();

  assert.equal(controller.send("A"), true);
  await settle();
  calls[0].emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "部分内容" } });
  calls[0].settle({ reachedAgentEnd: false, errorMessage: "502 bad gateway" });
  await settle();
  await settle();

  assert.equal(calls.length, 1, "已提交内容的失败不得发起第二次调用（重发会造成重复）");
  assert.equal(getState().status, "error");
  const last = getState().messages.at(-1);
  assert.equal(last.status, "error");
  assert.equal(last.text, "部分内容", "已流出的部分内容保留在错误行上");
});

test("自动重试期间：失败尝试的尾部 error 行不留在时间线（详情进重试记录）", async () => {
  const { controller, getState, calls } = makeHarness();

  assert.equal(controller.send("A"), true);
  await settle();
  // 第一次尝试失败（无内容提交）→ 可重试
  calls[0].settle({ reachedAgentEnd: false, errorMessage: "502 bad gateway" });
  await settle();
  assert.ok(
    await waitFor(() => calls.length >= 2),
    "前置：退避后第二次尝试应已发起",
  );

  assert.ok(calls.length >= 2, "第二次尝试应已发起");
  const visible = projection(getState());
  assert.equal(
    visible.some((row) => row.startsWith("assistant/error")),
    false,
    `失败尝试的 error 行不得残留在时间线（实际：${JSON.stringify(visible)}）`,
  );
  assert.ok((getState().retryAttempts?.length ?? 0) >= 1, "失败详情进重试记录");
  // 对齐 LiveAgent onRetryRecovered：新尝试产出首个内容之前，「重新连接中」副行
  // （retrying 标记）必须持续显示——连接+等待期间不得闪现后消失。
  assert.equal(getState().retrying, true, "重试尝试进行中（无内容）副行应保持显示");

  // 新尝试产出首个内容事件 → 撤下副行
  calls[1].emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } });
  await settle();
  assert.equal(getState().retrying, false, "首个内容到达后副行应撤下");

  // 尝试成功收敛 → 时间线只有 user + 一条 done 助手
  calls[1].emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
  calls[1].settle({ reachedAgentEnd: true });
  await settle();
  assert.deepEqual(projection(getState()), ["user/done:A", "assistant/done:ok"]);
});

test("toApiMessages：中止 assistant 及其后随工具条目一并剔除（对齐 LiveAgent stripAborted）", () => {
  const state = {
    messages: [
      { id: "m0", role: "user", text: "第一问", thinking: "", status: "done" },
      {
        id: "m1", role: "assistant", text: "", thinking: "", status: "done",
        apiMessage: { role: "assistant", content: [{ type: "text", text: "答" }], stopReason: "stop" },
      },
      { id: "m2", role: "user", text: "第二问", thinking: "", status: "done" },
      {
        id: "m3", role: "assistant", text: "", thinking: "", status: "stopped",
        apiMessage: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "write_file" }], stopReason: "aborted" },
      },
      {
        id: "tool:call-1", role: "tool", toolCallId: "call-1", toolName: "write_file",
        status: "error", resultText: "用户已中止", isError: true,
        apiMessage: { role: "toolResult", toolCallId: "call-1", toolName: "write_file", content: [{ type: "text", text: "用户已中止" }], isError: true },
      },
      { id: "m4", role: "user", text: "第三问", thinking: "", status: "done" },
    ],
    status: "idle",
    nextMessageSeq: 5,
  };
  const out = toApiMessages(state);
  const roles = out.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "user", "user"], "stopped assistant 与其后 toolResult 必须剔除，后面的 user 保留");
});
