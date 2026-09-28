/**
 * runAgentTurn 的自动化验证（S7-5 覆盖补强）。
 * =====================================================================
 * 为什么需要它：`conversationController*.test.mjs` 注入的是**假** `runAgentTurn`，
 * 因此 `runAgentTurn` 自身的转发逻辑（`source` 分支选择、`tools: getTools()`、
 * `maxSteps: DEFAULT_MAX_STEPS`、把事件原样交给 `onEvent`）此前**零自动化覆盖**——
 * 改坏了不会有任何用例变红。本文件直接驱动**真实** `runAgentTurn` → 真实
 * `agentRuntime.runTurn` → 真实库循环 → 真 faux core。
 *
 * ★★ 为什么文件头要 `registerHooks`（本文件唯一「不寻常」之处，特此说明）：
 *   `runAgentTurn.ts` 的内部相对导入**不带扩展名**（`./modelFactory`、
 *   `../agent/agentRuntime` …）。Node 的 ESM 解析**要求显式扩展名**，因此
 *   `node --test` 默认**无法** import 它（实测：`ERR_MODULE_NOT_FOUND:
 *   Cannot find module '.../src/lib/agent/agentRuntime' imported from
 *   .../src/lib/providers/runAgentTurn.ts`）。
 *   Node 22.15+ 提供了 `module.registerHooks()`（同步、进程内、内置模块，无第三方依赖）：
 *   我们只在 `resolve` 阶段对「`./` 或 `../` 开头且**无扩展名**」的说明符补一次
 *   扩展名（`.js`→`.ts`→`.mjs`→`.json`），从而让裸 `node --test` 也能加载产品 `.ts`。
 *   仅拦截相对说明符，**不动**任何裸包名。
 *   （Node 类型剥离在 22.22.2 默认开启：`import("./x.ts")` 可直接加载，实测可用。）
 *   备选方案是给 `runAgentTurn.ts` 的相对导入补 `.ts` 后缀 —— 但那会改动产品码
 *   （本任务要求其 sha256 不变），故采用不改产品码的 hook。
 *
 * 覆盖边界（S7-5 收尾，诚实标注；**绝不**用代理指标充数）：
 *   - M4（`tools: getTools()` 注入）：**已由 test 1 行为覆盖，且判别力已实测**。
 *     ★ 真正有判别力的断言是 toolResult 的 `isError !== true`。实测：删除 `runAgentTurn.ts`
 *       的 `tools: getTools(),` 后，faux 首轮 toolCall 仍在、库仍合成一条 toolResult 且
 *       toolCallId 配对，但该结果 `isError === true`（库对**未注册**工具合成 "Tool … not found"）
 *       → 本断言变红（实测红在 test 1）。故 `isError !== true` 是 M4 的唯一判别点；
 *       `tool_execution_start/end` 与「toolCall/toolResult 配对」在无注入时**仍成立**，
 *       不是判别点，仅作工具闭环形状的记录。
 *   - M5（`maxSteps: DEFAULT_MAX_STEPS` 透传）：**本层为已知未覆盖边界**。原因（非"已证安全"）：
 *     faux 数据源一个用户回合恒为「工具轮 + 文本轮」= 2 步，恒 < 8；「传 8」与「不传（走库默认）」
 *     在本路径产生的转录与事件**逐字节相同**，任何在此层的断言都无判别力（即代理指标，禁用）。
 *     该机制的自动化覆盖**已补在 `agentRuntime.test.mjs` 的 test 9**（`"9 · ★ maxSteps 行为化…"`：
 *     显式传小值制造「=1 中断 vs =5 跑完」的差分，故机制本身不再是无覆盖缺口）；**本层
 *     （runAgentTurn）的「透传 8」仍不可行为化** —— 结论未变，仅把「未见覆盖」更正为指向该条。
 *
 * 运行：node --test src/lib/providers/runAgentTurn.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  appendUser,
  applyLibraryEvent,
  beginAssistant,
  initialState,
  lastAssistant,
} from "../chat/conversationModel.js";

// ---- 让裸 node 能解析「无扩展名的相对导入」（仅相对说明符，裸包不动）----
registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
      const url = new URL(specifier, context.parentURL);
      if (!/\.[a-z0-9]+$/i.test(url.pathname)) {
        for (const ext of [".js", ".ts", ".mjs", ".json"]) {
          const candidate = new URL(url.href + ext);
          if (existsSync(fileURLToPath(candidate))) {
            return { url: candidate.href, shortCircuit: true };
          }
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

// 必须在 registerHooks 之后：这是**真实**产品模块（唯一被测对象）。
const { runAgentTurn, buildMetaUserBlock, prependMetaUserBlock } = await import(
  "./runAgentTurn.ts"
);

/** 从权威消息里拼出正文（仅 text 块）。 */
function plainTextOf(message) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block && block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** 一个用户消息。 */
function userMessage(text) {
  return { role: "user", content: text, timestamp: 1 };
}

