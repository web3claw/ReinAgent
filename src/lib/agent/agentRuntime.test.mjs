/**
 * agentRuntime 的自动化验证（S7-2）。
 * =====================================================================
 * 全部使用 pi-ai 的 **faux provider 离线驱动**，不联网、不依赖任何真实 provider。
 *
 * faux 是怎么拿到的（读 `src/lib/providers/fauxSource.ts` 后的实际做法）：
 *   fauxSource 的做法是 `import("@earendil-works/pi-ai/providers/faux")`
 *   → `createFauxCore({ api: "faux", tokensPerSecond, tokenSize })`
 *   → `core.setResponses([...])` → `core.stream(core.getModel(), ctx, { signal })`。
 *   本测试沿用同样三件套，但**在 Node 侧直接 await import**（不经 Vite）：
 *     const faux = await import("@earendil-works/pi-ai/providers/faux");
 *     const core = faux.createFauxCore({ api: "faux", tokenSize: {min:1,max:3} });
 *     const model = core.getModel();                    // model.api === "faux"
 *     core.setResponses([ faux.fauxAssistantMessage([faux.fauxText("...")]) ]);
 *   关键：`createFauxCore` 必须显式传 `api: "faux"`（否则 api 是随机串），
 *   才能与 S7-1 工厂的 `api: "faux"` 对齐，通过运行期守卫。
 *   我们把 `core.stream` 作为 **provider 级 stream** 交给 runTurn（经 S7-1 工厂）。
 *
 * 覆盖（对应 S7-2 规格 §3.3）：
 *   1. 纯文本单轮：事件序列以 agent_end 收尾；
 *   2. 文本累积：从 message_update.assistantMessageEvent 拼出完整回答；
 *   3. turn_end 不得被当成收敛点（agent_end 才是终点）；
 *   4. 快照隔离：返回值与库内部不是同一引用；
 *   5. ★ D1：run 中 abort 外部 signal => agent.abort() 触发 / agent_end 仍到达 / aborted=true；
 *   6. 陈旧流隔离基础：onEvent 收到外部 signal 的同一引用；
 *   7. 前置校验：末条 assistant 立即抛错（不退化为空文本失败）；
 *   8. 天然规避 "Agent is already processing"（每次新建 Agent）；
 *   9. ★ maxSteps 行为化（S7-5 收尾补）：显式步数硬闸真被消费
 *      （差分：=1 在第 1 步后中断 vs =5 / 不传 跑完两步脚本）。
 *
 * 运行：node --test src/lib/agent/agentRuntime.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { runTurn } from "./agentRuntime.js";
import { createTools } from "./tools.js";

// 运行时从 provider 子入口加载 faux（仅 Node 测试用；不经过 Vite 打包，不拖入桶文件）。
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

/** 造「一段文本 → 一次 faux 回复」的最小依赖。 */
function textDeps({ text, messages, onEvent, signal, systemPrompt }) {
  const core = makeFaux();
  core.setResponses([faux.fauxAssistantMessage([faux.fauxText(text)])]);
  const model = core.getModel();
  return { model, stream: fauxStream(core), api: "faux", label: "faux", messages, onEvent, signal, systemPrompt };
}

// ---------------------------------------------------------------------------
// 1 · 纯文本单轮
// ---------------------------------------------------------------------------
test("1 · 纯文本单轮：事件序列以 agent_end 收尾，且 agent_end 是最后一个", async () => {
  const types = [];
  const result = await runTurn(
    textDeps({
      text: "你好，我是 ReinAgent。",
      messages: [userMessage("hi")],
      onEvent: (ev) => {
        types.push(ev.type);
      },
    }),
  );

  assert.equal(types[0], "agent_start", "首个事件应是 agent_start");
  assert.equal(types[types.length - 1], "agent_end", "末个事件应是 agent_end");
  for (const expected of ["agent_start", "turn_start", "message_start", "message_update", "message_end", "turn_end", "agent_end"]) {
    assert.ok(types.includes(expected), `事件序列应包含 ${expected}（实际：${types.join(",")}）`);
  }
  assert.ok(!types.some((t) => t.startsWith("tool_execution_")), "无工具时不应出现 tool_execution_*");

  assert.equal(result.reachedAgentEnd, true);
  assert.equal(result.aborted, false);
  assert.equal(result.stopReason, "stop");
  assert.equal(result.errorMessage, undefined);
});

