/**
 * stateBridge 的自动化验证（S4 三轮修复 P2-1）。
 *
 * 覆盖：同步推进、不丢更新，以及与 conversationController 的**集成**：
 *   - 同一 tick 内连续 send 只受理第一条（P2-1 回归）；
 *   - `send → stop → 立即再 send` 仍两条都受理（A-1 不回退）；
 *   - 两种提交语义（同步直写 / 批量提交）下 send 行为一致。
 *
 * 运行：node --test src/lib/chat/stateBridge.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { initialState } from "./conversationModel.js";
import { createStateBridge } from "./stateBridge.js";
import { createConversationController } from "./conversationController.js";
import { runTurn } from "../agent/agentRuntime.js";
import { getTools } from "../agent/tools.js";

const faux = await import("@earendil-works/pi-ai/providers/faux");

/**
 * 假 runAgentTurn：用**真实** runTurn + faux 驱动（每轮独立 core），库事件经 onEvent
 * 交给 controller → 真实 applyLibraryEvent。S7-5：库注入由 streamChat（事件流）
 * 换成 runAgentTurn（Promise<RunTurnResult> + onEvent）。
 */
function makeFauxRunAgentTurn() {
  return async (params) => {
    const core = faux.createFauxCore({ api: "faux", tokensPerSecond: 0, tokenSize: { min: 1, max: 3 } });
    const lastUser = [...params.messages].reverse().find((m) => m.role === "user");
    const prompt = lastUser && typeof lastUser.content === "string" ? lastUser.content : "";
    core.setResponses([faux.fauxAssistantMessage(`回复：${prompt}`)]);
    return runTurn({
      model: core.getModel(),
      stream: (model, context, options) => core.stream(model, context, options),
      api: "faux",
      label: "faux",
      systemPrompt: params.systemPrompt,
      messages: params.messages,
      tools: getTools(),
      signal: params.signal,
      onEvent: (ev, sig) => params.onEvent(ev, sig),
    });
  };
}

/** 用给定 bridge 构造编排器。 */
function makeController(bridge) {
  return createConversationController({
    getState: () => bridge.getState(),
    setState: (updater) => {
      bridge.setState(updater);
    },
    runAgentTurn: makeFauxRunAgentTurn(),
    getOptions: () => ({ source: "faux", config: {}, systemPrompt: "sys" }),
  });
}

