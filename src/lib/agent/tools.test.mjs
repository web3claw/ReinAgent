/**
 * tools 的自动化验证（S7-3）。
 * =====================================================================
 * 全部使用 pi-ai 的 **faux provider 离线驱动**，不联网、不依赖真实 provider，
 * 且**绝不依赖真实当前时间**（`get_current_time` 用注入的固定时钟）。
 *
 * faux 三件套与 S7-2 测试同款（见 `agentRuntime.test.mjs` 顶部注释）：
 *   const faux = await import("@earendil-works/pi-ai/providers/faux");
 *   const core = faux.createFauxCore({ api: "faux", tokenSize: { min: 1, max: 3 } });
 *   core.setResponses([...]); const model = core.getModel();
 * 这些辅助**在本文件里再写一份**（不改 S7-2 的文件）。
 *
 * 覆盖：
 *   1. 两步循环跑通：assistant(toolCall) → toolResult → 最终文本，收敛于 agent_end；
 *   2. ★ 顺序性判别：一轮内两个 toolCall 的 execute 严格不交叠（sequential）；
 *   3. calculate 正确性（1234*5678 / (3+4)*5 / -2+3 / 10/4）；
 *   4. calculate 非法输入 → isError toolResult 且循环继续；
 *   5. 未注册工具名 → isError toolResult（钉住库既有行为）；
 *   5b. ★ stopReason==="length" 截断：该轮 tool call 本体一个都不执行（execute 零调用），
 *       全部转 isError toolResult、循环照常收敛（实测库仍发 tool_execution_start/end，详见该用例）；
 *   6. 结果超 8KB 被截断（content ≤ 8KB、含标记、details 真值、不切断多字节字符）；
 *   7. TOOL_LIMITS 边界压测（256 长度 / 32 层括号 / 深嵌套不栈溢出、毫秒级）；
 *   8. getTools() 返回浅拷贝；导出面与常量值。
 *
 * 运行：node --test src/lib/agent/tools.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { Type } from "typebox";

import { runTurn } from "./agentRuntime.js";
import {
  DEFAULT_MAX_STEPS,
  TOOL_LIMITS,
  TOOLS,
  buildTextToolResult,
  createTools,
  getTools,
} from "./tools.js";

// 运行时从 provider 子入口加载 faux（仅 Node 测试用；不经过 Vite 打包，不拖入桶文件）。
const faux = await import("@earendil-works/pi-ai/providers/faux");

const utf8 = new TextEncoder();

// ---------------------------------------------------------------------------
// 本地辅助（若 S7-2 未导出则自行再写一份，绝不改动 S7-2 的文件）
// ---------------------------------------------------------------------------

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

/**
 * 用 faux 脚本驱动一次真实 `runTurn`。
 * @returns {Promise<{result: object, events: Array<object>}>}
 */
async function runScripted({ responses, tools, userText = "开始" }) {
  const core = makeFaux();
  core.setResponses(responses);
  const model = core.getModel();
  const events = [];
  const result = await runTurn({
    model,
    stream: fauxStream(core),
    api: "faux",
    label: "faux",
    messages: [userMessage(userText)],
    tools,
    onEvent: (ev) => {
      events.push(ev);
    },
  });
  return { result, events };
}

/**
 * 脚本 = [一次 toolCall, 一段最终文本]，返回该工具的结果消息（首个 toolResult）。
 * 用于逐个验证单个工具调用。
 */
async function runOneToolCall({ toolName, args, tools }) {
  const { result } = await runScripted({
    responses: [
      faux.fauxAssistantMessage([faux.fauxToolCall(toolName, args)]),
      faux.fauxAssistantMessage([faux.fauxText("好，已完成。")]),
    ],
    tools,
  });
  const toolResults = result.messages.filter((m) => m.role === "toolResult");
  return { result, toolResult: toolResults[0], toolResults };
}