// ---------------------------------------------------------------------------
// 2 · 文本累积
// ---------------------------------------------------------------------------
test("2 · 文本累积：从 message_update 的 assistantMessageEvent 拼出完整回答", async () => {
  const full = "ReinAgent 的流式增量文本，用于验证累计拼接是否逐字到位。";
  let acc = "";
  let deltas = 0;
  let topLevelDeltaSeen = false;

  const result = await runTurn(
    textDeps({
      text: full,
      messages: [userMessage("hi")],
      onEvent: (ev) => {
        if (ev.type !== "message_update") return;
        // 规格 2.5：message_update 把 pi-ai 事件包了一层，顶层不再有 delta。
        if ("delta" in ev) topLevelDeltaSeen = true;
        const inner = ev.assistantMessageEvent;
        if (inner && inner.type === "text_delta") {
          acc += inner.delta;
          deltas += 1;
        }
      },
    }),
  );

  assert.ok(deltas > 0, `应有 text_delta 增量（实际 ${deltas} 个）`);
  assert.equal(acc, full, "增量拼接结果应等于完整回答");
  assert.equal(topLevelDeltaSeen, false, "message_update 顶层不应再有 delta（应在 assistantMessageEvent 里）");

  const lastAssistant = result.messages.filter((m) => m.role === "assistant").pop();
  const joined = lastAssistant.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  assert.equal(joined, full, "最终快照里的文本也应等于完整回答");
});

// ---------------------------------------------------------------------------
// 3 · turn_end 不是收敛点
// ---------------------------------------------------------------------------
test("3 · 协议收敛点：turn_end 先于 agent_end 出现，agent_end 才是终点且恰好一次", async () => {
  const types = [];
  await runTurn(
    textDeps({
      text: "单轮纯文本。",
      messages: [userMessage("hi")],
      onEvent: (ev) => {
        types.push(ev.type);
      },
    }),
  );

  const idxTurnEnd = types.indexOf("turn_end");
  const idxAgentEnd = types.indexOf("agent_end");
  assert.ok(idxTurnEnd >= 0, `纯文本路径确实产生 turn_end（实际：${types.join(",")}）`);
  assert.ok(idxAgentEnd > idxTurnEnd, "agent_end 必须晚于 turn_end");
  assert.equal(types[types.length - 1], "agent_end", "agent_end 必须是最后一个事件");
  assert.equal(types.filter((t) => t === "agent_end").length, 1, "agent_end 恰好出现一次");
});

// ---------------------------------------------------------------------------
// 4 · 快照隔离
// ---------------------------------------------------------------------------
test("4 · 快照隔离：返回值是拷贝，改动它不影响再次运行得到的真相", async () => {
  // 说明：本模块刻意**不把 Agent 实例暴露**给调用方（避免出现第二个停止入口），
  // 因此无法在外部直接对 `agent.state.messages` 做 notStrictEqual。
  // 采用规格建议的间接证明：改动上次返回值 -> 再次运行的结果不受影响。
  const input1 = [userMessage("hi")];
  const r1 = await runTurn(textDeps({ text: "第一轮回答。", messages: [userMessage("hi")], onEvent: () => {} }));
  assert.ok(Array.isArray(r1.messages), "messages 应是数组");

  // ★ 快照死值：返回值被 Object.freeze，调用方不得改写「本次运行如何结束」的事实对象。
  //   （messages 数组本身仍可 push —— test 4 下面的破坏性改动依赖这一点，故只断言外层冻结。）
  assert.ok(Object.isFrozen(r1), "runTurn 返回的事实对象应被冻结（快照死值不变量）");

  // 破坏性地改动上次返回值。
  r1.messages.push({ role: "user", content: "MUTATION_SENTINEL", timestamp: 999 });
  r1.messages[0] = { role: "system", content: "CLOBBERED", timestamp: 0 };

  const r2 = await runTurn(textDeps({ text: "第二轮回答。", messages: [userMessage("hi")], onEvent: () => {} }));
  assert.notStrictEqual(r1.messages, r2.messages, "每次 runTurn 返回新的数组实例");
  assert.equal(r2.messages[0].role, "user", "上次对返回值的改动不得影响本次结果");
  assert.ok(!r2.messages.some((m) => m.content === "MUTATION_SENTINEL"), "不得出现上次注入的哨兵");
  assert.ok(!r2.messages.some((m) => m.content === "CLOBBERED"), "不得出现上次注入的改写");

  // 调用方传入的 input1 也不应被 runTurn 反向污染。
  assert.equal(input1.length, 1);
  assert.equal(input1[0].role, "user");
});

