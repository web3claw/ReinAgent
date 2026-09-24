/**
 * conversationModel 的 **S7** 自动化验证（库事件 → 时间线）。
 * =====================================================================
 * 主战场是**集成测试**：用真实的 `agentRuntime.runTurn()` + pi-ai **faux** 驱动，
 * 在 `onEvent` 回调里把库事件喂给 `applyLibraryEvent`，跑完断言最终 state。
 * 这样「多步工具循环 / 收敛点 / 文本下钻 / 中止」都变成可回归的事实，而不是伪造事件数组。
 *
 * 覆盖（对应 S7-4 规格 §4）：
 *   1. 两步工具循环的完整时间线 [user, assistant, tool, assistant]；
 *   2. ★ 收敛点判别：turn_end / tool_execution_end 时刻仍 streaming，只有 agent_end 后停；
 *   3. ★ 文本下钻一层的判别：第 2 轮助手正文被正确累积；
 *   4. 工具失败路径 → 条目 error、循环继续、收敛 idle；
 *   5. 中止于「工具执行中」：agent_end 仍到达、条目非 running、toApiMessages 末条非 assistant；
 *   6. B-2 合成 toolResult 单测（不经 faux）；
 *   7. R13 剔除末尾「非完成态」assistant 单测（不经 faux）；
 *   8. 容忍乱序 / 重复事件；
 *   9. toApiMessages 既有行为不回归（纯文本单轮 → [user, assistant]）。
 *
 * 运行：node --test src/lib/chat/conversationModel.s7.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Type } from "typebox";

import {
  appendUser,
  applyLibraryEvent,
  beginAssistant,
  initialState,
  isStreaming,
  lastAssistant,
  toApiMessages,
} from "./conversationModel.js";
import { runTurn } from "../agent/agentRuntime.js";
import { getTools } from "../agent/tools.js";

// 运行时从 provider 子入口加载 faux（仅 Node 测试用；不经 Vite，不拖入桶文件）。
const faux = await import("@earendil-works/pi-ai/providers/faux");

/** 造一个 faux core（api 固定 "faux"，与 S7-1 工厂 api 对齐）。 */
function makeFaux() {
  return faux.createFauxCore({ api: "faux", tokenSize: { min: 1, max: 3 } });
}

/** 一行用户消息。 */
function userMessage(text) {
  return { role: "user", content: text, timestamp: 1 };
}

/** faux 的 provider 级 stream（原样转发给 core.stream）。 */
function fauxStream(core) {
  return (model, context, options) => core.stream(model, context, options);
}

/** 用真实 runTurn 驱动一次对话；`onEvent` 里把库事件喂给状态机。返回最终 state 与事件表。 */
async function driveLibrary({ responses, tools, userText, signal, onEventExtra }) {
  const core = makeFaux();
  core.setResponses(responses);
  const model = core.getModel();

  let state = beginAssistant(appendUser(initialState(), userText));
  /** 事件表：{ type, streaming } —— 在每个事件应用后记录「此刻是否仍 streaming」。 */
  const table = [];

  const result = await runTurn({
    model,
    stream: fauxStream(core),
    api: "faux",
    label: "faux",
    messages: [userMessage(userText)],
    tools,
    signal,
    onEvent: (ev) => {
      state = applyLibraryEvent(state, ev);
      table.push({ type: ev.type, streaming: isStreaming(state) });
      if (onEventExtra) onEventExtra(ev, state);
    },
  });

  return { state, table, result };
}

// ---------------------------------------------------------------------------
// 1 · 两步工具循环的完整时间线
// ---------------------------------------------------------------------------
test("1 · 两步工具循环：时间线 [user, assistant, tool, assistant]，工具条目已完成", async () => {
  const { state, result } = await driveLibrary({
    responses: [
      faux.fauxAssistantMessage([faux.fauxToolCall("list_dir", { path: "." }, { id: "call_time_1" })]),
      faux.fauxAssistantMessage([faux.fauxText("已经拿到当前时间了。")]),
    ],
    tools: getTools(),
    userText: "现在几点？",
  });

  assert.equal(result.reachedAgentEnd, true, "应到达 agent_end");

  const roles = state.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "tool", "assistant"], `实际时间线：${roles.join(",")}`);

  const tool = state.messages[2];
  // Node 测试环境无 Tauri IPC：list_dir 的 execute 抛错，条目如实进入 error 状态。
  assert.equal(tool.status, "error", "工具条目应为 error（Node 下无 Tauri）");
  assert.equal(tool.toolCallId, "call_time_1", "toolCallId 应与工具调用一致");
  assert.equal(tool.toolName, "list_dir", "toolName 应正确");
  assert.equal(tool.isError, true, "执行失败应为错误");
  assert.ok(typeof tool.resultText === "string" && tool.resultText.length > 0, "resultText 应非空");
  assert.ok(tool.apiMessage, "工具条目应带权威 ToolResultMessage");
  assert.equal(tool.apiMessage.role, "toolResult");
  assert.equal(tool.apiMessage.toolCallId, "call_time_1");

  assert.equal(isStreaming(state), false, "结束后应收敛为 idle");
  assert.equal(state.status, "idle");
});

