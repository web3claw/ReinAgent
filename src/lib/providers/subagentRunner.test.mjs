/**
 * subagentRunner 测试（P1-6）：
 *   1. filterToolsFor：Explore 白名单 / general 全量 / 注册表无 agent（结构性禁递归）
 *   2. summarizeSubagentRun：usage 聚合 / 末个文本块 / toolCall 计数
 *   3. 端到端：父轮调 agent 工具 → 嵌套 faux 循环 → 结果/details 格式
 *   4. 未知 subagent_type 如实报错
 *   5. 审批门继承：general-purpose 挂、Explore 不挂
 * 运行：bun test src/lib/providers/subagentRunner.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const faux = await import("@earendil-works/pi-ai/providers/faux");
import { runTurn } from "../agent/agentRuntime.js";
import { getTools } from "../agent/tools.js";
import {
  buildSubagentSystemPrompt,
  createSubagentOutputTool,
  createSubagentTool,
  filterToolsFor,
  summarizeSubagentRun,
  SUBAGENT_MAX_STEPS,
} from "./subagentRunner.ts";

function makeFaux() {
  return faux.createFauxCore({ api: "faux", tokenSize: { min: 1, max: 3 } });
}
function userMessage(text) {
  return { role: "user", content: text, timestamp: 1 };
}
function fauxStream(core) {
  return (model, context, options) => core.stream(model, context, options);
}

// ---------------------------------------------------------------------------
// 1 · filterToolsFor
// ---------------------------------------------------------------------------
test("1 · filterToolsFor：Explore 只留只读白名单；general 全量；注册表无 agent", () => {
  const registry = getTools();
  const names = registry.map((t) => t.name);
  assert.ok(!names.includes("agent"), "前置：注册表本身不含 agent（禁递归的结构性保证）");

  const explore = filterToolsFor("Explore", registry).map((t) => t.name);
  assert.deepEqual(
    explore.slice().sort(),
    ["glob", "grep", "list_dir", "read_file", "webfetch", "websearch"].slice().sort(),
    "Explore 白名单（只读 + 联网检索）",
  );

  const general = filterToolsFor("general-purpose", registry).map((t) => t.name);
  assert.equal(general.length, registry.length, "general-purpose 全量继承");

  // Explore 不得含 exec/write 类工具（结构性只读）
  for (const banned of ["exec_command", "write_file", "edit_file", "delete_file", "background_bash", "task_stop"]) {
    assert.ok(!explore.includes(banned), `Explore 不得包含 ${banned}`);
  }
});

// ---------------------------------------------------------------------------
// 2 · summarizeSubagentRun
// ---------------------------------------------------------------------------
test("2 · summarizeSubagentRun：usage 求和 / 末个非空文本块 / toolCall 计数 / 事实透传", () => {
  const messages = [
    { role: "user", content: "任务" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "..." },
        { type: "toolCall", id: "c1", name: "glob", arguments: {} },
      ],
      usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 5 },
    },
    { role: "toolResult", toolCallId: "c1", content: [] },
    {
      role: "assistant",
      content: [{ type: "text", text: "中间叙述" }, { type: "text", text: "最终报告" }],
      usage: { input: 200, output: 40, cacheRead: 0, cacheWrite: 0 },
    },
  ];
  const s = summarizeSubagentRun(messages, 1234, true, false, "some error");
  assert.equal(s.content, "最终报告", "取末个非空文本块");
  assert.equal(s.toolUseCount, 1);
  assert.deepEqual(s.usage, { input: 300, output: 60, cacheRead: 50, cacheWrite: 5 });
  assert.equal(s.durationMs, 1234);
  assert.equal(s.maxStepsReached, true);
  assert.equal(s.aborted, false);
  assert.equal(s.errorMessage, "some error");
});

// ---------------------------------------------------------------------------
// 3 · 端到端：父轮调 agent 工具 → 嵌套循环 → 结果格式
// ---------------------------------------------------------------------------
test("3 · 端到端：agent 工具嵌套 faux 循环，报告+事实头+details 回到父轮", async () => {
  const registry = getTools();
  // 子代理 faux：glob 一步 + 最终报告一步
  const subCore = makeFaux();
  subCore.setResponses([
    faux.fauxAssistantMessage([faux.fauxToolCall("glob", { pattern: "**/*.ts" })]),
    faux.fauxAssistantMessage([faux.fauxText("调研完成：发现 3 个相关文件")]),
  ]);
  const subTool = createSubagentTool({
    model: subCore.getModel(),
    stream: fauxStream(subCore),
    api: "faux",
    label: "faux",
    getApiKey: () => undefined,
    workspaceRoot: "/w",
    registryTools: registry,
  });

  // 父 faux：第一步调 agent 工具，第二步收尾
  const parentCore = makeFaux();
  parentCore.setResponses([
    faux.fauxAssistantMessage([
      faux.fauxToolCall("agent", { description: "查找 TS 文件", prompt: "找出所有 ts 文件", subagent_type: "Explore" }),
    ]),
    faux.fauxAssistantMessage([faux.fauxText("父轮完成")]),
  ]);
  const parentResult = await runTurn({
    model: parentCore.getModel(),
    stream: fauxStream(parentCore),
    api: "faux",
    label: "faux",
    messages: [userMessage("开始")],
    tools: [subTool],
    onEvent: () => {},
  });

  const toolResult = parentResult.messages.find((m) => m.role === "toolResult");
  assert.ok(toolResult, "父轮应收到 agent 工具结果");
  assert.notEqual(toolResult.isError, true, "不应是错误结果");
  const text = toolResult.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  assert.ok(text.includes("subagent Explore"), "事实头含类型");
  assert.ok(text.includes("调研完成：发现 3 个相关文件"), "子代理最终报告回传");
  const details = toolResult.details ?? {};
  assert.equal(details.kind, "subagent");
  assert.equal(details.subagentType, "Explore");
  assert.equal(details.toolUseCount, 1, "子代理 glob 调用计数");
  assert.equal(typeof details.durationMs, "number");
  assert.equal(details.maxStepsReached, false);
  assert.equal(details.summary, "调研完成：发现 3 个相关文件");
});