async function waitUntilIdle(getState, timeoutMs = 3000) {
  const start = Date.now();
  while (getState().status === "streaming") {
    if (Date.now() - start > timeoutMs) throw new Error(`等待 idle 超时（>${timeoutMs}ms）`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const counts = (state) => ({
  users: state.messages.filter((m) => m.role === "user").length,
  assistants: state.messages.filter((m) => m.role === "assistant").length,
});

// ---------------------------------------------------------------------------
// 1) 同步推进
// ---------------------------------------------------------------------------

test("同步推进：同一 tick 内连续两次 setState，getState 已是第二次结果；commit 最后收到第二次的值", () => {
  const committed = [];
  const bridge = createStateBridge({
    initialState: initialState(),
    commit: (next) => committed.push(next),
  });

  bridge.setState((prev) => ({ ...prev, status: "streaming" }));
  // 第二次基于第一次之后的状态
  bridge.setState((prev) => ({ ...prev, status: "error", error: "boom" }));

  const now = bridge.getState();
  assert.equal(now.status, "error", "同 tick 内 getState 应已是第二次结果");
  assert.equal(now.error, "boom");
  assert.equal(committed.length, 2, "每次 setState 都应提交一次（值语义）");
  assert.equal(committed[committed.length - 1].status, "error", "commit 最后收到的应是第二次的值");
  assert.equal(committed[committed.length - 1], now, "commit 收到的值与 getState 一致（单点真相）");
});

// ---------------------------------------------------------------------------
// 2) 不丢更新
// ---------------------------------------------------------------------------

test("不丢更新：两次基于前一状态的 updater 叠加，最终真相为两次叠加结果", () => {
  const bridge = createStateBridge({ initialState: initialState(), commit: () => {} });

  bridge.setState((prev) => ({ ...prev, messages: [...prev.messages, { id: "m1", role: "user", text: "1", thinking: "", status: "done" }] }));
  bridge.setState((prev) => ({ ...prev, messages: [...prev.messages, { id: "m2", role: "user", text: "2", thinking: "", status: "done" }] }));

  const texts = bridge.getState().messages.map((m) => m.text);
  assert.deepEqual(texts, ["1", "2"], "两次 updater 必须叠加，而非后者按旧值覆盖");
});

// ---------------------------------------------------------------------------
// 3) 集成：P2-1 回归
// ---------------------------------------------------------------------------

test("集成(P2-1)：同一 tick 内 send(A)、send(B) 只受理第一条（不产生两条 streaming 助手）", async () => {
  const pending = [];
  const flush = () => {
    while (pending.length > 0) pending.shift();
  };
  const bridge = createStateBridge({
    initialState: initialState(),
    // 模拟「React 在 tick 末才提交」：值入队，flush 时才应用。
    commit: (next) => pending.push(next),
  });
  const ctrl = makeController(bridge);

  // 同一 tick、无 await、无 flush。
  const accepted = [ctrl.send("A"), ctrl.send("B")];

  assert.deepEqual(accepted, [true, false], "同 tick 连发只应受理第一条");
  const state = bridge.getState();
  assert.equal(counts(state).users, 1, "只应有一条 user 消息");
  assert.equal(counts(state).assistants, 1, "只应有一条 assistant 消息（旧的滞后真相会变成两条 streaming）");

  flush();
  await waitUntilIdle(() => bridge.getState());
});

// ---------------------------------------------------------------------------
// 4) A-1 不回归
// ---------------------------------------------------------------------------

test("A-1 不回归：send(A) → stop() → flush() → send(B) 两条都受理，B 进历史", async () => {
  const pending = [];
  let reactState = initialState();
  const bridge = createStateBridge({
    initialState: initialState(),
    commit: (next) => pending.push(next),
  });
  const flush = () => {
    while (pending.length > 0) reactState = pending.shift();
  };
  const ctrl = makeController(bridge);

  assert.equal(ctrl.send("A"), true, "首条应被受理");
  ctrl.stop(); // 同步：abort + finishAborted（bridge 真相同步推进到 idle）
  flush(); // 模拟 React 提交
  const okB = ctrl.send("B");
  assert.equal(okB, true, "停止后应能立即再发（A-1 不得回退）");

  const userTexts = bridge.getState()
    .messages.filter((m) => m.role === "user")
    .map((m) => m.text);
  assert.ok(userTexts.includes("A"), `A 应在历史中，实际：${JSON.stringify(userTexts)}`);
  assert.ok(userTexts.includes("B"), `B 应进历史，实际：${JSON.stringify(userTexts)}`);

  await waitUntilIdle(() => bridge.getState());
});

// ---------------------------------------------------------------------------
// 5) 两种提交语义下行为一致
// ---------------------------------------------------------------------------

test("send 在「同步直写」与「批量提交」两种提交语义下行为一致", async () => {
  async function run(commitMode) {
    const pending = [];
    let reactState = initialState();
    const bridge = createStateBridge({
      initialState: initialState(),
      commit: (next) => {
        if (commitMode === "batch") pending.push(next);
        else reactState = next;
      },
    });
    const flush = () => {
      while (pending.length > 0) reactState = pending.shift();
    };
    const ctrl = makeController(bridge);

    const accepted = [ctrl.send("A"), ctrl.send("B")];
    flush();
    await waitUntilIdle(() => bridge.getState());
    flush(); // 收尾提交：把流式过程中排队的若干次提交一并应用（batch 语义下 step-by-step 不入 React）

    const state = bridge.getState();
    return {
      accepted,
      users: counts(state).users,
      assistants: counts(state).assistants,
      finalStatus: state.status,
      reactSynced:
        reactState.status === state.status && reactState.messages.length === state.messages.length,
    };
  }

  const sync = await run("sync");
  const batch = await run("batch");

  assert.deepEqual(sync.accepted, [true, false], "首选应被受理、同 tick 第二条被拒");
  assert.deepEqual(sync.accepted, batch.accepted, "两种提交语义下受理结果应一致");
  assert.equal(sync.users, batch.users);
  assert.equal(sync.assistants, batch.assistants);
  assert.equal(sync.finalStatus, batch.finalStatus);
  assert.ok(sync.reactSynced && batch.reactSynced, "flush 后 React 侧状态应与真相一致");
});