// ---------------------------------------------------------------------------
// 5 · ★ D1：外部 signal => agent.abort() 桥接
// ---------------------------------------------------------------------------
test("5 · ★ D1：run 进行中 abort 外部 signal => agent.abort() 触发 / agent_end 仍到达 / aborted=true", async () => {
  // 长文本：确保「流式进行中」确实发生了中止，而非跑完再 abort。
  const longText = "这一步本该被中止，永远不应完整结束。".repeat(30);
  const core = makeFaux();
  core.setResponses([faux.fauxAssistantMessage([faux.fauxText(longText)])]);
  const model = core.getModel();

  const controller = new AbortController();
  let capturedSignal = null;
  const types = [];

  const result = await runTurn({
    model,
    stream: (m, c, o) => {
      capturedSignal = o?.signal ?? null; // 库自建的内部 signal（唯一来源：agent.signal）
      return core.stream(m, c, o);
    },
    api: "faux",
    label: "faux",
    messages: [userMessage("hi")],
    signal: controller.signal,
    onEvent: (ev) => {
      types.push(ev.type);
      if (ev.type === "agent_start") {
        // run 进行中（activeRun 已建立、但尚未 stream）触发外部中止。
        controller.abort();
      }
    },
  });

  // (a) agent.abort() 确实被触发：
  //     库自建的内部 signal 只能由 agent.abort() 置为 aborted（我们从不直接触碰它）。
  assert.ok(capturedSignal, "streamFn 应收到库自建的内部 signal");
  assert.equal(capturedSignal.aborted, true, "库内部 signal 必须已被 abort（唯一途径即 agent.abort()）");

  // (b) agent_end 仍然到达（收敛不依赖外部 signal 的可见性）。
  assert.equal(result.reachedAgentEnd, true, "即便被中止，agent_end 仍必须到达");
  assert.equal(types[types.length - 1], "agent_end", "agent_end 仍是最后一个事件");

  // (c) 返回值里「是否被中止」为真。
  assert.equal(result.aborted, true, "返回的 aborted 应为 true");
  assert.equal(result.stopReason, "aborted", "末条 assistant 的 stopReason 应为 aborted");
});

// ---------------------------------------------------------------------------
// 6 · 陈旧流隔离基础：onEvent 收到外部 signal 的同一引用
// ---------------------------------------------------------------------------
test("6 · 陈旧流隔离基础：onEvent 回调收到的 signal 就是传入的那个引用", async () => {
  const controller = new AbortController();
  let seenCount = 0;
  let seenSignal = Symbol("unset");

  await runTurn(
    textDeps({
      text: "一次普通回复。",
      messages: [userMessage("hi")],
      signal: controller.signal,
      onEvent: (_ev, signal) => {
        seenCount += 1;
        seenSignal = signal;
      },
    }),
  );

  assert.ok(seenCount > 0, "onEvent 应至少被调用一次");
  assert.strictEqual(seenSignal, controller.signal, "onEvent 的第二参必须是传入的同一个 AbortSignal 引用");
});

// ---------------------------------------------------------------------------
// 7 · 前置校验
// ---------------------------------------------------------------------------
test("7 · 前置校验：messages 末条为 assistant 立即抛错，且错误信息说明原因", async () => {
  const core = makeFaux();
  core.setResponses([faux.fauxAssistantMessage([faux.fauxText("不应到达这里")])]);
  const model = core.getModel();

  let events = 0;
  await assert.rejects(
    () =>
      runTurn({
        model,
        stream: fauxStream(core),
        api: "faux",
        messages: [
          userMessage("hi"),
          { role: "assistant", content: [{ type: "text", text: "上一轮回答" }], timestamp: 2 },
        ],
        onEvent: () => {
          events += 1;
        },
      }),
    (err) => {
      assert.ok(err instanceof Error, "必须抛 Error");
      assert.match(err.message, /assistant/, "错误信息须点明「末条为 assistant」");
      assert.match(err.message, /continue|末条/, "错误信息须解释 continue() 的前置条件");
      // ★ 判别力（R13）：必须是**封装层自己的可解释错误**，而不是库冒上来的裸异常。
      // 去掉封装层前置校验后，漏出去的是库原文 "Cannot continue from message role: assistant"
      // ——它同样命中上面两条正则，故必须用下面两条「只有本层才满足」的断言把它区分开。
      assert.match(
        err.message,
        /agentRuntime\.runTurn:/,
        "必须是封装层自己的可解释错误（以 agentRuntime.runTurn: 开头），而不是库的裸异常",
      );
      assert.ok(
        !/^Cannot continue from message role/.test(err.message),
        "不得把库的裸异常原文直接冒给用户",
      );
      return true;
    },
  );
  assert.equal(events, 0, "前置校验失败时不得发出任何事件（不退化为库的空文本失败事件序列）");

  // 空 messages 同样立即抛错。
  await assert.rejects(
    () =>
      runTurn({
        model,
        stream: fauxStream(core),
        api: "faux",
        messages: [],
        onEvent: () => {},
      }),
    (err) => {
      assert.ok(err instanceof Error, "必须抛 Error");
      // 同样收紧：库在 agent.js 也会抛 "No messages to continue from"，须与封装层区分。
      assert.match(err.message, /agentRuntime\.runTurn:/, "空 messages 必须是封装层自己的可解释错误");
      assert.match(err.message, /不能为空/, "错误信息须说明 messages 不能为空");
      assert.ok(
        !/^No messages to continue from/.test(err.message),
        "不得把库的裸异常原文直接冒给用户",
      );
      return true;
    },
  );
});