// ---------------------------------------------------------------------------
// 2 · ★ 收敛点判别（本步最重要的一条）
// ---------------------------------------------------------------------------
test("2 · ★ 收敛点：turn_end / tool_execution_end 时刻仍 streaming，只有 agent_end 后为 false", async () => {
  const { table, state } = await driveLibrary({
    responses: [
      faux.fauxAssistantMessage([faux.fauxToolCall("list_dir", { path: "." }, { id: "c1" })]),
      faux.fauxAssistantMessage([faux.fauxText("完成。")]),
    ],
    tools: getTools(),
    userText: "hi",
  });

  const turnEnds = table.filter((r) => r.type === "turn_end");
  const toolEnds = table.filter((r) => r.type === "tool_execution_end");
  assert.ok(turnEnds.length >= 1, "应至少有一次 turn_end");
  assert.ok(toolEnds.length >= 1, "应至少有一次 tool_execution_end");

  for (const row of [...turnEnds, ...toolEnds]) {
    assert.equal(row.streaming, true, `${row.type} 时刻不得收敛（应仍 streaming）`);
  }

  const agentEnds = table.filter((r) => r.type === "agent_end");
  assert.equal(agentEnds.length, 1, "agent_end 应恰好一次");
  assert.equal(agentEnds[0].streaming, false, "agent_end 后必须收敛为 idle");

  assert.equal(isStreaming(state), false);
});

// ---------------------------------------------------------------------------
// 3 · ★ 文本下钻一层的判别
// ---------------------------------------------------------------------------
test("3 · ★ 文本下钻：第 2 轮助手正文在 message_end 前已逐字累积（来自 assistantMessageEvent）", async () => {
  const SECOND = "第二轮正文应当逐字累积到位，不能被吞掉。";
  // ★ 判别点在 message_end 时刻（早于 turn_end 的「权威覆盖」）：
  //   此时正文只能来自 message_update → assistantMessageEvent → text_delta 的累加。
  //   若 message_update 不复用 assistantMessageEvent（改读顶层 delta），此处会变成
  //   "undefined…"，而最终 state 会因为 turn_end 的权威覆盖而「看起来正常」——
  //   这正是本用例存在的意义：它钉住**流式过程**的正文，而非终态。
  const textAtMessageEnd = [];

  const { state } = await driveLibrary({
    responses: [
      faux.fauxAssistantMessage([faux.fauxToolCall("list_dir", { path: "." }, { id: "c1" })]),
      faux.fauxAssistantMessage([faux.fauxText(SECOND)]),
    ],
    tools: getTools(),
    userText: "hi",
    onEventExtra: (ev, current) => {
      if (ev.type === "message_end") {
        const assistant = lastAssistant(current);
        textAtMessageEnd.push(assistant ? assistant.text : undefined);
      }
    },
  });

  const streamed = textAtMessageEnd[textAtMessageEnd.length - 1];
  assert.equal(streamed, SECOND, `流式累积正文应等于 faux 脚本文本，实际：${JSON.stringify(streamed)}`);

  const assistant = lastAssistant(state);
  assert.ok(assistant, "应存在助手消息");
  assert.equal(assistant.text, SECOND, `终态正文也应等于脚本文本，实际：${JSON.stringify(assistant.text)}`);

  // 多轮上下文里也应带权威 apiMessage。
  const api = toApiMessages(state);
  const lastApi = api[api.length - 1];
  assert.equal(lastApi.role, "assistant");
  const joined = lastApi.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  assert.equal(joined, SECOND);
});

