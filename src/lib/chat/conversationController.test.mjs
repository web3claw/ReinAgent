/**
 * conversationController 的自动化验证（S4 二轮修复 A-1；S7-5 适配到 runAgentTurn）。
 *
 * 覆盖**编排层**（useConversation 抽出的纯逻辑）——这是上一轮 S4 测试的盲区：
 * 之前只直接驱动 conversationModel 状态机、自造 AbortController，未覆盖
 * 「send 的忙判定」这一交互。本文件用**真实** runTurn + faux 数据源复刻
 * `send → stop → 立即再 send` 序列，断言第二条消息真的被送到（或至少未被静默丢弃）。
 *
 * ★ S7-5 改动：库注入由 `streamChat`（返回事件流）换成 `runAgentTurn`（返回 RunTurnResult、
 *   事件经 `onEvent` 回传）。为「不绕过状态机」，本文件的假 `runAgentTurn` **内部调用
 *   真实的 `agentRuntime.runTurn`**，并把库事件经 `params.onEvent` 交给 controller ——
 *   controller 内部再喂给**真实**的 `conversationModel.applyLibraryEvent`。
 *   即：库循环是真的、状态机是真的，唯一被替换的是「Key/网络」这一层（用 faux）。
 *
 * 运行：node --test src/lib/chat/conversationController.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { initialState } from "./conversationModel.js";
import { createConversationController } from "./conversationController.js";
import { runTurn } from "../agent/agentRuntime.js";
import { getTools } from "../agent/tools.js";

const faux = await import("@earendil-works/pi-ai/providers/faux");

/** 默认 core 工厂：tokensPerSecond=0 → 分块走 queueMicrotask，测试快。 */
function defaultMakeCore() {
  return faux.createFauxCore({ api: "faux", tokensPerSecond: 0, tokenSize: { min: 1, max: 3 } });
}

/**
 * 构造被测编排器 + 其状态存储，并记录每次 agent 运行实际收到的 messages。
 * 假 `runAgentTurn` 用**真实** runTurn + faux 核心驱动（每轮一个**独立 core**，
 * 避免多轮之间 `setResponses` 互相踩踏），事件经 onEvent 交给真实状态机。
 */
function makeHarness(opts = {}) {
  const makeCore = opts.makeCore ?? defaultMakeCore;
  let state = initialState();
  const captured = [];

  const runAgentTurn = async (params) => {
    console.log("DEBUG harness entry: signal.aborted =", params.signal?.aborted);
    captured.push(params.messages);
    const core = makeCore();
    const lastUser = [...params.messages].reverse().find((m) => m.role === "user");
    const prompt = lastUser && typeof lastUser.content === "string" ? lastUser.content : "";
    core.setResponses([faux.fauxAssistantMessage(`回复：${prompt}`)]);
    return runTurn({
      model: core.getModel(),
      stream: (model, context, options) => {
        console.log("DEBUG faux stream: signal.aborted =", options?.signal?.aborted);
        return core.stream(model, context, options);
      },
      api: "faux",
      label: "faux",
      systemPrompt: params.systemPrompt,
      messages: params.messages,
      tools: getTools(),
      signal: params.signal,
      onEvent: (ev, sig) => params.onEvent(ev, sig),
    });
  };

  const ctrl = createConversationController({
    getState: () => state,
    setState: (updater) => {
      state = updater(state);
    },
    runAgentTurn,
    getOptions: () => ({ source: "faux", config: {}, systemPrompt: "sys" }),
  });

  return { ctrl, getState: () => state, captured };
}

