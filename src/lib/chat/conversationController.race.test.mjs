/**
 * conversationController 竞态回归（S4 二轮修复 A-1 · 由 QA 补强；S7-5 适配到 runAgentTurn）。
 *
 * 既有 conversationController.test.mjs 覆盖了「send→stop→send 被受理」这一浅层契约，
 * 但**没有**覆盖 A-1 修复中最易被改坏、且症状最隐蔽的一条：
 *   —— 「用『在 stop() 里清空 abortRef』来修」时，上一轮 IIFE 的 finally 会随后执行，
 *      把**新一轮刚设好的** controller 一并清掉，导致「新流的信号被摘掉 → 无法再 stop」。
 *
 * 本文件用**可控的假 runAgentTurn**（忠实复刻真实 runTurn 的中止语义：中止后**异步**
 * 补发 agent_end 并 resolve，绝不同步在 abort 监听里改状态）精确复现该序列，从而：
 *   1. 证明当前实现是「状态派生忙判定 + 带守卫的 finally」，没有踩这个坑；
 *   2. 若将来有人把 stop() 改成清空 abortRef、或去掉 finally 守卫，本测试会立刻失败。
 *
 * ★ S7-5 改动：库注入由 `streamChat`（事件流）换成 `runAgentTurn`（Promise<RunTurnResult>
 *   + `onEvent` 回调）。假实现产出的**库事件**经 `params.onEvent` 交给 controller，
 *   controller 再喂给**真实** `conversationModel.applyLibraryEvent` —— 状态机是产品代码，
 *   没有被绕过。并新增「保险收敛（未到达 agent_end）」与「reject 分流」用例。
 *
 * 运行：node --test src/lib/chat/conversationController.race.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { initialState } from "./conversationModel.js";
import { createConversationController } from "./conversationController.js";

/**
 * 构造被测编排器：假 `runAgentTurn` 返回**可控 Promise**，并把每轮调用（signal / emit / resolve）
 * 记录下来。`emit` 把**库事件**交给 controller（→ 真实 applyLibraryEvent）。
 *
 * 中止语义（忠实复刻真实 runTurn）：
 *   - signal 中止 → **异步**（queueMicrotask）补发 `agent_end`（末条 aborted assistant）并 resolve；
 *   - **绝不**在 abort 监听里同步改状态 —— 真实库的循环在下一轮微任务才察觉中止，
 *     而 `stop()` 已先行 `finishAborted`，二者顺序是 A-1 语义的一部分。
 */
function makeHarness(opts = {}) {
  const calls = [];
  let state = initialState();

  const defaultRunAgentTurn = (params) => {
    const call = { signal: params.signal, reachedAgentEnd: false };
    call.emit = (ev) => {
      if (ev && ev.type === "agent_end") call.reachedAgentEnd = true;
      return params.onEvent(ev, params.signal);
    };
    const promise = new Promise((resolve, reject) => {
      call.resolve = (overrides = {}) =>
        resolve({
          messages: [],
          aborted: params.signal.aborted,
          reachedAgentEnd: call.reachedAgentEnd,
          stopReason: undefined,
          errorMessage: undefined,
          ...overrides,
        });
      call.reject = reject;
    });
    params.signal.addEventListener("abort", () => {
      queueMicrotask(() => {
        call.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }] });
        call.resolve({ aborted: true, reachedAgentEnd: true, stopReason: "aborted" });
      });
    });
    calls.push(call);
    return promise;
  };

  const controller = createConversationController({
    getState: () => state,
    setState: (updater) => {
      state = updater(state);
    },
    runAgentTurn: opts.runAgentTurn ?? defaultRunAgentTurn,
    getOptions: () => ({ source: "faux", config: {}, systemPrompt: "sys" }),
  });
  return { controller, getState: () => state, calls };
}

