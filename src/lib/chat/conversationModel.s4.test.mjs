/**
 * conversationModel / errors 的 S4 自动化验证。
 *
 * 覆盖：多轮上下文、中断、aborted vs error、错误映射、状态机（含中断转移）。
 * 用**真实** faux 事件流驱动（不是伪造事件数组），与 S2 的验证策略一致。
 *
 * 运行：node --test src/lib/chat/conversationModel.s4.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  appendUser,
  applyEvent,
  beginAssistant,
  finish,
  finishAborted,
  initialState,
  lastAssistant,
  toApiMessages,
} from "./conversationModel.js";
import { diagnoseError } from "./errors.js";

const faux = await import("@earendil-works/pi-ai/providers/faux");

/** 快速 faux core（tokensPerSecond=0 → 分块走 queueMicrotask）。 */
function makeCore() {
  return faux.createFauxCore({ api: "faux", tokensPerSecond: 0, tokenSize: { min: 1, max: 3 } });
}

/**
 * 模拟 useConversation.send 的一轮：用真实 faux 流驱动状态机。
 * 返回 { state, ctx }，其中 ctx 就是**实际传给 provider stream 的 Context**。
 */
async function driveTurn(core, state, userText, opts = {}) {
  const history = toApiMessages(state);
  history.push({ role: "user", content: userText, timestamp: Date.now() });
  const ctx = { messages: history };

  const events = core.stream(core.getModel(), ctx, opts);
  let next = beginAssistant(appendUser(state, userText));
  for await (const ev of events) next = applyEvent(next, ev);
  next = finish(next, await events.result());
  return { state: next, ctx };
}

/** 单轮快捷方式。 */
async function drive(core, response) {
  core.setResponses([response]);
  const { state } = await driveTurn(core, initialState(), "hi");
  return { state };
}

// ---------------------------------------------------------------------------
// 1) 多轮上下文
// ---------------------------------------------------------------------------

test("多轮：第二轮送给 stream() 的 Context.messages 含第一轮 user+assistant（权威对象）", async () => {
  const core = makeCore();
  core.setResponses([faux.fauxAssistantMessage("第一轮回答"), faux.fauxAssistantMessage("第二轮回答")]);

  // 捕获 provider 实际收到的 Context.messages。
  const seen = [];
  const origStream = core.stream;
  core.stream = (model, ctx, opts) => {
    seen.push(ctx.messages);
    return origStream(model, ctx, opts);
  };

  let state = initialState();
  state = (await driveTurn(core, state, "第一轮问题")).state;
  state = (await driveTurn(core, state, "第二轮问题")).state;

  assert.equal(seen.length, 2, "应发生两次 provider 调用");
  const second = seen[1];
  assert.equal(second.length, 3, `第二轮应收到 [user1, assistant1, user2] 共 3 条，实际 ${second.length}`);
  assert.equal(second[0].role, "user");
  assert.equal(second[0].content, "第一轮问题");
  assert.equal(second[1].role, "assistant");
  assert.equal(second[2].role, "user");
  assert.equal(second[2].content, "第二轮问题");

  // 第一轮的 assistant 必须是**权威 AssistantMessage**，而非残缺对象。
  const assistant1 = second[1];
  for (const key of ["api", "provider", "model", "usage", "stopReason", "timestamp"]) {
    assert.ok(key in assistant1, `回灌的助手消息应含字段 ${key}`);
  }

  // 两轮结束后，state 内共 4 条消息。
  assert.equal(state.messages.length, 4);
});

// ---------------------------------------------------------------------------
// 2) 中断（真实 AbortController）
// ---------------------------------------------------------------------------

test("中断：signal.abort() 后回 idle、保留已生成文本、不进入 error", async () => {
  const TEXT = "这是一段足够长的回复，用来在流式过程中途中断它，并确认已生成的文本被完整保留下来。";
  const core = faux.createFauxCore({ api: "faux", tokensPerSecond: 8, tokenSize: { min: 1, max: 1 } });
  core.setResponses([faux.fauxAssistantMessage(TEXT)]);

  const controller = new AbortController();
  const ctx = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
  const events = core.stream(core.getModel(), ctx, { signal: controller.signal });

  let state = beginAssistant(appendUser(initialState(), "hi"));
  let aborted = false;
  for await (const ev of events) {
    state = applyEvent(state, ev);
    if (!aborted && ev.type === "text_delta") {
      controller.abort();
      aborted = true;
    }
  }
  state = finish(state, await events.result());

  assert.equal(state.status, "idle", "中断后应回到 idle");
  assert.equal(state.error, undefined, "中断不应产生错误");
  const assistant = lastAssistant(state);
  assert.equal(assistant.status, "stopped", "助手消息应标注为已停止");
  assert.ok(assistant.text.length > 0, "已生成文本必须保留");
  assert.ok(TEXT.startsWith(assistant.text), "保留的应是已生成的前缀");
});