// ---------------------------------------------------------------------------
// 4 · 未知类型如实报错
// ---------------------------------------------------------------------------
test("4 · 未知 subagent_type 报错不猜测", async () => {
  const tool = createSubagentTool({
    model: makeFaux().getModel(),
    stream: fauxStream(makeFaux()),
    api: "faux",
    label: "faux",
    getApiKey: () => undefined,
    registryTools: getTools(),
  });
  const result = await tool.execute("call-x", { description: "d", prompt: "p", subagent_type: "mystery-agent" });
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("Unknown subagent_type"));
  assert.ok(result.content[0].text.includes("Explore"));
});

// ---------------------------------------------------------------------------
// 5 · 审批门继承：general-purpose 挂、Explore 不挂
// ---------------------------------------------------------------------------
test("5 · 审批门继承：general-purpose 调用门；Explore 不经过门", async () => {
  const registry = getTools();
  async function runWithType(type) {
    const subCore = makeFaux();
    subCore.setResponses([
      faux.fauxAssistantMessage([faux.fauxToolCall("list_dir", { path: "." })]),
      faux.fauxAssistantMessage([faux.fauxText("done")]),
    ]);
    let gateCalls = 0;
    const tool = createSubagentTool({
      model: subCore.getModel(),
      stream: fauxStream(subCore),
      api: "faux",
      label: "faux",
      getApiKey: () => undefined,
      registryTools: registry,
      beforeToolCall: async () => {
        gateCalls += 1;
        return undefined;
      },
    });
    await tool.execute("call-1", { description: "d", prompt: "p", subagent_type: type });
    return gateCalls;
  }
  assert.equal(await runWithType("general-purpose"), 1, "general-purpose：子代理工具调用经过父审批门");
  assert.equal(await runWithType("Explore"), 0, "Explore：只读工具集不挂门");
});