/** 让已排队的微任务/宏任务充分推进（不依赖真实时间长度）。 */
async function settle(ticks = 8) {
  for (let i = 0; i < ticks; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 轮询等待条件成立（重试退避是真实计时器；并行负载下固定 sleep 会抖）。 */
async function waitFor(predicate, deadlineMs = 3000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > deadlineMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

const lastAssistant = (state) => [...state.messages].reverse().find((m) => m.role === "assistant");

// ---------------------------------------------------------------------------
// A-1：stop A → send B，旧轮 finally 不得摘掉 B 的信号
// ---------------------------------------------------------------------------

test("A-1 陷阱：stop A → send B 后，旧轮的 finally 不得摘掉 B 的信号（stop B 必须真正中止 B）", async () => {
  const { controller, getState, calls } = makeHarness();

  assert.equal(controller.send("A"), true, "首条应被受理");
  controller.stop(); // 旧实现窗口：状态已 idle，但 abortRef 尚未清空
  assert.equal(controller.send("B"), true, "stop 后立即再 send 必须被受理（旧实现会静默吞掉）");

  await settle(); // 让 A 的 IIFE 走到 finally
  assert.equal(calls[1].signal.aborted, false, "此刻尚未要求中止 B");

  controller.stop(); // 若 B 的句柄已被旧轮 finally 摘掉，这一步将无效
  await settle();

  assert.equal(calls[1].signal.aborted, true, "B 的信号必须仍可被 stop() 中止，不得被旧轮 finally 摘掉");
  assert.equal(getState().status, "idle", "B 被中止后应回 idle");
  assert.equal(lastAssistant(getState()).status, "stopped", "B 的助手消息应被标注为已停止");
});

// ---------------------------------------------------------------------------
// 陈旧流隔离
// ---------------------------------------------------------------------------

test("陈旧流隔离：A 被中止的陈旧事件不得把新一轮 B 的助手消息污染成 stopped", async () => {
  const { controller, getState, calls } = makeHarness();

  controller.send("A");
  calls[0].emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "AAA" } });
  await settle();
  controller.stop(); // A 中止 → 稍后异步下发 aborted agent_end

  assert.equal(controller.send("B"), true, "新一轮应被受理");
  calls[1].emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "BBB" } });
  await settle(); // 让 A 的陈旧 aborted agent_end 到达（此时应被 isStale 丢弃）
  calls[1].emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
  await settle();

  const last = lastAssistant(getState());
  assert.equal(last.status, "done", "B 必须正常 done，不得被 A 的陈旧中止事件染成 stopped");
  assert.equal(last.text, "BBB");
});

test("陈旧流隔离（工具事件）：旧轮晚到的 toolcall_end / 工具事件不得在新一轮时间线留下工具条目", async () => {
  /** 时间线投影（失败时便于诊断）：角色 + id + 工具名 + 助手状态。 */
  const projection = (state) =>
    state.messages.map((m) => ({ role: m.role, id: m.id, toolName: m.toolName, status: m.status, text: m.text }));

  /**
   * 跑一次「A 被中止 → B 开始 → B 正常结束」的时间线。
   * injectStale=true 时，在 **B 已开始之后**，让旧轮 A 晚到一批工具事件。
   */
  async function runTimeline(injectStale) {
    const { controller, getState, calls } = makeHarness();
    controller.send("A");
    await settle();
    controller.stop(); // A 中止 → 稍后异步下发 aborted agent_end
    assert.equal(controller.send("B"), true, "新一轮应被受理");

    calls[1].emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "BBB" } });

    if (injectStale) {
      // 旧轮 A 在 B 已开始之后才送达：一个 toolcall_end + 工具执行起止 + 一条工具结果消息。
      calls[0].emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: { id: "stale-call", name: "list_dir", arguments: {} },
        },
      });
      calls[0].emit({ type: "tool_execution_start", toolCallId: "stale-call", toolName: "list_dir", args: {} });
      calls[0].emit({
        type: "tool_execution_end",
        toolCallId: "stale-call",
        toolName: "list_dir",
        result: { content: [{ type: "text", text: "STALE-RESULT" }], details: {} },
        isError: false,
      });
      calls[0].emit({
        type: "message_start",
        message: {
          role: "toolResult",
          toolCallId: "stale-call",
          toolName: "list_dir",
          content: [{ type: "text", text: "STALE-RESULT" }],
          isError: false,
        },
      });
      calls[0].emit({ type: "message_end", message: { role: "toolResult", toolCallId: "stale-call" } });
    }

    await settle(); // 让 A 的陈旧 aborted agent_end 也到达（此时应被 isStale 丢弃）
    // (3) 陈旧事件不得收敛新一轮：此刻 B 仍应 streaming（若 A 的陈旧 agent_end 未被丢弃，这里会提前变 idle）。
    const statusBeforeRealEnd = getState().status;

    calls[1].emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    await settle();

    return { state: getState(), statusBeforeRealEnd };
  }

  const baseline = await runTimeline(false);
  const stale = await runTimeline(true);

  // (1) 新一轮时间线里没有旧轮的工具条目（按 role==="tool" / entry id 判定）。
  const staleToolEntries = stale.state.messages.filter((m) => m.role === "tool");
  assert.equal(
    staleToolEntries.length,
    0,
    `新一轮时间线不得残留旧轮工具条目（实际投影：${JSON.stringify(projection(stale.state))}）`,
  );
  assert.ok(
    !stale.state.messages.some((m) => typeof m.id === "string" && m.id === "tool:stale-call"),
    "不得出现以旧轮 toolCallId 命名的工具条目 tool:stale-call",
  );

  // (2) 新一轮助手文本不受影响：与「无旧轮晚到事件」的对照组逐字相等。
  assert.equal(
    lastAssistant(stale.state).text,
    lastAssistant(baseline.state).text,
    "陈旧工具事件不得改变新一轮助手文本",
  );
  assert.equal(lastAssistant(stale.state).text, "BBB", "新一轮文本应仍为 BBB");

  // (3) 状态机未被陈旧事件踢出预期状态。
  assert.equal(stale.statusBeforeRealEnd, "streaming", "陈旧事件不得收敛新一轮（B 此刻应仍在 streaming）");
  assert.equal(stale.state.status, "idle", "B 正常结束后应为 idle");
  assert.equal(lastAssistant(stale.state).status, "done", "B 的助手消息应为 done（不得 stopped/error）");
});