test("中断后的消息不进上下文：toApiMessages 跳过 stopped 助手消息", async () => {
  const { state } = await drive(makeCore(), faux.fauxAssistantMessage("部分内容", { stopReason: "aborted" }));
  const api = toApiMessages(state);
  assert.equal(api.length, 1, "stopped 的助手消息无 apiMessage，应被跳过");
  assert.equal(api[0].role, "user");
});

// ---------------------------------------------------------------------------
// 3) aborted 与 error 可区分
// ---------------------------------------------------------------------------

test("aborted 与 error 可区分：前者不报错，后者进 error 且文案可读", async () => {
  // aborted：faux 以 stopReason:"aborted" 下发 reason=aborted 的 error 事件。
  const aborted = await drive(makeCore(), faux.fauxAssistantMessage("部分内容", { stopReason: "aborted" }));
  assert.equal(aborted.state.status, "idle", "aborted 不应进入 error 状态");
  assert.equal(aborted.state.error, undefined, "aborted 不应有错误文案");
  assert.equal(lastAssistant(aborted.state).status, "stopped");
  assert.equal(lastAssistant(aborted.state).text, "部分内容", "aborted 前的文本应保留");

  // 真正错误：stopReason:"error" → 进 error，文案可读。
  const errored = await drive(
    makeCore(),
    faux.fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit" }),
  );
  assert.equal(errored.state.status, "error");
  assert.equal(lastAssistant(errored.state).status, "error");
  assert.ok(/429/.test(errored.state.error), `错误文案应含 429，实际：${errored.state.error}`);
  assert.ok(/请求过于频繁/.test(lastAssistant(errored.state).error), "应映射为可读中文");
});

// ---------------------------------------------------------------------------
// 4) 错误映射（与 scripts/smoke.mjs diagnose() 语义一致）
// ---------------------------------------------------------------------------

test("错误映射：401 / 429 / 网络 三类输入 → 三类不同中文提示", () => {
  const auth = diagnoseError("401 invalid api key");
  const rate = diagnoseError("429 rate limit exceeded");
  const net = diagnoseError("fetch failed");

  assert.ok(/鉴权失败/.test(auth), `401 → ${auth}`);
  assert.ok(/请求过于频繁/.test(rate), `429 → ${rate}`);
  assert.ok(/网络错误/.test(net), `网络 → ${net}`);

  assert.notEqual(auth, rate);
  assert.notEqual(rate, net);
  assert.notEqual(auth, net);

  // 兜底：未知错误不返回空串。
  assert.ok(/请求失败/.test(diagnoseError("some weird failure")));
  assert.ok(/请求失败/.test(diagnoseError(undefined)));
});

test("错误经模型收敛为可读文案（而非原始文本）", async () => {
  const { state } = await drive(
    makeCore(),
    faux.fauxAssistantMessage("", { stopReason: "error", errorMessage: "ENOTFOUND api.deepseek.com" }),
  );
  assert.equal(state.status, "error");
  assert.ok(/网络错误/.test(state.error), `实际：${state.error}`);
});

// ---------------------------------------------------------------------------
// 5) 状态机（含中断相关转移）
// ---------------------------------------------------------------------------

test("状态机：finishAborted 仅在 streaming 生效；非 streaming 原样返回", () => {
  const s0 = initialState();
  assert.equal(finishAborted(s0), s0, "非 streaming 时 finishAborted 应原样返回");

  let streaming = beginAssistant(appendUser(s0, "你好"));
  assert.equal(streaming.status, "streaming");
  streaming = finishAborted(streaming);
  assert.equal(streaming.status, "idle");
  assert.equal(lastAssistant(streaming).status, "stopped");
  assert.equal(streaming.error, undefined);

  // 已 idle 再 finishAborted → 原样返回。
  assert.equal(finishAborted(streaming), streaming);
});