/** 工具结果里回给模型的纯文本。 */
function resultText(message) {
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

// ---------------------------------------------------------------------------
// 1 · 两步循环跑通
// ---------------------------------------------------------------------------
test("1 · 两步循环：assistant(toolCall) → toolResult → 最终文本，收敛于 agent_end", async () => {
  const tools = createTools({ now: () => new Date("2024-01-02T03:04:05.000Z") });
  const { result, events } = await runScripted({
    responses: [
      faux.fauxAssistantMessage([faux.fauxToolCall("get_current_time", {}, { id: "call-time" })]),
      faux.fauxAssistantMessage([faux.fauxText("时间已取得。")]),
    ],
    tools,
    userText: "现在几点？",
  });

  // 事件序列：含工具执行事件，且以 agent_end 收尾、恰好一次。
  const types = events.map((ev) => ev.type);
  assert.ok(types.includes("tool_execution_start"), "应发出 tool_execution_start");
  assert.ok(types.includes("tool_execution_end"), "应发出 tool_execution_end");
  assert.equal(types[types.length - 1], "agent_end", "最后事件应是 agent_end");
  assert.equal(types.filter((t) => t === "agent_end").length, 1, "agent_end 恰好一次");

  // 转录顺序：assistant(含 toolCall) → toolResult → 最终 assistant。
  const msgs = result.messages;
  const idxToolCall = msgs.findIndex(
    (m) => m.role === "assistant" && m.content.some((c) => c.type === "toolCall"),
  );
  const idxToolResult = msgs.findIndex((m) => m.role === "toolResult");
  let idxFinalAssistant = -1;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i].role === "assistant") {
      idxFinalAssistant = i;
      break;
    }
  }

  assert.ok(idxToolCall >= 0, "应有一条携带 toolCall 的 assistant 消息");
  assert.equal(idxToolResult, idxToolCall + 1, "toolResult 必须紧跟在携带 toolCall 的 assistant 之后");
  assert.ok(idxFinalAssistant > idxToolResult, "最终文本 assistant 必须晚于 toolResult");

  const toolResult = msgs[idxToolResult];
  assert.equal(toolResult.isError, false, "get_current_time 不应报错");
  assert.equal(toolResult.toolName, "get_current_time");
  const text = resultText(toolResult);
  assert.ok(text.length > 0, "工具结果文本不应为空");
  assert.match(text, /ISO 时间：/, "应包含 ISO 串");
  assert.match(text, /2024-01-02/, "注入的固定时钟应生效（本地或 ISO 串里应出现该日期）");

  assert.equal(result.reachedAgentEnd, true);
  assert.equal(result.aborted, false);
});

// ---------------------------------------------------------------------------
// 2 · ★ 顺序性判别（本步重点）
// ---------------------------------------------------------------------------
test("2 · ★ 顺序性判别：一轮内两个 calculate 调用的 execute 严格不交叠（sequential）", async () => {
  const trace = [];
  const yieldAsync = () => new Promise((resolve) => setTimeout(resolve, 5));

  // 用真 `calculate` 包一层 trace 探针：start 与 end 之间插入真实异步让出，
  // 使 `parallel` 下两个 execute 必然交叠、而 `sequential` 下必然不交叠。
  const calculateBase = createTools().find((t) => t.name === "calculate");
  const tracedCalculate = {
    ...calculateBase,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const tag = params.expression;
      trace.push(`${tag}:start`);
      await yieldAsync();
      const outcome = await calculateBase.execute(toolCallId, params, signal, onUpdate);
      trace.push(`${tag}:end`);
      return outcome;
    },
  };

  const { result } = await runScripted({
    responses: [
      faux.fauxAssistantMessage([
        faux.fauxToolCall("calculate", { expression: "1+1" }, { id: "call-a" }),
        faux.fauxToolCall("calculate", { expression: "2+2" }, { id: "call-b" }),
      ]),
      faux.fauxAssistantMessage([faux.fauxText("两次计算完成。")]),
    ],
    tools: [tracedCalculate],
    userText: "算两题",
  });

  assert.deepEqual(
    trace,
    ["1+1:start", "1+1:end", "2+2:start", "2+2:end"],
    `execute 必须严格不交叠（实际 trace：${JSON.stringify(trace)}）`,
  );
  assert.ok(
    trace.indexOf("1+1:end") < trace.indexOf("2+2:start"),
    "前一个 end 必须先于后一个 start（严格不交叠）",
  );

  const toolResults = result.messages.filter((m) => m.role === "toolResult");
  assert.equal(toolResults.length, 2, "应有两个 toolResult");
  assert.equal(toolResults[0].isError, false);
  assert.equal(toolResults[1].isError, false);
  assert.equal(resultText(toolResults[0]), "2");
  assert.equal(resultText(toolResults[1]), "4");
});