/** 轮询等待状态离开 streaming。 */
async function waitUntilIdle(getState, timeoutMs = 3000) {
  const start = Date.now();
  while (getState().status === "streaming") {
    if (Date.now() - start > timeoutMs) throw new Error(`等待 idle 超时（>${timeoutMs}ms）`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------
// A-1 回归：send → stop → 立即再 send
// ---------------------------------------------------------------------------

test("竞态(A-1)：send → stop → 立即再 send，第二条必须被真正受理并送达", async () => {
  const { ctrl, getState } = makeHarness();

  assert.equal(ctrl.send("第一条：一条本应持续流式的问题描述"), true, "首条应被受理");

  // 立刻停止：此刻上一轮 IIFE 尚未走到 finally，旧实现里 abortRef 仍非空 ——
  // 正是「状态已 idle、按钮可用、却仍在忙」的竞态窗口。
  ctrl.stop();

  const accepted = ctrl.send("第二条：停止后立即追问");
  assert.equal(accepted, true, "stop 后立即再 send 必须被受理（旧实现会在此静默 return 吞掉输入）");

  // 第二条用户消息必须真的进入历史（不被静默丢弃）。
  const userTexts = getState()
    .messages.filter((m) => m.role === "user")
    .map((m) => m.text);
  assert.ok(
    userTexts.includes("第二条：停止后立即追问"),
    `第二条用户消息必须进入历史，实际：${JSON.stringify(userTexts)}`,
  );

  // 等待第二条这一轮真正流完。
  await waitUntilIdle(getState);
  const messages = getState().messages;
  const lastAssistant = messages[messages.length - 1];
  console.log("DEBUG race:", JSON.stringify({
    status: getState().status,
    stateError: getState().error,
    lastStatus: lastAssistant.status,
    lastError: lastAssistant.error,
    msgs: messages.map((m) => m.role + "/" + m.status + (m.error ? "(" + m.error + ")" : "")),
  }));
  // 关键：第二条的助手消息应正常 done，而非被上一轮的**陈旧中止事件**污染成 stopped。
  assert.equal(
    lastAssistant.status,
    "done",
    "第二条的助手消息应正常完成（陈旧流的事件必须被隔离，不得污染新一轮）",
  );
  assert.ok(
    lastAssistant.text.includes("第二条"),
    `第二条的回复应对应第二条输入，实际：${lastAssistant.text}`,
  );
  console.log("DEBUG race state.error:", JSON.stringify(getState().error), "| msgs:", getState().messages.map((m) => m.role + "/" + m.status).join(","));
  assert.equal(getState().status, "idle");
});

// ---------------------------------------------------------------------------
// 忙判定契约
// ---------------------------------------------------------------------------

test("忙判定：流式进行中的 send 返回 false，且不追加任何消息", async () => {
  const { ctrl, getState } = makeHarness({
    makeCore: () => faux.createFauxCore({ api: "faux", tokensPerSecond: 8, tokenSize: { min: 1, max: 1 } }),
  });

  assert.equal(ctrl.send("慢问题"), true);

  const before = getState().messages.length;
  const rejected = ctrl.send("这条应被拒");
  assert.equal(rejected, false, "流式中的 send 必须返回 false（供 Composer 决定是否清空输入）");
  assert.equal(getState().messages.length, before, "被拒的 send 不得追加任何消息");

  ctrl.stop();
  await waitUntilIdle(getState);
});

test("空文本：send('') 与 send('   ') 返回 false，且状态不变", () => {
  const { ctrl, getState } = makeHarness();
  assert.equal(ctrl.send(""), false);
  assert.equal(ctrl.send("    "), false);
  assert.equal(getState().messages.length, 0);
  assert.equal(getState().status, "idle");
});

// ---------------------------------------------------------------------------
// 正常完成 → 下一轮可继续
// ---------------------------------------------------------------------------

test("正常完成后再发送被受理；第二轮历史含第一轮的权威 assistant 对象", async () => {
  const { ctrl, getState, captured } = makeHarness();

  assert.equal(ctrl.send("第一问"), true);
  await waitUntilIdle(getState);
  assert.equal(getState().status, "idle");
  const firstAssistant = getState().messages[getState().messages.length - 1];
  assert.equal(firstAssistant.status, "done");

  assert.equal(ctrl.send("第二问"), true, "idle 后应可继续发送");
  await waitUntilIdle(getState);

  // 两次 agent 运行；第二次收到的 messages 应含 [user1, assistant1(权威), user2]。
  assert.equal(captured.length, 2, "应发生两次 agent 运行");
  const secondHistory = captured[1];
  console.log("DEBUG secondHistory:", JSON.stringify(secondHistory.map((m) => ({ role: m.role, text: String(m.content ?? m.text ?? "").slice(0, 20) }))));
  assert.equal(secondHistory.length, 3, `第二轮应收到 3 条历史，实际 ${secondHistory.length}`);
  assert.equal(secondHistory[0].role, "user");
  assert.equal(secondHistory[1].role, "assistant");
  for (const key of ["api", "provider", "model", "usage", "stopReason", "timestamp"]) {
    assert.ok(key in secondHistory[1], `回灌的助手消息应是权威 AssistantMessage（缺字段 ${key}）`);
  }

  const assistantCount = getState().messages.filter((m) => m.role === "assistant").length;
  assert.equal(assistantCount, 2);
});

// ---------------------------------------------------------------------------
// S7 · maxSteps 触顶 → 可见终止说明（本轮修复）
// ---------------------------------------------------------------------------
//
// 用一个**可控的假 runAgentTurn** 驱动 controller：它按真实库的顺序发事件
// （message_start → message_update → turn_end → agent_end），随后 resolve 出 runTurn
// 的返回值。这样状态机（**真实** applyLibraryEvent）照常收敛为 idle，我们只需在 resolve
// 值上切换 `maxStepsReached`。
//
// ★ 关键建模：触顶是**正常结束** —— `agent_end` **会**到达、`reachedAgentEnd === true`，
//   末条 assistant 的 `stopReason` 是**模型给的**（此处用 "toolUse"，库绝不会给 "maxSteps"）。
//   因此「触顶标注」必须落在 await 之后的**独立**分支，而非「保险收敛」分支。
function makeMaxStepsHarness(maxStepsReached) {
  let state = initialState();
  const runAgentTurn = async (params) => {
    params.onEvent({ type: "agent_start" });
    params.onEvent({ type: "message_start", message: { role: "assistant", content: [] } });
    params.onEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "触顶前已产出的内容。" },
    });
    params.onEvent({
      type: "turn_end",
      message: { role: "assistant", content: [{ type: "text", text: "触顶前已产出的内容。" }] },
      toolResults: [],
    });
    // 触顶是正常结束：agent_end 到达，末条 stopReason 是模型值 "toolUse"。
    params.onEvent({ type: "agent_end", messages: [{ role: "assistant", stopReason: "toolUse" }] });
    return {
      messages: [],
      aborted: false,
      reachedAgentEnd: true,
      maxStepsReached,
      stopReason: "toolUse",
    };
  };
  const ctrl = createConversationController({
    getState: () => state,
    setState: (updater) => {
      state = updater(state);
    },
    runAgentTurn,
    getOptions: () => ({ source: "faux", config: {}, systemPrompt: "sys" }),
  });
  return { ctrl, getState: () => state };
}