// ---------------------------------------------------------------------------
// 6 · 常量与提示词
// ---------------------------------------------------------------------------
test("6 · SUBAGENT_MAX_STEPS=6（ZCode 默认 4，实测碎步形态放宽）；系统提示词含工作区与只读声明", () => {
  assert.equal(SUBAGENT_MAX_STEPS, 6);
  const explore = buildSubagentSystemPrompt("Explore", "/w");
  assert.ok(explore.includes("read-only"), "Explore 提示词含只读声明");
  assert.ok(explore.includes("/w"), "含工作区根");
  const general = buildSubagentSystemPrompt("general-purpose");
  assert.ok(general.includes("subagent"), "general 提示词");
  assert.ok(!general.includes("read-only tools"), "general 不声明只读");
});

// ---------------------------------------------------------------------------
// 7 · 后台运行（run_in_background）+ subagent_output（P1-6 增量）
// ---------------------------------------------------------------------------
test("7 · 后台子代理立即返回；subagent_output 查询状态与报告；完成触发通知", async () => {
  const { __resetForTests, getSubagentRunSnapshot } = await import("../subagents/subagentRegistry.ts");
  __resetForTests();
  const registry = getTools();

  // 子代理 faux：一步工具 + 最终报告
  const subCore = makeFaux();
  subCore.setResponses([
    faux.fauxAssistantMessage([faux.fauxToolCall("list_dir", { path: "." })]),
    faux.fauxAssistantMessage([faux.fauxText("后台调研报告正文")]),
  ]);
  const notifications = [];
  const agentTool = createSubagentTool({
    model: subCore.getModel(),
    stream: fauxStream(subCore),
    api: "faux",
    label: "faux",
    getApiKey: () => undefined,
    registryTools: registry,
    notify: async (info) => {
      notifications.push(info);
    },
  });
  const outputTool = createSubagentOutputTool();

  // 1) 启动后台：立即返回 taskId
  const launched = await agentTool.execute("call-bg", {
    description: "后台调研",
    prompt: "p",
    subagent_type: "Explore",
    run_in_background: true,
  });
  assert.notEqual(launched.isError, true);
  const launchText = launched.content[0].text;
  assert.ok(launchText.includes("Background subagent started: sub-"), "返回启动事实");
  assert.ok(launchText.includes("subagent_output"), "提示查询方式");
  const runId = launched.details.subagentId;
  assert.ok(runId, "details 带 subagentId");

  // 2) 立即查询：可能仍 running（异步未推进完）
  const early = await outputTool.execute("call-out", { id: runId });
  assert.notEqual(early.isError, true);
  assert.ok(early.details.status === "running" || early.details.status === "completed");

  // 3) 等后台收束（微任务链）→ 快照 completed + 通知到达
  for (let i = 0; i < 50 && getSubagentRunSnapshot()[0]?.status === "running"; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const record = getSubagentRunSnapshot().find((r) => r.id === runId);
  assert.equal(record?.status, "completed", "后台收束为 completed");
  assert.equal(record?.summary, "后台调研报告正文");
  assert.equal(notifications.length, 1, "完成通知恰一次");
  assert.equal(notifications[0].status, "completed");

  // 4) 查询报告全文
  const report = await outputTool.execute("call-out2", { id: runId });
  assert.ok(report.content[0].text.includes("status: completed"));
  assert.ok(report.content[0].text.includes("后台调研报告正文"));

  // 5) 未知 id 如实报错
  const missing = await outputTool.execute("call-out3", { id: "sub-404" });
  assert.equal(missing.isError, true);
  assert.ok(missing.content[0].text.includes("未找到"));
});