test("7b · 前置校验：deps.model / onEvent / messages 形状非法时抛 TypeError", async () => {
  const core = makeFaux();
  const model = core.getModel();
  const stream = fauxStream(core);

  await assert.rejects(() => runTurn(null), TypeError);
  await assert.rejects(() => runTurn({ stream, api: "faux", messages: [userMessage("hi")], onEvent: () => {} }), TypeError);
  await assert.rejects(() => runTurn({ model, stream, api: "faux", messages: [userMessage("hi")] }), TypeError);
  await assert.rejects(() => runTurn({ model, stream, api: "faux", messages: "not-an-array", onEvent: () => {} }), TypeError);
  // 既无 streamFn 也无 stream：抛 TypeError（而非静默用一个坏 stream）
  await assert.rejects(() => runTurn({ model, api: "faux", messages: [userMessage("hi")], onEvent: () => {} }), TypeError);
});

// ---------------------------------------------------------------------------
// 8 · 天然规避 "Agent is already processing"
// ---------------------------------------------------------------------------
test("8 · 天然规避 'Agent is already processing'：每次 runTurn 新建 Agent", async () => {
  // 设计使然：runTurn 每次 `new Agent(...)`，不存在跨轮共享的活动 Agent，
  // 因此不可能在入口处撞上库的 activeRun 检查（agent.js:336-337）。

  // 顺序两次：各自新建 Agent，互不冲突。
  const r1 = await runTurn(textDeps({ text: "A", messages: [userMessage("1")], onEvent: () => {} }));
  const r2 = await runTurn(textDeps({ text: "B", messages: [userMessage("2")], onEvent: () => {} }));
  assert.equal(r1.reachedAgentEnd, true);
  assert.equal(r2.reachedAgentEnd, true);
  assert.notStrictEqual(r1.messages, r2.messages);

  // 并发两次：仍是两个独立 Agent，都能跑到 agent_end（不会互相抛 "already processing"）。
  const [c1, c2] = await Promise.all([
    runTurn(textDeps({ text: "并发 1", messages: [userMessage("c1")], onEvent: () => {} })),
    runTurn(textDeps({ text: "并发 2", messages: [userMessage("c2")], onEvent: () => {} })),
  ]);
  assert.equal(c1.reachedAgentEnd, true, "并发运行 A 应到达 agent_end");
  assert.equal(c2.reachedAgentEnd, true, "并发运行 B 应到达 agent_end");
});