/** 让 await 之后的微任务落地（noteMaxSteps 在 resume 后的同一微任务里执行）。 */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("S7 · maxSteps 触顶：正常结束（agent_end 到达）后仍给末条助手打「已达最大步数」标注，且不卡 streaming", async () => {
  const { ctrl, getState } = makeMaxStepsHarness(true);
  assert.equal(ctrl.send("一个问题"), true);
  await waitUntilIdle(getState);
  await flush();

  assert.equal(getState().status, "idle", "触顶是正常结束：应收敛为 idle，不得卡在 streaming");
  const last = getState().messages[getState().messages.length - 1];
  assert.equal(last.role, "assistant");
  assert.equal(last.status, "done", "触顶**不得**改 status（否则会被 R13 剪枝 → 孤儿 toolResult）");
  assert.equal(last.truncatedBy, "maxSteps", "触顶必须给末条助手打上可见终止标注");
});

test("S7 · maxSteps 未触顶（反例）：末条助手**没有** truncatedBy", async () => {
  const { ctrl, getState } = makeMaxStepsHarness(false);
  assert.equal(ctrl.send("一个问题"), true);
  await waitUntilIdle(getState);
  await flush();

  assert.equal(getState().status, "idle");
  const last = getState().messages[getState().messages.length - 1];
  assert.equal(last.role, "assistant");
  assert.equal(last.truncatedBy, undefined, "未触顶时不得出现 maxSteps 标注");
});
