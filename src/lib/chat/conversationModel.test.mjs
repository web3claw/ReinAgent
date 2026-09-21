/**
 * conversationModel 的自动化验证。
 *
 * 用 Node 内置 `node:test` 驱动**真实**的 faux 事件流（不是伪造的事件数组），
 * 从而把「流式累积是否正确」变成可回归的断言。
 *
 * 运行：node --test src/lib/chat/conversationModel.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyEvent,
  beginAssistant,
  finish,
  initialState,
  isStreaming,
  lastAssistant,
  toApiMessages,
  appendUser,
} from "./conversationModel.js";

const faux = await import("@earendil-works/pi-ai/providers/faux");

/**
 * 用给定的脚本化响应驱动一次完整流，返回最终 state 与事件序列。
 * faux 的 tokensPerSecond=0 → 分块走 queueMicrotask，测试快速。
 */
async function drive(response) {
  const core = faux.createFauxCore({
    api: "faux",
    tokensPerSecond: 0,
    tokenSize: { min: 1, max: 3 },
  });
  core.setResponses([response]);

  const events = core.stream(
    core.getModel(),
    { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    {},
  );

  let state = appendUser(initialState(), "hi");
  state = beginAssistant(state);

  const seen = [];
  for await (const ev of events) {
    seen.push(ev.type);
    state = applyEvent(state, ev);
  }
  const final = await events.result();
  state = finish(state, final);

  return { state, final, seen };
}

test("流式累积正确：逐事件 applyEvent 后正文 === 期望全文，且与权威消息一致", async () => {
  const TEXT = "你好，我是 ReinAgent，一个桌面 AI 对话客户端。";
  const { state, final, seen } = await drive(faux.fauxAssistantMessage(TEXT));

  const assistant = lastAssistant(state);
  assert.ok(assistant, "应存在助手消息");
  assert.equal(assistant.text, TEXT, "累积正文应等于期望全文");
  assert.equal(state.status, "idle", "正常结束后应回到 idle");

  // 事件序列形态：以 start 开头、含多个 text_delta、以 done 结尾。
  assert.equal(seen[0], "start");
  assert.ok(seen.filter((t) => t === "text_delta").length >= 2, "应收到多个 text_delta（逐字）");
  assert.equal(seen[seen.length - 1], "done");

  // 契约：累积文本 === 权威 finalMessage 的 text 块拼接。
  const authoritative = final.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  assert.equal(assistant.text, authoritative, "累积正文应与权威消息一致");

  // 多轮上下文：历史应包含 user + assistant（复用权威 apiMessage）。
  const apiMessages = toApiMessages(state);
  assert.equal(apiMessages.length, 2);
  assert.equal(apiMessages[0].role, "user");
  assert.equal(apiMessages[1].role, "assistant");
});

test("思考块不污染正文：正文不含思考文本，思考累积到独立字段", async () => {
  const THINK = "先想一下：用户问 6 乘 7 等于多少。";
  const ANSWER = "答案是 42。";
  const { state } = await drive(
    faux.fauxAssistantMessage([faux.fauxThinking(THINK), faux.fauxText(ANSWER)]),
  );

  const assistant = lastAssistant(state);
  assert.ok(assistant);
  assert.equal(assistant.text, ANSWER, "正文应只含 text 块");
  assert.ok(!assistant.text.includes(THINK), "正文不得包含思考文本");
  assert.equal(assistant.thinking, THINK, "思考应累积到独立字段");
  assert.equal(state.status, "idle");
});

test("错误路径：stopReason=error 时进入 error 状态且错误信息可读", async () => {
  const { state } = await drive(
    faux.fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 invalid api key" }),
  );

  assert.equal(state.status, "error", "应进入 error 状态");
  assert.match(String(state.error), /401/, "error 应包含 401");
  const assistant = lastAssistant(state);
  assert.equal(assistant.status, "error");
  assert.match(String(assistant.error), /401/);
});

test("状态机合法性：合法转移正确，非法转移被忽略", () => {
  // idle 起始。
  const s0 = initialState();
  assert.equal(s0.status, "idle");
  assert.equal(s0.messages.length, 0);

  // 非法：未开始就 finish → 原样返回。
  const s1 = finish(s0, undefined, "boom");
  assert.equal(s1.status, "idle", "未开始就结束应被忽略");
  assert.equal(s1.messages.length, 0);

  // 非法：未开始就 applyEvent → 原样返回。
  const s2 = applyEvent(s0, { type: "text_delta", contentIndex: 0, delta: "x", partial: {} });
  assert.equal(s2.messages.length, 0, "未开始就应用事件应被忽略");

  // 合法：idle → streaming → idle。
  let s3 = appendUser(s0, "你好");
  assert.equal(s3.status, "idle");
  s3 = beginAssistant(s3);
  assert.equal(s3.status, "streaming");
  assert.ok(isStreaming(s3));

  // 非法：streaming 中再次 beginAssistant → 原样返回（不会多出消息）。
  const s4 = beginAssistant(s3);
  assert.equal(s4.messages.length, s3.messages.length, "streaming 中重复 begin 应被忽略");

  // 合法：以 done(message) 收敛回 idle。
  const doneMessage = faux.fauxAssistantMessage("好的。");
  s3 = finish(s3, doneMessage);
  assert.equal(s3.status, "idle");
  assert.equal(lastAssistant(s3).text, "好的。");

  // 非法：已 idle 再 finish → 原样返回。
  const s5 = finish(s3, doneMessage);
  assert.equal(s5, s3, "已 idle 再 finish 应原样返回");
});