// ---------------------------------------------------------------------------
// 3 · calculate 正确性
// ---------------------------------------------------------------------------
test("3 · calculate 正确性：1234*5678 / (3+4)*5 / -2+3 / 10/4", async () => {
  const cases = [
    { expression: "1234 * 5678", expected: 7006652 },
    { expression: "(3+4)*5", expected: 35 },
    { expression: "-2 + 3", expected: 1 },
    { expression: "10/4", expected: 2.5 },
  ];
  for (const { expression, expected } of cases) {
    const { toolResult } = await runOneToolCall({
      toolName: "calculate",
      args: { expression },
      tools: createTools(),
    });
    assert.equal(toolResult.isError, false, `${expression} 不应报错`);
    assert.equal(resultText(toolResult), String(expected), `${expression} 的文本结果应为 ${expected}`);
    assert.equal(toolResult.details.result, expected, `${expression} 的 details.result 应为 ${expected}`);
    assert.equal(toolResult.details.expression, expression);
    assert.equal(toolResult.details.truncated, false);
  }
});

// ---------------------------------------------------------------------------
// 4 · calculate 非法输入 → isError toolResult 且循环继续
// ---------------------------------------------------------------------------
test("4 · calculate 非法输入 → isError toolResult，循环继续并拿到模型回答", async () => {
  const cases = [
    { expression: "1; process.exit(1)", keyword: /非法字符|意外字符/ },
    { expression: "1".repeat(257), keyword: /过长/ },
    { expression: "(".repeat(33) + "1" + ")".repeat(33), keyword: /嵌套|括号/ },
    { expression: "1/0", keyword: /除以零/ },
  ];
  for (const { expression, keyword } of cases) {
    const { result, toolResult } = await runOneToolCall({
      toolName: "calculate",
      args: { expression },
      tools: createTools(),
    });
    const label = expression.length > 20 ? `${expression.slice(0, 12)}…(${expression.length}字符)` : expression;
    assert.equal(toolResult.isError, true, `非法输入应 isError：${label}`);
    assert.match(resultText(toolResult), keyword, `错误信息应命中 ${keyword}（实际：${resultText(toolResult)}）`);

    // 循环继续：最终拿到模型回答，且收敛于 agent_end。
    const last = result.messages[result.messages.length - 1];
    assert.equal(last.role, "assistant", `循环应继续到模型回答：${label}`);
    assert.ok(last.content.some((c) => c.type === "text"), "最终回答应含文本块");
    assert.equal(result.reachedAgentEnd, true);
  }
});

// ---------------------------------------------------------------------------
// 4b · 参数不合 schema → isError toolResult（钉住库的 validateToolArguments 行为）
// ---------------------------------------------------------------------------
test("4b · 参数不合 calculate 的 schema → isError toolResult（库校验兜底）", async () => {
  // 注意：typebox@1.3.27 的 Type.Object 产出的是**纯 JSON Schema**（不带 TypeBox.Kind 符号），
  // 因此 pi-ai 走的是 `coerceWithJsonSchema` 回退路径。这里钉住其行为：schema 不合即 isError。
  const cases = [
    { args: {}, label: "缺 required expression" },
    { args: { expression: { nested: true } }, label: "expression 不是字符串" },
  ];
  for (const { args, label } of cases) {
    const { result, toolResult } = await runOneToolCall({
      toolName: "calculate",
      args,
      tools: createTools(),
    });
    assert.equal(toolResult.isError, true, `应 isError：${label}`);
    assert.match(resultText(toolResult), /validation|expression/i, `应命中库的校验错误：${label}`);
    assert.equal(result.messages[result.messages.length - 1].role, "assistant", "循环应继续");
    assert.equal(result.reachedAgentEnd, true);
  }
});