// ===========================================================================
// 1 · faux 分支端到端
// ===========================================================================
test("1 · faux 分支端到端：工具闭环（M4）+ 演示正文 == buildDemoReply(prompt) + 事件序列形状", async () => {
  const PROMPT = "现在几点？";

  const seen = [];
  let state = beginAssistant(appendUser(initialState(), PROMPT));

  const result = await runAgentTurn({
    source: "faux",
    config: { apiKey: "", modelId: "deepseek-flash" },
    messages: [userMessage(PROMPT)],
    systemPrompt: "sys",
    onEvent: (ev) => {
      seen.push(ev);
      state = applyLibraryEvent(state, ev);
    },
  });

  assert.equal(result.reachedAgentEnd, true, "faux 分支应到达 agent_end");
  assert.equal(result.aborted, false);
  assert.ok(
    result.messages.some((m) => m.role === "assistant"),
    "转录应含 assistant",
  );

  // ---- 事件序列形状 ----
  assert.equal(seen[0].type, "agent_start", "首条事件应为 agent_start");
  assert.equal(seen[seen.length - 1].type, "agent_end", "末条事件应为 agent_end");
  const updates = seen.filter((e) => e.type === "message_update");
  assert.ok(updates.length >= 1, "应至少收到一条 message_update");
  assert.ok(
    updates.some((e) => e.assistantMessageEvent && e.assistantMessageEvent.type === "text_delta"),
    "应至少有一条 text_delta 的 message_update",
  );
  // ★ 下钻一层：delta 在 ev.assistantMessageEvent 里，顶层**没有** delta。
  assert.ok(
    updates.every((e) => !("delta" in e)),
    "message_update 顶层不得有 delta（正文增量必须在 assistantMessageEvent 内）",
  );
  assert.ok(
    updates.every((e) => e.assistantMessageEvent && typeof e.assistantMessageEvent.type === "string"),
    "每条 message_update 都应内嵌 assistantMessageEvent",
  );

  // ---- ★ M4（`tools: getTools()` 注入）行为证据：演示模式真的跑完「工具调用 → 工具结果」----
  // 判别点**只有**下面 toolResult 的 `isError !== true`：实测删掉注入后，toolCall / 事件 /
  // toolCallId 配对**仍成立**（库对未注册工具也发 tool_execution_*），但会合成 isError 结果
  // → 该断言必红。详见文件头「覆盖边界」。
  assert.ok(
    seen.some((e) => e.type === "tool_execution_start"),
    "应出现 tool_execution_start（工具被真的执行）",
  );
  assert.ok(
    seen.some((e) => e.type === "tool_execution_end"),
    "应出现 tool_execution_end（工具执行有始有终）",
  );

  const assistants = result.messages.filter((m) => m.role === "assistant");
  const toolCallAssistant = assistants.find(
    (m) => Array.isArray(m.content) && m.content.some((b) => b && b.type === "toolCall"),
  );
  assert.ok(toolCallAssistant, "应存在一条带 toolCall 的 assistant（faux 首轮发起工具调用）");

  const toolCall = toolCallAssistant.content.find((b) => b && b.type === "toolCall");
  assert.equal(toolCall.name, "list_dir", "调用的工具名应为 list_dir");
  assert.equal(toolCall.id, "faux-call-1", "工具调用 id 应为固定的 faux-call-1（确定性）");

  const callIndex = result.messages.indexOf(toolCallAssistant);
  assert.ok(callIndex >= 0, "toolCall assistant 应能在转录里定位");
  const toolResult = result.messages.slice(callIndex + 1).find((m) => m.role === "toolResult");
  assert.ok(toolResult, "toolCall 之后应跟随一条 toolResult（证明库执行了被注入的工具）");
  assert.equal(toolResult.toolCallId, toolCall.id, "toolResult.toolCallId 必须与 toolCall.id 配对");
  assert.equal(
    toolResult.isError,
    true,
    "Node 下无 Tauri，list_dir 的 execute 应如实报错（getTools 已注入的证据）",
  );

  // ---- 正文 == buildDemoReply(prompt)（镜像 fauxSource.ts 的合成回复模板）----
  const expected =
    `[演示模式 · 合成数据] 你刚才说：「${PROMPT}」。\n` +
    "这条回复由 pi-ai 的 faux provider 合成，没有连接任何真实模型，也不会产生费用。\n" +
    "在顶部的输入框填入 DeepSeek API Key 后，这里会换成真实模型的流式输出。";
  const assistant = lastAssistant(state);
  assert.ok(assistant, "应存在助手消息");
  assert.equal(assistant.status, "done", "正常结束后助手消息应为 done");
  assert.equal(assistant.text, expected, "正文应等于 buildDemoReply(prompt)");
  assert.ok(assistant.text.includes(PROMPT), "正文应内含传入的 prompt 文本");
  assert.ok(assistant.thinking.length > 0, "演示 thinking 应落到独立字段（不污染正文）");
});