// ---------------------------------------------------------------------------
// 4 · 工具失败路径
// ---------------------------------------------------------------------------
test("4 · 工具失败：calculate 非法表达式 → 条目 error、循环继续、最终收敛 idle", async () => {
  const { state, result } = await driveLibrary({
    responses: [
      faux.fauxAssistantMessage([faux.fauxToolCall("list_dir", { path: "." }, { id: "calc1" })]),
      faux.fauxAssistantMessage([faux.fauxText("计算失败了，抱歉。")]),
    ],
    tools: getTools(),
    userText: "帮我算 1 +",
  });

  assert.equal(result.reachedAgentEnd, true, "工具失败后循环应继续并到达 agent_end");

  const tool = state.messages.find((m) => m.role === "tool");
  assert.ok(tool, "应存在工具条目");
  assert.equal(tool.status, "error", "失败工具条目应为 error");
  assert.equal(tool.isError, true, "isError 应为 true");
  assert.ok(typeof tool.resultText === "string", `resultText 应为字符串，实际：${typeof tool.resultText}`);

  assert.equal(isStreaming(state), false, "最终应收敛为 idle");
  assert.equal(state.status, "idle");

  // 循环继续 → 第 2 轮仍产出一条 assistant。
  const roles = state.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "tool", "assistant"], `实际时间线：${roles.join(",")}`);
});

// ---------------------------------------------------------------------------
// 5 · 中止于「工具执行中」
// ---------------------------------------------------------------------------
test("5 · ★ 中止于工具执行中：agent_end 仍到达、条目非 running、toApiMessages 末条非 assistant", async () => {
  const controller = new AbortController();

  // 一个可控挂起工具：在收到中止信号时以错误结束（模拟「用户中止，工具未完成」）。
  const hangTool = {
    name: "hang_tool",
    label: "挂起工具",
    description: "在收到中止信号前一直挂起，用于验证「工具执行中」的中止路径。",
    parameters: Type.Object({}),
    execute: (_id, _params, signal) =>
      new Promise((_resolve, reject) => {
        const fail = () => reject(new Error("Operation aborted"));
        if (signal) {
          if (signal.aborted) fail();
          else signal.addEventListener("abort", fail, { once: true });
        }
        // 否则永不 resolve（等待中止）。
      }),
  };

  const { state, result } = await driveLibrary({
    responses: [
      faux.fauxAssistantMessage([faux.fauxToolCall("hang_tool", {}, { id: "hang1" })]),
      faux.fauxAssistantMessage([faux.fauxText("不应到达这里（已中止）。")]),
    ],
    tools: [hangTool],
    userText: "调用一个会挂起的工具",
    signal: controller.signal,
    onEventExtra: (ev) => {
      if (ev.type === "tool_execution_start") controller.abort();
    },
  });

  assert.equal(result.reachedAgentEnd, true, "即便在工具执行中中止，agent_end 仍必须到达");
  assert.equal(isStreaming(state), false, "最终应收敛为 idle");

  const tool = state.messages.find((m) => m.role === "tool");
  assert.ok(tool, "应存在工具条目");
  assert.notEqual(tool.status, "running", `中止后工具条目不应停留在 running，实际：${tool.status}`);
  // ★ 收紧（S7-7 复核查出的覆盖弱点）：规格 §7.1 要求该终态落在 error/stopped，
  //   不能放水成「error || done」—— 放水后「工具条目被误标为完成」这类缺陷会逃逸。
  assert.equal(tool.status, "error", `中止于工具执行中 ⇒ 工具条目应为 error，实际：${tool.status}`);

  const api = toApiMessages(state);
  const last = api[api.length - 1];
  assert.ok(last && last.role !== "assistant", `末条不应是 assistant，实际：${last && last.role}`);
  assert.ok(
    api.some((m) => m.role === "toolResult" && m.toolCallId === "hang1"),
    "应含覆盖该 toolCall 的 toolResult",
  );
});

// ---------------------------------------------------------------------------
// 6 · B-2：合成 toolResult 单测（不经 faux）
// ---------------------------------------------------------------------------
test("6 · B-2：assistant 带 2 个 toolCall、仅 1 个 toolResult → 补齐 1 条 isError 合成结果", () => {
  const assistantApi = faux.fauxAssistantMessage([
    faux.fauxToolCall("list_dir", { path: "." }, { id: "a1" }),
    faux.fauxToolCall("list_dir", { path: "." }, { id: "a2" }),
  ]);
  const tr1 = {
    role: "toolResult",
    toolCallId: "a1",
    toolName: "list_dir",
    content: [{ type: "text", text: "已覆盖 a1" }],
    details: {},
    isError: false,
    timestamp: 10,
  };

  const state = {
    status: "idle",
    messages: [
      { id: "m0", role: "user", text: "hi", thinking: "", status: "done" },
      { id: "m1", role: "assistant", text: "", thinking: "", status: "done", apiMessage: assistantApi },
      {
        id: "tool:a1",
        role: "tool",
        toolCallId: "a1",
        toolName: "list_dir",
        args: {},
        status: "done",
        resultText: "已覆盖 a1",
        isError: false,
        details: {},
        apiMessage: tr1,
      },
    ],
  };

  const out = toApiMessages(state);
  const toolResults = out.filter((m) => m.role === "toolResult");
  assert.equal(toolResults.length, 2, `应有 2 条 toolResult（1 真 + 1 合成），实际 ${toolResults.length}`);

  const synthetic = toolResults.find((m) => m.toolCallId === "a2");
  assert.ok(synthetic, "应为未覆盖的 a2 合成一条 toolResult");
  assert.equal(synthetic.isError, true, "合成结果应为 isError");
  assert.equal(synthetic.toolName, "list_dir", "toolName 应对齐 toolCall 块");
  assert.ok(/中止|未执行/.test(synthetic.content[0].text), "合成结果文案应说明未完成");

  const last = out[out.length - 1];
  assert.notEqual(last.role, "assistant", "末条不应是 assistant");
});