// ---------------------------------------------------------------------------
// 连续交错
// ---------------------------------------------------------------------------

test("连续交错 send→stop ×3：每一轮都不得被静默吞掉，且都真正发起请求", async () => {
  const { controller, getState, calls } = makeHarness();

  const accepted = [];
  for (let i = 1; i <= 3; i += 1) {
    accepted.push(controller.send(`第${i}轮`));
    controller.stop();
  }
  await settle();

  assert.deepEqual(accepted, [true, true, true]);
  assert.equal(calls.length, 3, "三轮都应真正发起 agent 运行");
  const userTexts = getState()
    .messages.filter((m) => m.role === "user")
    .map((m) => m.text);
  assert.deepEqual(userTexts, ["第1轮", "第2轮", "第3轮"]);
});

// ---------------------------------------------------------------------------
// S7-5 新增：保险收敛（不依赖「事件一定到达」）
// ---------------------------------------------------------------------------

test("新增 · 保险收敛：runAgentTurn resolve 但未到达 agent_end（无错误）→ 兜底收敛为 idle/done", async () => {
  const { controller, getState, calls } = makeHarness();

  assert.equal(controller.send("A"), true);
  await settle(); // 让 IIFE 进入 await
  calls[0].resolve({ reachedAgentEnd: false, aborted: false, stopReason: undefined, errorMessage: undefined });
  await settle();

  assert.equal(getState().status, "idle", "未收到 agent_end 也必须收敛，绝不能卡在 streaming");
  assert.equal(lastAssistant(getState()).status, "done");
});

test("新增 · 保险收敛：runAgentTurn resolve 带 errorMessage → 可重试错误进入自动重试（5 次上限）", async () => {
  const { controller, getState, calls } = makeHarness();

  assert.equal(controller.send("A"), true);
  await settle();
  // 第 1 次调用返回可重试的 errorMessage → 应触发自动重试
  calls[0].resolve({ reachedAgentEnd: false, errorMessage: "429 rate limit exceeded" });
  await settle();
  // 等退避计时器走完、第二次调用发出（退避 ~200ms，轮询等待对负载不敏感）
  assert.ok(await waitFor(() => calls.length >= 2), "退避后应已发起第二次调用");

  // 重试期间保持 streaming（对齐 LiveAgent：调用方看到的是「进行中」而非「已失败」）
  assert.equal(getState().status, "streaming", "可重试错误应保持 streaming 进行自动重试");
  assert.ok(getState().retryAttempts?.length >= 1, "应记录重试条目");
  calls[calls.length - 1].resolve({ reachedAgentEnd: false, errorMessage: "401 unauthorized" });
  await settle();
  await settle();
  assert.equal(getState().status, "error", "不可重试错误应收敛为 error");
  assert.ok(/401/.test(getState().error ?? ""), "最终错误应为最后一次的原文");
});

test("新增 · 保险收敛：runAgentTurn resolve 但未到达 agent_end 且 aborted → 兜底标为 stopped", async () => {
  const { controller, getState, calls } = makeHarness();

  assert.equal(controller.send("A"), true);
  await settle();
  calls[0].resolve({ reachedAgentEnd: false, aborted: true, stopReason: "aborted" });
  await settle();

  assert.equal(getState().status, "idle", "中止的兜底应回 idle，不进入 error");
  assert.equal(getState().error, undefined);
  assert.equal(lastAssistant(getState()).status, "stopped");
});

// ---------------------------------------------------------------------------
// S7-5 新增：runAgentTurn reject 的异常分流
// ---------------------------------------------------------------------------

test("新增 · 异常分流：runAgentTurn reject（入口前置校验）→ 走 error 分流，不卡 streaming", async () => {
  const { controller, getState } = makeHarness({
    runAgentTurn: () => Promise.reject(new Error("deps.messages 的末条不能是 assistant")),
  });

  assert.equal(controller.send("A"), true);
  await settle();

  assert.equal(getState().status, "error", "reject 应走 error 分流");
  assert.equal(lastAssistant(getState()).status, "error");
});

test("新增 · 异常分流：runAgentTurn reject 且 signal 已中止 → 标为 stopped（不发红字）", async () => {
  const { controller, getState } = makeHarness({
    runAgentTurn: (params) =>
      new Promise((_resolve, reject) => {
        params.signal.addEventListener("abort", () => reject(new Error("Request was aborted")));
      }),
  });

  assert.equal(controller.send("A"), true);
  await settle();
  controller.stop();
  await settle();

  assert.equal(getState().status, "idle", "中止导致的 reject 应回 idle");
  assert.equal(getState().error, undefined, "中止不应产生错误文案");
  assert.equal(lastAssistant(getState()).status, "stopped");
});