// ---------------------------------------------------------------------------
// 5 · 未注册工具名 → isError toolResult（钉住库既有行为）
// ---------------------------------------------------------------------------
test("5 · 未注册工具名 → isError toolResult，循环不崩", async () => {
  const { result, toolResult } = await runOneToolCall({
    toolName: "no_such_tool_xyz",
    args: {},
    tools: createTools(),
  });
  assert.equal(toolResult.isError, true, "未注册工具应 isError");
  assert.match(resultText(toolResult), /not found/i, "应命中库的 'Tool X not found'");
  assert.equal(result.messages[result.messages.length - 1].role, "assistant", "循环应继续");
  assert.equal(result.reachedAgentEnd, true);
});

// ---------------------------------------------------------------------------
// 5b · ★ stopReason === "length" 截断（规格 §7.1 唯一此前零覆盖的一条）
// ---------------------------------------------------------------------------
// 规格原文：「stopReason === "length" 截断 | 该轮 assistant 里所有 tool call 一个都不执行，
//   全部产出 isError 的 toolResult（库行为 agent-loop.js:138-140），循环照常收敛」。
//
// ⚠️ 先 dump 再断言（本项目纪律）：实测库对该分支走 `failToolCallsFromTruncatedMessage`
//   （agent-loop.js:304-324），它**仍会发** `tool_execution_start` / `tool_execution_end`
//   （每个 toolCall 各一次），只是**绝不调用工具本体的 execute**。
//   ⇒ 「一个都不执行」的判别点**不是**「tool_execution_start 计数为 0」（实测为 1），
//     而是「工具本体 execute 被调用 0 次」。下面据**实测**行为断言，不迎合任何猜测的形状。
test("5b · ★ stopReason === \"length\" 截断：工具本体一个都不执行、全部转 isError toolResult、循环照常收敛", async () => {
  // 探针：包一层真 calculate，记录 execute 被调用的次数（用于判定「本体是否真被执行」）。
  const calculateBase = createTools().find((t) => t.name === "calculate");

  async function runLengthScenario(stopReason) {
    let executeCalls = 0;
    const spyCalculate = {
      ...calculateBase,
      execute: async (toolCallId, params, signal, onUpdate) => {
        executeCalls += 1;
        return calculateBase.execute(toolCallId, params, signal, onUpdate);
      },
    };
    const { result, events } = await runScripted({
      responses: [
        faux.fauxAssistantMessage([faux.fauxToolCall("calculate", { expression: "1+1" }, { id: "call-len-1" })], {
          stopReason,
        }),
        // 第二步：截断后循环会进入下一轮，给一段正常文本即可收敛。
        faux.fauxAssistantMessage([faux.fauxText("重算完成，结果是 2。")]),
      ],
      tools: [spyCalculate],
    });
    return { result, events, executeCalls };
  }

  const { result, events, executeCalls } = await runLengthScenario("length");

  // ① ★ 核心语义「一个都不执行」：工具本体 execute 绝不被调用。
  //    拆掉库 agent-loop.js:138 的 `message.stopReason === "length"` 三目分支（改走
  //    executeToolCalls）→ executeCalls 变 1 → 本条变红。
  assert.equal(executeCalls, 0, "length 截断时工具本体一个都不许执行（execute 调用数必须为 0）");

  // ② 该 toolCallId 对应的 toolResult 存在且 isError === true。
  const toolResults = result.messages.filter((m) => m.role === "toolResult");
  assert.equal(toolResults.length, 1, "应恰有一条 toolResult（每个被截断的 toolCall 一条）");
  const toolResult = toolResults[0];
  assert.equal(toolResult.toolCallId, "call-len-1", "toolResult 必须与 toolCall 配对");
  assert.equal(toolResult.toolName, "calculate");
  assert.equal(toolResult.isError, true, "截断的 toolCall 必须产出 isError toolResult");
  // 判别点：命中库的「因 token 上限未执行」文案，而非工具真实结果（"2"）或其它错误。
  // 拆掉上面那条三目分支后，这里会拿到工具真实结果 "2"（isError=false）→ 连同 ① 一起变红。
  assert.match(
    resultText(toolResult),
    /was not executed|output token limit/i,
    `应命中库的「截断未执行」文案（实际：${resultText(toolResult)}）`,
  );

  // ③ 循环照常收敛（不是报错终止）：到达 agent_end，且第 2 步正常文本出现。
  assert.equal(result.reachedAgentEnd, true, "截断后循环应照常收敛于 agent_end（非报错终止）");
  assert.equal(result.aborted, false);
  const last = result.messages[result.messages.length - 1];
  assert.equal(last.role, "assistant", "循环应继续进入第 2 步并给出模型回答");
  assert.ok(
    last.content.some((c) => c.type === "text" && c.text.length > 0),
    "第 2 步回答应含非空文本块",
  );

  // ④ 转录合法：每个 toolCall 都有配对 toolResult（不留「有 call 无 result」）。
  const callIds = [];
  for (const m of result.messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) if (b && b.type === "toolCall") callIds.push(b.id);
    }
  }
  assert.ok(callIds.length > 0, "前置：转录里应至少有一个 toolCall");
  const resultIds = new Set(result.messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId));
  for (const id of callIds) {
    assert.ok(resultIds.has(id), `toolCall ${id} 必须有配对的 toolResult（转录不许有 call 无 result）`);
  }

  // ⑤ 判别力对照：换回普通 stopReason，同一探针的 execute **必须**被调用一次。
  //    若探针失效（恒为 0），① 就是假阴性 —— 此对照保证 ① 有判别力。
  const normal = await runLengthScenario("toolUse");
  assert.equal(normal.executeCalls, 1, "对照：非 length 时工具本体必须被执行一次（证明探针有效）");
  assert.equal(
    resultText(normal.result.messages.find((m) => m.role === "toolResult")),
    "2",
    "对照：非 length 时应拿到工具真实结果 2",
  );

  // 事件序列形状记录（非判别点）：库确实发了工具生命周期事件 —— 与「本体不执行」并存。
  const types = events.map((e) => e.type);
  assert.equal(
    types.filter((t) => t === "tool_execution_start").length,
    1,
    "形状记录：库对被截断的 toolCall 仍发一次 tool_execution_start（本体不执行 ≠ 不发事件）",
  );
  assert.ok(types.includes("tool_execution_end"), "形状记录：应发 tool_execution_end");
  assert.equal(types[types.length - 1], "agent_end", "最后事件应是 agent_end");
});