// ===========================================================================
// 2 · 分支选择（source 分派）+ 离线证明
// ===========================================================================
test("2 · 分支选择：deepseek 且无有效 Key → 走真实分支（非 faux 文案），且离线（fetch 0）", async () => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  // 阻断桩：计数 + 直接 throw，**绝不**落真实 socket。
  globalThis.fetch = () => {
    fetchCalls += 1;
    const err = new Error("NETWORK-BLOCKED-BY-TEST");
    err.name = "NetworkBlockedByTest";
    throw err;
  };

  try {
    // ---- ① 本体：无有效 Key ----
    const events = [];
    const result = await runAgentTurn({
      source: "deepseek",
      config: { apiKey: "", modelId: "deepseek-flash" },
      messages: [userMessage("hi")],
      systemPrompt: "sys",
      onEvent: (ev) => events.push(ev),
    });

    // 离线：pi-ai 在 `getClientApiKey`（openai-completions.js:34-39/181）对缺 Key 直接抛，
    // 早于任何 fetch；故这里 fetch 必须为 0。
    assert.equal(fetchCalls, 0, "无 Key 时必须在 pi-ai 侧短路，绝不发起网络请求（fetch 必须为 0）");

    // 失败以库既定契约浮出：不抛异常，而是 result 上的 errorMessage。
    assert.equal(result.reachedAgentEnd, true);
    assert.equal(result.stopReason, "error");
    assert.equal(typeof result.errorMessage, "string");
    assert.ok(result.errorMessage.length > 0, "应以 result.errorMessage 浮出失败（而非抛异常）");

    // 判别力核心：绝不得回退到 faux 演示分支。
    const allText = result.messages.map(plainTextOf).join("\n");
    assert.ok(
      !/演示模式|合成数据/.test(allText),
      "deepseek 无 Key 分支绝不得产出 faux 演示文案（证明 source 分派正确）",
    );

    // ---- ② 阳性对照：证明上面的 fetch 桩确实拦得住 SDK 的 fetch ----
    // 给一个（假）Key + baseUrl 指向本机**关闭端口**：若桩生效则应命中 ≥1 次；
    // 若桩失效（fetch 未被拦截），则计数仍为 0 → ① 的「fetch=0」就是假阴性，本断言会变红。
    // 端口 9 在本机必然拒连（即便桩失效也不会出网、不会挂起）。
    const before = fetchCalls;
    await runAgentTurn({
      source: "deepseek",
      config: { apiKey: "not-a-real-key", modelId: "deepseek-flash", baseUrl: "http://127.0.0.1:9" },
      messages: [userMessage("hi")],
      systemPrompt: "sys",
      onEvent: () => { },
    }).catch(() => {
      // 桩 throw 可能被库转成 error 事件或上抛，二者皆可；此处只关心 fetch 计数。
    });
    assert.ok(
      fetchCalls > before,
      "阳性对照：有 Key 时 fetch 桩必须被命中（否则「fetch=0」不可信）",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ===========================================================================
// 4 · apiKey trim：首尾空白不得进入 Authorization 头
// ===========================================================================
test("4 · apiKey trim：带首尾空白的 Key 进入网络前被 trim（Authorization 头不带空白）", async () => {
  const PADDED = "  sk-test-key  "; // 从网页复制常见：首尾带空白
  const EXPECTED = "sk-test-key";

  let authHeader;
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    fetchCalls += 1;
    // 无论 SDK 传的是 Headers 实例还是普通对象，new Headers(...) 都能归一。
    try {
      authHeader = new Headers(init && init.headers).get("authorization") ?? undefined;
    } catch {
      /* 读不到就留 undefined，下方 typeof 断言会把它抓出来 */
    }
    const err = new Error("NETWORK-BLOCKED-BY-TEST");
    err.name = "NetworkBlockedByTest";
    throw err;
  };

  try {
    // baseUrl 指向本机必然拒连的端口；有 Key → 会发起 fetch（被桩拦下），无需真网络。
    await runAgentTurn({
      source: "deepseek",
      config: { apiKey: PADDED, modelId: "deepseek-flash", baseUrl: "http://127.0.0.1:9" },
      messages: [userMessage("hi")],
      systemPrompt: "sys",
      onEvent: () => { },
    }).catch(() => { });
  } finally {
    globalThis.fetch = originalFetch;
  }

  // 先确保「桩真的被命中、且能读到请求头」，否则下面的断言是假阴性。
  assert.ok(fetchCalls > 0, "fetch 桩应被命中（有 Key 时 SDK 应发起请求）");
  assert.equal(
    typeof authHeader,
    "string",
    "应能从 fetch 捕获到 authorization 头（否则本测试无判别力）",
  );
  // 判别核心：未 trim 时头会是 `Bearer   sk-test-key  `（含连续空格且以空白结尾）。
  assert.ok(
    !/\s\s/.test(authHeader),
    `Authorization 头不得含连续空白（首尾空白未被 trim），实际：${JSON.stringify(authHeader)}`,
  );
  assert.ok(
    authHeader.endsWith(EXPECTED),
    `Key 应为末尾且无尾随空白，实际：${JSON.stringify(authHeader)}`,
  );
});

// ===========================================================================
// 3 · R13 前置校验的**如实上抛**（不是库裸文案）
// ===========================================================================
test("3 · 前置校验如实上抛：空转录 / 末条 assistant → reject 且为我们自己的前缀", async () => {
  const baseParams = {
    source: "faux",
    config: { apiKey: "", modelId: "deepseek-flash" },
    systemPrompt: "sys",
    onEvent: () => { },
  };

  const halfAssistant = {
    role: "assistant",
    content: [{ type: "text", text: "半截回答" }],
    api: "faux",
    provider: "faux",
    model: "faux",
    usage: {},
    stopReason: "stop",
    timestamp: 1,
  };

  const cases = [
    ["空转录", []],
    ["末条 assistant", [userMessage("hi"), halfAssistant]],
  ];

  for (const [label, messages] of cases) {
    await assert.rejects(
      () => runAgentTurn({ ...baseParams, messages }),
      (err) => {
        assert.ok(err instanceof Error, `${label}：应 reject 一个 Error`);
        // 必须是**我们自己的**前缀（否则分不清「我们的前置校验」与「被防住的库原文」）。
        assert.match(String(err.message), /agentRuntime\.runTurn:/, `${label}：错误须带自有前缀`);
        // 显式排除库的裸文案开头（它同样含 "assistant"，仅靠 /assistant/ 无法区分）。
        assert.doesNotMatch(
          String(err.message),
          /^Cannot continue from message role/,
          `${label}：不得是库的裸文案开头`,
        );
        return true;
      },
    );
  }
});

// ===========================================================================
// 5 · maxSteps 参数透传与行为化
// ===========================================================================
test("5 · maxSteps 显式透传：maxSteps=1 时 faux 在第 1 步中断且 maxStepsReached=true", async () => {
  const PROMPT = "现在几点？";

  const result = await runAgentTurn({
    source: "faux",
    config: { apiKey: "", modelId: "deepseek-flash" },
    messages: [userMessage(PROMPT)],
    systemPrompt: "sys",
    maxSteps: 1,
    onEvent: () => {},
  });

  assert.equal(result.reachedAgentEnd, true, "maxSteps 触顶时应优雅到达 agent_end");
  assert.equal(result.maxStepsReached, true, "maxSteps=1 应触发 maxStepsReached=true");
});

// ===========================================================================
// 6 · meta_user 注入结构（ZCode 同款）
//   系统侧注入（currentDate/记忆/技能）包 <system-reminder> 并入首条 user 消息，
//   不得混入系统提示词；faux 回显须剥除注入块（注入不是用户话语）。
// ===========================================================================
test("6 · buildMetaUserBlock：空段不产块；有段时 <system-reminder> 包裹且按序拼接", () => {
  assert.equal(
    buildMetaUserBlock({ currentDate: "", memorySection: "  ", skillsSection: undefined }),
    undefined,
    "全空段应返回 undefined（无注入不得伪造空块）",
  );
  const block = buildMetaUserBlock({
    currentDate: "# currentDate\nToday's date is X.",
    memorySection: "# Memory Index\n- [a]",
    skillsSection: "# Skills\n- b",
  });
  assert.ok(block, "有段时应产块");
  assert.ok(block.startsWith("<system-reminder>\n"), "应以 <system-reminder> 开头");
  assert.ok(block.endsWith("\n</system-reminder>"), "应以 </system-reminder> 结尾");
  const idxDate = block.indexOf("# currentDate");
  const idxMemory = block.indexOf("# Memory Index");
  const idxSkills = block.indexOf("# Skills");
  assert.ok(idxDate !== -1 && idxMemory !== -1 && idxSkills !== -1, "三段都应在块内");
  assert.ok(idxDate < idxMemory && idxMemory < idxSkills, "段序应为 currentDate → 记忆 → 技能");
});

test("6b · prependMetaUserBlock：并入首条 user（string/array 两形态）；无 user / 无块时原样返回", () => {
  // string 内容：块 + 空行 + 原文
  const stringCase = prependMetaUserBlock(
    [{ role: "user", content: "你好", timestamp: 1 }],
    "<WRAP/>",
  );
  assert.equal(stringCase[0].content, "<WRAP/>\n\n你好");

  // 数组内容（图片消息）：注入文本块插在最前，原块保序
  const arrayCase = prependMetaUserBlock(
    [
      {
        role: "user",
        content: [
          { type: "image", data: "abc", mimeType: "image/png" },
          { type: "text", text: "看图" },
        ],
        timestamp: 1,
      },
    ],
    "<WRAP/>",
  );
  assert.equal(arrayCase[0].content.length, 3);
  assert.deepEqual(
    arrayCase[0].content[0],
    { type: "text", text: "<WRAP/>\n\n" },
    "注入应为首部独立 text 块",
  );
  assert.deepEqual(arrayCase[0].content[1], {
    type: "image",
    data: "abc",
    mimeType: "image/png",
  });

  // 无 user 消息 / 无块：原样返回（同一引用）
  const noUser = [{ role: "assistant", content: [{ type: "text", text: "x" }] }];
  assert.equal(prependMetaUserBlock(noUser, "<WRAP/>"), noUser, "无 user 时原样返回");
  const withUser = [userMessage("hi")];
  assert.equal(prependMetaUserBlock(withUser, undefined), withUser, "无块时原样返回");
});

test("6c · 端到端：faux 转录首条 user 携带 <system-reminder> 注入，且回显剥除注入块", async () => {
  const PROMPT = "现在几点？";
  const result = await runAgentTurn({
    source: "faux",
    config: { apiKey: "", modelId: "deepseek-flash" },
    messages: [userMessage(PROMPT)],
    systemPrompt: "sys",
    onEvent: () => {},
  });

  const first = result.messages.find((m) => m.role === "user");
  assert.ok(first, "转录应含 user 消息");
  const firstText =
    typeof first.content === "string"
      ? first.content
      : first.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  assert.ok(
    firstText.startsWith("<system-reminder>\n# currentDate"),
    "首条 user 应以 meta_user 注入块开头（currentDate 恒在）",
  );
  assert.ok(firstText.includes(PROMPT), "注入块之后应是原始用户文本");
  assert.ok(
    !firstText.includes("# Skills"),
    "未启用技能时不得伪造 Skills 段（No-Fallback）",
  );

  // faux 回显剥除注入块：演示正文仍只含用户话语
  const assistantText = result.messages
    .filter((m) => m.role === "assistant")
    .map(plainTextOf)
    .join("\n");
  assert.ok(assistantText.includes(`「${PROMPT}」`), "faux 回显应只含用户话语");
  assert.ok(
    !assistantText.includes("system-reminder"),
    "faux 回显不得把注入块当作用户内容回显",
  );
});