// ---------------------------------------------------------------------------
// 7 · R13：剔除末尾「非完成态」assistant
// ---------------------------------------------------------------------------
test("7 · R13：末尾是无 toolResult 支撑的「非完成态」assistant → 被剔除、不抛错", () => {
  const state = {
    status: "streaming",
    messages: [
      { id: "m0", role: "user", text: "hi", thinking: "", status: "done" },
      {
        id: "m1",
        role: "assistant",
        text: "半截回答",
        thinking: "",
        status: "streaming",
        apiMessage: faux.fauxAssistantMessage("半截回答"),
      },
    ],
  };

  let out;
  assert.doesNotThrow(() => {
    out = toApiMessages(state);
  }, "toApiMessages 不得抛错");
  assert.equal(out.length, 1, "非完成态 assistant 应被剔除");
  assert.equal(out[out.length - 1].role, "user", "末条不应是 assistant");

  // 对照：完成态（done）assistant 一律保留（既有行为，不得回归）。
  const doneState = {
    status: "idle",
    messages: [
      { id: "m0", role: "user", text: "hi", thinking: "", status: "done" },
      { id: "m1", role: "assistant", text: "完整回答", thinking: "", status: "done", apiMessage: faux.fauxAssistantMessage("完整回答") },
    ],
  };
  const out2 = toApiMessages(doneState);
  assert.equal(out2.length, 2, "完成态 assistant 应保留");
  assert.equal(out2[1].role, "assistant");

  // ★ R13 的三种「非完成态」都要各自有判别力：streaming / stopped / error。
  //   （此前只有 streaming 被钉住；若把剪枝条件放宽成「只对 streaming 剪」，
  //    stopped/error 的用例必须变红 —— 它们都是「下次请求 400」防线的一部分。）
  for (const status of ["stopped", "error"]) {
    const s = {
      status: "idle",
      messages: [
        { id: "m0", role: "user", text: "hi", thinking: "", status: "done" },
        {
          id: "m1",
          role: "assistant",
          text: "半截",
          thinking: "",
          status,
          apiMessage: faux.fauxAssistantMessage("半截"),
        },
      ],
    };
    const o = toApiMessages(s);
    assert.equal(o.length, 1, `末尾 ${status} assistant 应被 R13 剔除`);
    assert.equal(o[0].role, "user", `末条不应是 ${status} assistant`);
  }
});

// ---------------------------------------------------------------------------
// 8 · 容忍乱序 / 重复事件
// ---------------------------------------------------------------------------
test("8 · 容忍乱序/重复：end 先于 start、重复 start → 不抛错、条目不膨胀", () => {
  let state = appendUser(initialState(), "hi");

  // end 先于 start：不得抛错、不得新建条目。
  const afterEnd = applyLibraryEvent(state, {
    type: "tool_execution_end",
    toolCallId: "x",
    toolName: "t",
    result: { content: [{ type: "text", text: "r" }], details: {} },
    isError: false,
  });
  assert.equal(afterEnd.messages.length, state.messages.length, "找不到条目时不得新增");

  // 重复 start：只建一条。
  state = applyLibraryEvent(state, { type: "tool_execution_start", toolCallId: "x", toolName: "t", args: { a: 1 } });
  state = applyLibraryEvent(state, { type: "tool_execution_start", toolCallId: "x", toolName: "t", args: { a: 2 } });
  const toolCount = state.messages.filter((m) => m.role === "tool" && m.toolCallId === "x").length;
  assert.equal(toolCount, 1, "重复 start 不得重复追加条目");
  assert.deepEqual(state.messages[state.messages.length - 1].args, { a: 2 }, "重复 start 应原地更新 args");

  // 正常 end：补结果。
  state = applyLibraryEvent(state, {
    type: "tool_execution_end",
    toolCallId: "x",
    toolName: "t",
    result: { content: [{ type: "text", text: "结果文本" }], details: { k: 1 } },
    isError: false,
  });
  const tool = state.messages[state.messages.length - 1];
  assert.equal(tool.status, "done");
  assert.equal(tool.resultText, "结果文本");
  assert.deepEqual(tool.details, { k: 1 });

  // 未知事件：原样返回。
  const unknown = applyLibraryEvent(state, { type: "something_else" });
  assert.equal(unknown, state, "未知事件应原样返回");
  assert.equal(applyLibraryEvent(state, null), state, "null 事件应原样返回");
});