// ---------------------------------------------------------------------------
// 6 · 结果超 8KB 被截断
// ---------------------------------------------------------------------------
// ⚠️ 覆盖纪律（lead 复查发现的盲区）：单用「纯 3 字节字符 + 无前缀」构造时，
//    budget = maxResultBytes - markerBytes 恰好是 3 的整数倍 ⇒ 切点正好落在字符
//    边界上，回退分支**永不触发**，于是只测到「对齐」这一特例。故改为
//    「ASCII 前缀长度 × 字符字节宽度」的笛卡尔积，覆盖预算相对字符边界错开的全部情形，
//    这样断言的是「不切断多字节字符」这个**一般性质**，而非某个对齐特例。
const TRUNCATION_CASES = [];
for (const prefixLen of [0, 1, 2, 3, 4]) {
  for (const [unit, label] of [
    ["é", "2字节(é)"],
    ["中", "3字节(中)"],
    ["🀄", "4字节(🀄 代理对)"],
  ]) {
    TRUNCATION_CASES.push({
      label: `${label}/ASCII前缀${prefixLen}`,
      text: "a".repeat(prefixLen) + unit.repeat(8000),
    });
  }
}

test("6 · 结果超 8KB 被截断：UTF-8 字节安全（全对齐组合）、内容为合法前缀、details 真值", async () => {
  for (const { label, text: ORIGINAL } of TRUNCATION_CASES) {
    const originalBytes = utf8.encode(ORIGINAL).length;
    assert.ok(originalBytes > TOOL_LIMITS.maxResultBytes, `[${label}] 前置：输入必须超 8KB（实际 ${originalBytes}）`);

    const bigTool = {
      name: "big_text",
      label: "超长文本",
      description: "返回一段超长文本（测试用）",
      parameters: Type.Object({}),
      execute: async () => buildTextToolResult(ORIGINAL, { kind: "big" }),
    };

    const { toolResult } = await runOneToolCall({ toolName: "big_text", args: {}, tools: [bigTool] });
    assert.equal(toolResult.isError, false, `[${label}] 不应 isError`);

    const out = resultText(toolResult);
    const outBytes = utf8.encode(out).length;

    // (3) ★ 关键（放最前，让变体失败时直指根因）：绝不切断多字节字符。
    //     这条才是抓「回退被删」的那一条；它同时也保证下面的长度断言不被替换字符带偏。
    assert.equal(out.includes("\uFFFD"), false, `[${label}] 不得产生替换字符 U+FFFD（说明切断了多字节字符）`);

    // (2) 长度上限（截断标记也计入预算）。
    assert.ok(outBytes <= TOOL_LIMITS.maxResultBytes, `[${label}] content 必须 ≤ 8KB（实际 ${outBytes} 字节）`);

    // (4) 截断标记 + details 真值。
    const markerIdx = out.lastIndexOf("\n…[truncated:");
    assert.ok(markerIdx >= 0, `[${label}] 应含截断标记`);
    assert.match(out.slice(markerIdx), /8192/, `[${label}] 截断标记应写明上限 8192`);
    assert.equal(toolResult.details.truncated, true, `[${label}] details.truncated 应为 true`);
    assert.equal(toolResult.details.originalLength, originalBytes, `[${label}] details.originalLength 应为真值`);
    assert.equal(toolResult.details.length, outBytes, `[${label}] details.length 应为截断后字节数`);
    assert.equal(toolResult.details.kind, "big", `[${label}] 业务字段应被保留`);

    // (5) 内容正确性（一般性质）：去掉标记后，剩余部分必须是原文的合法前缀。
    //     用 startsWith 而非等长比较 —— 末字符可能被回退整段丢弃。
    const head = out.slice(0, markerIdx);
    assert.ok(head.length > 0, `[${label}] 截断后应仍保留内容`);
    assert.ok(ORIGINAL.startsWith(head), `[${label}] 截断内容必须是原文的合法前缀（不得切错位置）`);
  }

  // 对照：短文本不截断。
  const short = buildTextToolResult("短文本", { kind: "short" });
  assert.equal(short.details.truncated, false);
  assert.equal(short.details.originalLength, utf8.encode("短文本").length);
  assert.equal(short.content[0].text, "短文本");
});