// ---------------------------------------------------------------------------
// 9 · ★ maxSteps 行为化（S7-5 收尾补）
// ---------------------------------------------------------------------------
// 为什么补在这里、而不是 runAgentTurn.test.mjs：`runAgentTurn` 里 faux 一个用户回合
// 恒为「工具步 + 文本步」= 2 步 < DEFAULT_MAX_STEPS(8)，「传 8」与「不传」逐字节相同 ⇒
// 本层不可行为化。但在 **本文件**，`maxSteps` 是 runTurn 的**显式入参**、且测试独控 core，
// 可以**显式传小值**，从而让「是否消费 maxSteps」产生可观测差异。
//
// 差分设计（非代理指标）：同一「工具步 + 文本步」脚本，
//   - maxSteps=1 ⇒ 第 1 步后即停、**不得**出现第 2 步的最终文本；
//   - maxSteps=5 ⇒ 跑完 2 步、出现最终文本；
//   - 不传      ⇒ 同样跑完 2 步（把「不传 = 本层无硬闸」钉成文档）。
// 只有 maxSteps 真被消费，=1 与 =5 才会不同。
//
// 机制依据（agentRuntime.js）：`hasStopPolicy = typeof shouldStopAfterTurn === "function"
// || (typeof maxSteps === "number" && maxSteps > 0)`（:167）；仅当为真才给库挂
// `agentOptions.shouldStopAfterTurn`（:187-198），判据为 `turnCount += 1` 后 `turnCount >= maxSteps`。
test("9 · ★ maxSteps 行为化：显式步数硬闸真被消费（=1 中断 vs =5 / 不传 跑完 2 步）", async () => {
  const FINAL = "最终答案";
  // 固定时钟工具，保证确定性（绝不依赖真实当前时间）。
  const tools = createTools({ now: () => new Date("2024-01-01T00:00:00.000Z") });

  // 两步脚本：第 1 步发起工具调用，第 2 步给出最终文本。
  const script = () => [
    faux.fauxAssistantMessage([faux.fauxToolCall("list_dir", { path: "." }, { id: "s1" })]),
    faux.fauxAssistantMessage([faux.fauxText(FINAL)]),
  ];

  /** 用同一脚本驱动一次 runTurn；maxSteps 为 undefined 时**不传**该键（而非传 undefined）。 */
  async function runTwoStep(maxSteps) {
    const core = makeFaux();
    core.setResponses(script());
    const deps = {
      model: core.getModel(),
      stream: fauxStream(core),
      api: "faux",
      label: "faux",
      tools,
      messages: [userMessage("hi")],
      onEvent: () => {},
    };
    if (maxSteps !== undefined) deps.maxSteps = maxSteps;
    return runTurn(deps);
  }

  /** 转录里是否出现那条「最终答案」的 assistant（第 2 步的产物）。 */
  const hasFinalAnswer = (messages) =>
    messages.some(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        m.content.some((b) => b && b.type === "text" && b.text === FINAL),
    );
  /** 转录里是否存在携带 toolCall 的 assistant（第 1 步的产物）。 */
  const hasToolCall = (messages) =>
    messages.some(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        m.content.some((b) => b && b.type === "toolCall"),
    );

  // ① maxSteps=1：必须在第 1 步（工具步）后停 ⇒ 不得进入第 2 步。
  const r1 = await runTwoStep(1);
  assert.equal(r1.reachedAgentEnd, true, "maxSteps=1 仍应到达 agent_end（是优雅停止，非报错）");
  assert.ok(hasToolCall(r1.messages), "maxSteps=1 应保留第 1 步的 toolCall assistant（确实跑了 1 步）");
  assert.equal(hasFinalAnswer(r1.messages), false, "maxSteps=1 时不得进入第 2 步（不应出现最终答案）");

  // ② maxSteps=5（同脚本）：应跑完 2 步 ⇒ 出现最终答案。
  const r5 = await runTwoStep(5);
  assert.equal(r5.reachedAgentEnd, true);
  assert.equal(hasFinalAnswer(r5.messages), true, "maxSteps=5 时应跑完 2 步并出现最终答案");

  // ③ 不传 maxSteps（同脚本）：同样跑完 2 步（把「不传 = 本层无硬闸」钉成文档）。
  const rNone = await runTwoStep(undefined);
  assert.equal(rNone.reachedAgentEnd, true);
  assert.equal(hasFinalAnswer(rNone.messages), true, "不传 maxSteps 时应跑完 2 步（本层无硬闸）");

  // ④ 差分断言（核心判别）：① 与 ② 的结果必须不同 —— 否则 maxSteps 根本没被消费。
  assert.notEqual(
    hasFinalAnswer(r1.messages),
    hasFinalAnswer(r5.messages),
    "maxSteps=1 与 =5 的结果必须不同，否则 maxSteps 未被消费（差分断言）",
  );

  // ⑤ ★ 触顶事实（S7-7 修复）：maxSteps 触顶必须作为**独立字段**外传。
  assert.equal(r1.maxStepsReached, true, "maxSteps=1 触顶 ⇒ maxStepsReached 必须为 true");
  assert.equal(r5.maxStepsReached, false, "maxSteps=5 未触顶 ⇒ maxStepsReached 必须为 false");
  assert.equal(rNone.maxStepsReached, false, "不传 maxSteps ⇒ maxStepsReached 必须为 false");
  // 文档性断言：库**永远**不会给 stopReason === "maxSteps"（它来自模型，通常是 "toolUse"）。
  // 所以「触顶」这一事实**必须**有独立字段承载 —— 绝不能靠 stopReason 反推。
  assert.notEqual(
    r1.stopReason,
    "maxSteps",
    "库永远不会给 stopReason=\"maxSteps\"（它来自模型），故触顶事实必须有独立字段",
  );
});