// ---------------------------------------------------------------------------
// 9 · toApiMessages 既有行为不回归
// ---------------------------------------------------------------------------
test("9 · 既有行为不回归：纯文本单轮 → [user, assistant]，且 assistant 就是 apiMessage 原件", async () => {
  const { state } = await driveLibrary({
    responses: [faux.fauxAssistantMessage("这是一段纯文本回答。")],
    tools: undefined,
    userText: "hi",
  });

  const out = toApiMessages(state);
  assert.equal(out.length, 2, `应为 [user, assistant]，实际 ${out.length} 条`);
  assert.equal(out[0].role, "user");
  assert.equal(out[1].role, "assistant");
  assert.strictEqual(out[1], lastAssistant(state).apiMessage, "assistant 应复用 apiMessage 原件");
});

// ---------------------------------------------------------------------------
// 10 · ★ 多步转录回灌（真指标）：有序数组 + toolCallId 逐位对齐
// ---------------------------------------------------------------------------
// 用**真实的两步 faux 循环**驱动，跑完后对 `toApiMessages(state)` 断言：
//   - 尾部三元的 role 序列**按索引**严格等于 ["assistant", "toolResult", "assistant"]；
//   - 每个 toolResult 的 toolCallId 等于**紧邻前一个** assistant 里 toolCall 块的 id。
// 刻意用「有序数组 + 逐位对齐」而非 find 的存在性断言 —— 后者会放过顺序错乱 / 配对错位。
test("10 · ★ 多步转录回灌：toApiMessages 有序且 toolCallId 与紧邻前一 assistant 逐位对齐", async () => {
  const { state } = await driveLibrary({
    responses: [
      faux.fauxAssistantMessage([faux.fauxToolCall("list_dir", { path: "." }, { id: "call_time_1" })]),
      faux.fauxAssistantMessage([faux.fauxText("已经拿到当前时间了。")]),
    ],
    tools: getTools(),
    userText: "现在几点？",
  });

  const out = toApiMessages(state);
  const roles = out.map((m) => m.role);

  // ① 完整有序序列（真指标，非存在性）。
  assert.deepEqual(
    roles,
    ["user", "assistant", "toolResult", "assistant"],
    `完整 role 序列应为 [user, assistant, toolResult, assistant]，实际：${JSON.stringify(roles)}`,
  );

  // ② 尾部三元按**索引**严格对齐。
  assert.deepEqual(
    roles.slice(-3),
    ["assistant", "toolResult", "assistant"],
    `尾部三元 role 序列应严格为 [assistant, toolResult, assistant]，实际完整序列：${JSON.stringify(roles)}`,
  );

  // ③ toolCallId 逐位对齐：每个 toolResult 必须紧邻其 assistant，且 id 命中该 assistant 的 toolCall。
  let checked = 0;
  for (let i = 0; i < out.length; i += 1) {
    if (out[i].role !== "toolResult") continue;
    const prev = out[i - 1];
    assert.equal(
      prev && prev.role,
      "assistant",
      `toolResult 的前一条必须是 assistant，实际（索引 ${i - 1}）：${prev && prev.role}；完整序列：${JSON.stringify(roles)}`,
    );
    const callIds = (Array.isArray(prev.content) ? prev.content : [])
      .filter((b) => b && b.type === "toolCall")
      .map((b) => b.id);
    assert.ok(
      callIds.includes(out[i].toolCallId),
      `toolResult.toolCallId=${out[i].toolCallId} 必须命中紧邻前一 assistant 的 toolCall id（实际：${JSON.stringify(callIds)}）`,
    );
    checked += 1;
  }
  assert.ok(checked >= 1, `应至少校验到一个 toolResult（实际 ${checked}）`);
});