// ---------------------------------------------------------------------------
// 7 · TOOL_LIMITS 边界压测
// ---------------------------------------------------------------------------
test("7 · TOOL_LIMITS 边界：256 长度 / 32 层括号不抛错、深嵌套不栈溢出、耗时毫秒级", async () => {
  assert.deepEqual(
    TOOL_LIMITS,
    { maxResultBytes: 8192, maxExpressionLength: 256, maxParenDepth: 32 },
    "TOOL_LIMITS 实际值",
  );
  assert.equal(DEFAULT_MAX_STEPS, 8);

  const calculate = createTools().find((t) => t.name === "calculate");

  // 长度恰好 256：32 层括号 + 尾部空白补齐 —— 不抛错、结果正确、毫秒级。
  const expr256 = ("(".repeat(32) + "1" + ")".repeat(32)).padEnd(256, " ");
  assert.equal(expr256.length, 256, "构造的表达式长度应恰好 256");
  let t0 = performance.now();
  const r256 = await calculate.execute("id-256", { expression: expr256 });
  const elapsed256 = performance.now() - t0;
  assert.equal(r256.details.result, 1, "256 长度表达式应正常求值");
  assert.equal(r256.details.truncated, false);
  assert.ok(elapsed256 < 50, `256 长度应毫秒级完成（实际 ${elapsed256.toFixed(3)}ms）`);

  // 括号恰好 32 层：不抛错。
  const deep32 = "(".repeat(32) + "1" + ")".repeat(32);
  const r32 = await calculate.execute("id-32", { expression: deep32 });
  assert.equal(r32.details.result, 1, "恰好 32 层括号应正常求值");

  // 33 层：抛「过深」错误（而非栈溢出）。
  const deep33 = "(".repeat(33) + "1" + ")".repeat(33);
  await assert.rejects(
    () => calculate.execute("id-33", { expression: deep33 }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(!(err instanceof RangeError), "33 层不得是栈溢出（RangeError）");
      assert.match(err.message, /嵌套|括号/);
      return true;
    },
  );

  // 长度恰好 256 的极深嵌套（127 层）：**不栈溢出**，快速抛「过深」。
  const deepDeep = "(".repeat(127) + "1" + ")".repeat(127) + " ";
  assert.equal(deepDeep.length, 256, "深嵌套表达式长度应恰好 256");
  t0 = performance.now();
  await assert.rejects(
    () => calculate.execute("id-deep", { expression: deepDeep }),
    (err) => {
      assert.ok(!(err instanceof RangeError), "深嵌套不得栈溢出");
      assert.match(err.message, /嵌套|括号/);
      return true;
    },
  );
  const elapsedDeep = performance.now() - t0;
  assert.ok(elapsedDeep < 50, `深嵌套应毫秒级抛错（实际 ${elapsedDeep.toFixed(3)}ms）`);

  // 长度 257：抛「过长」（在求值器之前拦下）。
  await assert.rejects(
    () => calculate.execute("id-257", { expression: "1".repeat(257) }),
    (err) => {
      assert.match(err.message, /过长/);
      return true;
    },
  );
  // 长度正好 256 的普通表达式：不抛「过长」。
  const r256b = await calculate.execute("id-256b", { expression: "1+1".repeat(64) });
  assert.equal(r256b.details.truncated, false);
});

// ---------------------------------------------------------------------------
// 8 · 导出面 / getTools() 浅拷贝
// ---------------------------------------------------------------------------
test("8 · getTools() 返回浅拷贝：改动返回数组不影响内部注册表", async () => {
  assert.ok(Array.isArray(TOOLS), "TOOLS 应是数组");
  assert.equal(TOOLS.length, 2, "默认两个工具");
  assert.deepEqual(
    TOOLS.map((t) => t.name),
    ["get_current_time", "calculate"],
    "工具名与顺序",
  );

  const a = getTools();
  const b = getTools();
  assert.notStrictEqual(a, b, "每次返回新数组");
  assert.notStrictEqual(a, TOOLS, "不得直接暴露内部数组");
  assert.equal(a.length, 2);

  // 破坏性改动返回数组。
  const firstBefore = a[0];
  a.push({ name: "injected" });
  a[0] = null;
  a.length = 0;

  const c = getTools();
  assert.equal(c.length, 2, "内部注册表长度不受影响");
  assert.ok(c[0] && c[0].name, "内部元素未被改写");
  assert.strictEqual(c[0], firstBefore, "浅拷贝：元素仍是同一批工具对象引用");
  assert.notStrictEqual(c, a, "仍是新数组");
});
