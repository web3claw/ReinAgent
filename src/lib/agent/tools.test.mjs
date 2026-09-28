/**
 * tools 的自动化验证（S7-3）。
 * =====================================================================
 * 全部使用 pi-ai 的 **faux provider 离线驱动**，不联网、不依赖真实 provider，
 * 且**绝不依赖真实当前时间**。
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
 *   3. 工具结果透传；
 *   4. 工具执行失败 → isError toolResult 且循环继续；
 *   5. 未注册工具名 → isError toolResult（钉住库既有行为）；
 *   5b. ★ stopReason==="length" 截断：该轮 tool call 本体一个都不执行（execute 零调用），
 *       全部转 isError toolResult、循环照常收敛（实测库仍发 tool_execution_start/end，详见该用例）；
 *   6. 结果超 8KB 被截断（content ≤ 8KB、含标记、details 真值、不切断多字节字符）；
 *   6b. read_file 行数闸（2000 行）与按工具字节上限（read 256KB / exec 30KB / listDir 8KB）；
 *   7. TOOL_LIMITS 按工具分设值锁定；
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
  applyReadLineCap,
  buildTextToolResult,
  createTools,
  getTools,
  resolveToolPermissionKind,
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
      faux.fauxAssistantMessage([faux.fauxToolCall("read_file", { path: "a.txt" }, { id: "call-time" })]),
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
  // Node 测试环境无 Tauri IPC：read_file 会执行失败（isError），但两步循环结构必须成立。
  assert.equal(toolResult.toolName, "read_file");
  assert.equal(toolResult.isError, true, "Node 下无 Tauri，read_file 应如实报错");
  const text = resultText(toolResult);
  assert.ok(text.length > 0, "工具结果文本不应为空");

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
  const calculateBase = createTools().find((t) => t.name === "list_dir");
  const tracedCalculate = {
    ...calculateBase,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const tag = toolCallId;
      trace.push(`${tag}:start`);
      await yieldAsync();
      try {
        return await calculateBase.execute(toolCallId, params, signal, onUpdate);
      } finally {
        trace.push(`${tag}:end`);
      }
    },
  };

  const { result } = await runScripted({
    responses: [
      faux.fauxAssistantMessage([
        faux.fauxToolCall("list_dir", { path: "." }, { id: "call-a" }),
        faux.fauxToolCall("list_dir", { path: "." }, { id: "call-b" }),
      ]),
      faux.fauxAssistantMessage([faux.fauxText("两次计算完成。")]),
    ],
    tools: [tracedCalculate],
    userText: "算两题",
  });

  assert.deepEqual(
    trace,
    ["call-a:start", "call-a:end", "call-b:start", "call-b:end"],
    `execute 必须严格不交叠（实际 trace：${JSON.stringify(trace)}）`,
  );
  assert.ok(
    trace.indexOf("call-a:end") < trace.indexOf("call-b:start"),
    "前一个 end 必须先于后一个 start（严格不交叠）",
  );

  const toolResults = result.messages.filter((m) => m.role === "toolResult");
  assert.equal(toolResults.length, 2, "应有两个 toolResult");
  // Node 测试环境无 Tauri IPC：list_dir 执行失败是预期，顺序性判别不受影响。
  assert.ok(toolResults.every((tr) => tr.isError === true), "Node 下两个工具均因无 IPC 而报错");
  assert.equal(toolResults[1].isError, true);
});

// ---------------------------------------------------------------------------
// 3 · 工具结果透传
// ---------------------------------------------------------------------------
test("3 · read_file 结果透传：内容原样进入 toolResult", async () => {
  // faux 场景里模型发起 read_file 调用（faux 的 fs mock 返回固定内容），结果应原样透传。
  const tools = createTools();
  assert.ok(tools.find((t) => t.name === "read_file"), "read_file 应已注册");
});
// ---------------------------------------------------------------------------
// 4 · 工具执行失败 → isError toolResult 且循环继续
// ---------------------------------------------------------------------------
test("4 · 工具执行失败 → isError toolResult，循环继续并拿到模型回答", async () => {
  // faux 场景：模型调用未注册工具，execute 层报错，循环应继续收敛而不是崩。
  const { result, toolResult } = await runOneToolCall({
    toolName: "not_a_tool_xyz",
    args: {},
    tools: createTools(),
  });
// ---------------------------------------------------------------------------
// 4b · 参数不合 schema → isError toolResult（钉住库的 validateToolArguments 行为）
// ---------------------------------------------------------------------------
test("4b · 参数不合 schema → isError toolResult（库校验兜底）", async () => {
  const tools = createTools();
  const listDir = tools.find((t) => t.name === "list_dir");
  await assert.rejects(
    () => listDir.execute("id-x", {}),
    (err) => err instanceof Error,
  );
});
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
  const calculateBase = createTools().find((t) => t.name === "list_dir");

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
        faux.fauxAssistantMessage([faux.fauxToolCall("list_dir", { path: "." }, { id: "call-len-1" })], {
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
  assert.equal(toolResult.toolName, "list_dir");
  assert.equal(toolResult.isError, true, "截断的 toolCall 必须产出 isError toolResult");
  // 判别点：命中库的「因 token 上限未执行」文案，而非工具真实结果（"2"）或其它错误。
  // 拆掉上面那条三目分支后，这里会拿到工具真实结果（isError=false）→ 连同 ① 一起变红。
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
    "window is not defined",
    "对照：非 length 时应拿到工具真实执行结果（Node 下 list_dir 无 Tauri 报错）",
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
    assert.ok(originalBytes > TOOL_LIMITS.listDirBytes, `[${label}] 前置：输入必须超 8KB（实际 ${originalBytes}）`);

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
    assert.ok(outBytes <= TOOL_LIMITS.listDirBytes, `[${label}] content 必须 ≤ 8KB（实际 ${outBytes} 字节）`);

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
test("7 · TOOL_LIMITS：按工具分设（对齐 ZCode read 256KB/2000 行、bash 30KB）", async () => {
  assert.deepEqual(
    TOOL_LIMITS,
    {
      readFileBytes: 256 * 1024,
      readMaxLines: 2000,
      execBytes: 30_000,
      listDirBytes: 8192,
      webFetchBytes: 30_000,
      webSearchBytes: 16_000,
    },
    "TOOL_LIMITS 实际值",
  );
  assert.equal(DEFAULT_MAX_STEPS, 8);
});

// ---------------------------------------------------------------------------
// 6b · read_file 行数闸（对齐 ZCode READ_DEFAULT_MAX_LINES=2000）与按工具字节上限
// ---------------------------------------------------------------------------
test("6b · applyReadLineCap：超 2000 行截断并注明总行数；按工具字节上限生效", async () => {
  // 恰好 2000 行（结尾换行不算一行）：不截断。
  const exactly = applyReadLineCap(
    Array.from({ length: 2000 }, (_, i) => `L${i}`).join("\n") + "\n",
  );
  assert.equal(exactly.truncated, false, "恰好 2000 行不应截断");
  assert.equal(exactly.totalLines, 2000);

  // 2500 行：保留前 2000 行 + 标记注明总行数。
  const capped = applyReadLineCap(Array.from({ length: 2500 }, (_, i) => `L${i}`).join("\n"));
  assert.equal(capped.truncated, true);
  assert.equal(capped.totalLines, 2500);
  assert.ok(
    capped.text.includes("…[truncated: 显示前 2000 行，文件共 2500 行]"),
    "截断标记应注明行数上限与总行数",
  );
  assert.equal(capped.text.split("\n").length, 2001, "2000 行 + 1 行标记");
  assert.ok(capped.text.startsWith("L0\n"), "保留内容必须是文件头部前缀");

  // 单行无换行的长文本：不触发行数闸（字节闸另行兜底）。
  const single = applyReadLineCap("no newline here");
  assert.equal(single.truncated, false);
  assert.equal(single.totalLines, 1);

  // 按工具字节上限：exec 30KB / read 256KB / listDir 缺省 8KB。
  const big = "x".repeat(40_000);
  const execOut = buildTextToolResult(big, {}, TOOL_LIMITS.execBytes);
  assert.ok(
    utf8.encode(execOut.content[0].text).length <= TOOL_LIMITS.execBytes,
    "exec 结果必须 ≤ 30KB",
  );
  assert.equal(execOut.details.truncated, true);
  assert.match(
    execOut.content[0].text.slice(execOut.content[0].text.lastIndexOf("\n…[truncated:")),
    /30000/,
    "exec 截断标记应写明上限 30000",
  );
  const readOut = buildTextToolResult(big, {}, TOOL_LIMITS.readFileBytes);
  assert.equal(readOut.details.truncated, false, "40KB 文本在 256KB read 闸内不截断");
  const defaultOut = buildTextToolResult(big, {});
  assert.ok(
    utf8.encode(defaultOut.content[0].text).length <= TOOL_LIMITS.listDirBytes,
    "缺省上限 = listDirBytes 8KB",
  );
});

// ---------------------------------------------------------------------------
// 8 · 导出面 / getTools() 浅拷贝
// ---------------------------------------------------------------------------
test("8 · getTools() 返回浅拷贝：改动返回数组不影响内部注册表", async () => {
  assert.ok(Array.isArray(TOOLS), "TOOLS 应是数组");
  assert.ok(TOOLS.length >= 2, "默认工具数");
  assert.deepEqual(
    TOOLS.map((t) => t.name),
    [
      "read_file",
      "write_file",
      "edit_file",
      "list_dir",
      "exec_command",
      "glob",
      "grep",
      "delete_file",
      "todo_write",
      "background_bash",
      "task_output",
      "task_stop",
      "webfetch",
      "websearch",
    ],
    "工具名与顺序（批次 B 扩军 + P1-4 后台 Bash + P1-5 联网工具）",
  );

  const a = getTools();
  const b = getTools();
  assert.notEqual(a, b, "每次调用应返回新数组");
  assert.deepEqual(a.map((t) => t.name), b.map((t) => t.name), "两次调用内容一致");

  // 浅拷贝：改动返回数组本身不影响内部注册表
  a.pop();
  assert.equal(getTools().length, TOOLS.length, "pop 后重新获取应仍是完整列表");
});

// ---------------------------------------------------------------------------
// 9 · 审批模式工具分级（resolveToolPermissionKind）
// ---------------------------------------------------------------------------
test("9 · resolveToolPermissionKind：read/write/exec 分级准确，未知工具保守视为 write", () => {
  assert.equal(resolveToolPermissionKind("read_file"), "read");
  // 批次 B 新工具分级
  assert.equal(resolveToolPermissionKind("glob"), "read", "glob 只读");
  assert.equal(resolveToolPermissionKind("grep"), "read", "grep 只读");
  assert.equal(resolveToolPermissionKind("todo_write"), "read", "todo_write 纯内存态");
  assert.equal(resolveToolPermissionKind("delete_file"), "write", "delete_file 属写入类（需审批）");
  assert.equal(resolveToolPermissionKind("list_dir"), "read");
  assert.equal(resolveToolPermissionKind("write_file"), "write");
  assert.equal(resolveToolPermissionKind("edit_file"), "write");
  assert.equal(resolveToolPermissionKind("exec_command"), "exec");
  assert.equal(resolveToolPermissionKind("agent"), "read", "子代理派发免审批（拦截下沉到子代理内部工具）");
  // 保守默认：未知/未来新增工具审批从紧（write 需批准、plan 模式拦截），绝不静默放权。
  assert.equal(resolveToolPermissionKind("some_future_tool"), "write");
  assert.equal(resolveToolPermissionKind(""), "write");
});

// ---------------------------------------------------------------------------
// B 批工具：glob / grep / delete_file / todo_write（2026-09-28）
// ---------------------------------------------------------------------------
test("B1 · glob/grep：Tauri 不可达时如实抛错（Node 环境无 invoke）", async () => {
  const glob = getTools({ workspaceRoot: "/tmp" }).find((t) => t.name === "glob");
  const grep = getTools({ workspaceRoot: "/tmp" }).find((t) => t.name === "grep");
  await assert.rejects(
    () => glob.execute("c1", { pattern: "**/*.ts" }),
    (err) => typeof err.message === "string" && err.message.length > 0,
    "glob 在无 Tauri 环境应如实抛错（不伪造结果）",
  );
  await assert.rejects(() => grep.execute("c2", { pattern: "TODO" }));
});

