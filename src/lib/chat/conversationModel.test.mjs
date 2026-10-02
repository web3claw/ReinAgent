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
  restoreState,
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

test("restoreState 计数器盖过最大序号：压缩后 hydration 不得重生旧 id（UNIQUE 撞车回归）", () => {
  // compact 后的真实形状：summary(id compact-0) + 仅剩的 m10..m17（length=9 < 18）
  const messages = [
    { id: "compact-0", role: "assistant", text: "摘要", status: "done" },
    ...Array.from({ length: 8 }, (_, i) => ({
      id: `m${10 + i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      text: `x${i}`,
      status: "done",
    })),
  ];
  const restored = restoreState(messages);
  assert.equal(restored.messages.length, 9);
  assert.equal(
    restored.nextMessageSeq,
    18,
    "计数器必须是 max(mN)+1=18，而非数组长度 9",
  );

  // 追加用户消息 + 助手回合：id 必须从 m18 起，绝不与 hydrated 的 m10..m17 重合
  const withUser = appendUser(restored, "新消息", undefined, undefined);
  assert.equal(withUser.messages.at(-1).id, "m18");
  const withAssistant = beginAssistant(withUser, Date.now());
  assert.equal(withAssistant.messages.at(-1).id, "m19");

  // 无 mN 形状的 id（全部非数字）→ 回退 length，行为不劣化
  const exotic = restoreState([
    { id: "compact-0", role: "assistant", text: "a", status: "done" },
    { id: "compact-1", role: "assistant", text: "b", status: "done" },
  ]);
  assert.equal(exotic.nextMessageSeq, 2);
});

test("toApiMessages：孤儿 toolResult（对应 toolCall 已被压缩移除）不上送", () => {
  // 场景复现（线上 11148）：压缩把头部的 assistant toolCall 块删了，toolResult
  // 残留在历史里。上送会被上游以「tool calls and tool results do not match」整请求 400。
  const orphanResult = {
    id: "m-orphan",
    role: "toolResult",
    toolCallId: "call_orphan_1",
    content: [{ type: "text", text: "旧结果" }],
    timestamp: 3,
  };
  const state = {
    messages: [
      orphanResult, // 头部孤儿（压缩后 seq 0 就是它）
      {
        id: "m-u1",
        role: "user",
        text: "后续提问",
        thinking: "",
        status: "done",
        timestamp: 4,
      },
      {
        id: "m-a1",
        role: "assistant",
        text: "好的",
        thinking: "",
        status: "done",
        apiMessage: {
          role: "assistant",
          content: [{ type: "text", text: "好的" }],
          timestamp: 5,
        },
        timestamp: 5,
      },
    ],
    status: "idle",
  };

  const api = toApiMessages(state);
  const roles = api.map((m) => m.role);
  assert.ok(!roles.includes("toolResult"), "孤儿 toolResult 不得上送");
  assert.equal(api.filter((m) => m.role === "user").length, 1, "user 消息保留");
  assert.equal(api[api.length - 1].role, "assistant", "assistant 回复保留");
});

test("toApiMessages：正常配对的 toolCall/toolResult 完整保留", () => {
  const call = { type: "toolCall", id: "call_ok_1", name: "read_file", arguments: { p: "a.ts" } };
  const state = {
    messages: [
      { id: "m-u", role: "user", text: "读文件", thinking: "", status: "done", timestamp: 1 },
      {
        id: "m-a",
        role: "assistant",
        text: "",
        thinking: "",
        status: "done",
        apiMessage: {
          role: "assistant",
          content: [{ type: "text", text: "我来读" }, call],
          timestamp: 2,
        },
        timestamp: 2,
      },
      {
        id: "m-t",
        role: "tool",
        toolCallId: "call_ok_1",
        toolName: "read_file",
        text: "",
        thinking: "",
        status: "done",
        isError: false,
        apiMessage: {
          role: "toolResult",
          toolCallId: "call_ok_1",
          toolName: "read_file",
          content: [{ type: "text", text: "file body" }],
          timestamp: 3,
        },
        timestamp: 3,
      },
      {
        id: "m-a2",
        role: "assistant",
        text: "读到了",
        thinking: "",
        status: "done",
        apiMessage: {
          role: "assistant",
          content: [{ type: "text", text: "读到了" }],
          timestamp: 4,
        },
        timestamp: 4,
      },
    ],
    status: "idle",
  };

  const api = toApiMessages(state);
  assert.equal(api.length, 4);
  assert.equal(api[1].content.filter((b) => b.type === "toolCall").length, 1, "toolCall 保留");
  assert.equal(api[2].role, "toolResult", "toolResult 保留");
  assert.equal(api[3].role, "assistant");
});