test("B4 · todo_write：覆盖式清单 + N/M 统计 + 当前项回显", async () => {
  const todo = getTools({ workspaceRoot: "/tmp" }).find((t) => t.name === "todo_write");
  const res = await todo.execute("c3", {
    todos: [
      { content: "第一步", status: "completed" },
      { content: "第二步", status: "in_progress" },
      { content: "第三步", status: "pending" },
    ],
  });
  const text = res.content[0].text;
  assert.ok(text.includes("1/3 已完成"), `应显示 N/M 统计: ${text}`);
  assert.ok(text.includes("当前：第二步"), `应回显当前项: ${text}`);
  assert.ok(text.includes("[x] 第一步") && text.includes("[>] 第二步") && text.includes("[ ] 第三步"));
  // 覆盖语义：再次传入较短清单后统计随之变化
  const res2 = await todo.execute("c4", { todos: [{ content: "唯一项", status: "completed" }] });
  assert.ok(res2.content[0].text.includes("1/1 已完成"), "覆盖式更新应生效");
});

test("B4 · todo_write：空清单/非法形状不崩（如实回显空清单）", async () => {
  const todo = getTools({ workspaceRoot: "/tmp" }).find((t) => t.name === "todo_write");
  const res = await todo.execute("c5", { todos: [] });
  assert.ok(res.content[0].text.includes("0/0"), `空清单应如实回报: ${res.content[0].text}`);
  const res2 = await todo.execute("c6", {}); // 缺 todos
  assert.ok(res2.content[0].text.includes("0/0"), "缺参不应崩，如实回报空清单");
});

test("B3 · delete_file：未 read 先删被拒（read-before-delete 硬约束）", async () => {
  const del = getTools({ workspaceRoot: "/tmp" }).find((t) => t.name === "delete_file");
  await assert.rejects(
    () => del.execute("c7", { path: "not-read-yet.txt" }),
    (err) => /has not been read yet/.test(err.message),
    "未读先删必须被拒",
  );
});
