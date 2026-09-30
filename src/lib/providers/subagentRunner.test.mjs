/**
 * subagentRunner 测试（定义驱动改造后，2026-10-01 对齐 PI-Desktop 子智能体目录）：
 *   1. filterToolsForDefinition：定义白名单过滤 / 注册表无 agent（结构性禁递归）
 *   2. summarizeSubagentRun：usage 聚合 / 末个非空文本块 / toolCall 计数
 *   3. 端到端：父轮调 agent 工具（旧值 Explore 兼容）→ 嵌套 faux 循环 → 结果/details 格式
 *   4. 未知句柄如实报错（列出可用目录）
 *   5. 审批门按可改动性挂载：fixer（mutating）挂、explorer 不挂
 *   6. 目录渲染进工具描述 + composeSubagentSystemPrompt
 *   7. 后台运行 + subagent_output + 完成通知
 * 运行：bun test src/lib/providers/subagentRunner.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const faux = await import("@earendil-works/pi-ai/providers/faux");
import { runTurn } from "../agent/agentRuntime.js";
import { getTools } from "../agent/tools.js";
import { builtinSubagentDefinitions, normalizeSubagentHandle } from "../subagents/subagentDefinitions.ts";
import {
  composeSubagentSystemPrompt,
  createSubagentOutputTool,
  createSubagentTool,
  filterToolsForDefinition,
  subagentCanMutate,
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
function testCatalog() {
  const definitions = builtinSubagentDefinitions().definitions;
  return { definitions, builtins: [], userRecords: [], diagnostics: [] };
}

// ---------------------------------------------------------------------------
// 1 · filterToolsForDefinition
// ---------------------------------------------------------------------------
test("1 · filterToolsForDefinition：白名单生效；注册表无 agent（结构性禁递归）", () => {
  const registry = getTools();
  assert.ok(!registry.map((t) => t.name).includes("agent"), "注册表本身不含 agent");
  const reviewer = builtinSubagentDefinitions().definitions.find((d) => d.name === "code-reviewer");
  const filtered = filterToolsForDefinition(reviewer, registry).map((t) => t.name);
  assert.deepEqual(filtered.slice().sort(), ["glob", "grep", "read_file"].slice().sort());
  for (const banned of ["exec_command", "write_file", "edit_file", "delete_file", "background_bash"]) {
    assert.ok(!filtered.includes(banned), `code-reviewer 不得包含 ${banned}`);
  }
});

// ---------------------------------------------------------------------------
// 2 · summarizeSubagentRun
// ---------------------------------------------------------------------------
test("2 · summarizeSubagentRun：usage 求和 / 末个非空文本块 / toolCall 计数", () => {
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
// 3 · 端到端（旧值 Explore 兼容映射 explorer）
// ---------------------------------------------------------------------------
test("3 · 端到端：父轮调 agent（subagent_type=Explore）→ 嵌套循环 → 报告回传", async () => {
  const registry = getTools();
  const subCore = makeFaux();
  subCore.setResponses([
    faux.fauxAssistantMessage([faux.fauxToolCall("glob", { pattern: "**/*.ts" })]),
    faux.fauxAssistantMessage([faux.fauxText("调研完成：发现 3 个相关文件")]),
  ]);
  const subTool = await createSubagentTool({
    model: subCore.getModel(),
    stream: fauxStream(subCore),
    api: "faux",
    label: "faux",
    getApiKey: () => undefined,
    workspaceRoot: "/w",
    registryTools: registry,
    catalog: testCatalog(),
  });

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
  assert.ok(text.includes("subagent explorer"), "事实头含句柄（旧值已映射）");
  assert.ok(text.includes("调研完成：发现 3 个相关文件"), "子代理最终报告回传");
  const details = toolResult.details ?? {};
  assert.equal(details.kind, "subagent");
  assert.equal(details.subagentType, "explorer");
  assert.equal(details.toolUseCount, 1, "子代理 glob 调用计数");
  assert.equal(typeof details.durationMs, "number");
  assert.equal(details.maxStepsReached, false);
  assert.equal(details.summary, "调研完成：发现 3 个相关文件");
});

// ---------------------------------------------------------------------------
// 4 · 未知句柄如实报错
// ---------------------------------------------------------------------------
test("4 · 未知 subagent_type 报错并列出可用目录", async () => {
  const tool = await createSubagentTool({
    model: makeFaux().getModel(),
    stream: fauxStream(makeFaux()),
    api: "faux",
    label: "faux",
    getApiKey: () => undefined,
    registryTools: getTools(),
    catalog: testCatalog(),
  });
  const result = await tool.execute("call-x", { description: "d", prompt: "p", subagent_type: "mystery-agent" });
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("Unknown subagent_type"));
  assert.ok(result.content[0].text.includes("explorer"), "目录里列 explorer");
  assert.ok(result.content[0].text.includes("ui-designer"), "目录里列 ui-designer");
});

// ---------------------------------------------------------------------------
// 5 · 审批门按可改动性挂载
// ---------------------------------------------------------------------------
test("5 · 审批门：fixer/explorer（含 exec）调门；code-reviewer（纯只读）不经过门", async () => {
  const registry = getTools();
  async function runWithType(type, toolCallName) {
    const subCore = makeFaux();
    subCore.setResponses([
      // ⚠ 参数必须过工具 schema（参数校验在审批门之前，校验失败不会进门）
      faux.fauxAssistantMessage([faux.fauxToolCall(toolCallName, toolCallName === "glob" ? { pattern: "**/*" } : { path: "." })]),
      faux.fauxAssistantMessage([faux.fauxText("done")]),
    ]);
    let gateCalls = 0;
    const tool = await createSubagentTool({
      model: subCore.getModel(),
      stream: fauxStream(subCore),
      api: "faux",
      label: "faux",
      getApiKey: () => undefined,
      registryTools: registry,
      catalog: testCatalog(),
      beforeToolCall: async () => {
        gateCalls += 1;
        return undefined;
      },
    });
    await tool.execute("call-1", { description: "d", prompt: "p", subagent_type: type });
    return gateCalls;
  }
  // PI 语义：Bash/Edit/Write 都算可改动——explorer 带 exec_command 同样挂父审批门
  assert.equal(subagentCanMutate(builtinSubagentDefinitions().definitions.find((d) => d.name === "fixer")), true);
  assert.equal(subagentCanMutate(builtinSubagentDefinitions().definitions.find((d) => d.name === "explorer")), true);
  assert.equal(subagentCanMutate(builtinSubagentDefinitions().definitions.find((d) => d.name === "code-reviewer")), false);
  assert.equal(await runWithType("fixer", "glob"), 1, "fixer：子代理工具调用经过父审批门");
  assert.equal(await runWithType("explorer", "glob"), 1, "explorer（含 exec）：同样挂门");
  assert.equal(await runWithType("code-reviewer", "glob"), 0, "code-reviewer：纯只读不挂门");
});

// ---------------------------------------------------------------------------
// 6 · 目录渲染 + 系统提示词
// ---------------------------------------------------------------------------
test("6 · 工具描述渲染目录；系统提示词含定义正文与工作区根", async () => {
  const tool = await createSubagentTool({
    model: makeFaux().getModel(),
    stream: fauxStream(makeFaux()),
    api: "faux",
    label: "faux",
    getApiKey: () => undefined,
    registryTools: getTools(),
    catalog: testCatalog(),
  });
  assert.ok(tool.description.includes("- explorer (tools:"), "目录行：explorer");
  assert.ok(tool.description.includes("- fixer (tools:"), "目录行：fixer");
  assert.ok(tool.description.includes("run_in_background"), "保留后台用法说明");

  const fixer = builtinSubagentDefinitions().definitions.find((d) => d.name === "fixer");
  const prompt = composeSubagentSystemPrompt(fixer, "C:/ws");
  assert.ok(prompt.includes('"fixer"'), "框架行含句柄");
  assert.ok(prompt.includes(fixer.description), "框架行含定义描述");
  assert.ok(prompt.includes(fixer.prompt), "正文完整拼入");
  assert.ok(prompt.includes("Current workspace root: C:/ws"), "含工作区根");
  const explorer = builtinSubagentDefinitions().definitions.find((d) => d.name === "explorer");
  assert.ok(
    composeSubagentSystemPrompt(explorer).includes("You may modify files inside the workspace"),
    "含 exec 的定义走可改动框架行（PI 语义）",
  );
  const reviewer = builtinSubagentDefinitions().definitions.find((d) => d.name === "code-reviewer");
  assert.ok(
    composeSubagentSystemPrompt(reviewer).includes("no file-modification tools"),
    "纯只读定义声明不可改动",
  );
  assert.equal(SUBAGENT_MAX_STEPS, 6);
  assert.equal(normalizeSubagentHandle("Explore"), "explorer");
  assert.equal(normalizeSubagentHandle("general-purpose"), "fixer");
});

// ---------------------------------------------------------------------------
// 7 · 后台运行 + subagent_output + 通知
// ---------------------------------------------------------------------------
test("7 · 后台子代理立即返回；subagent_output 查询状态与报告；完成触发通知", async () => {
  const { __resetForTests, getSubagentRunSnapshot } = await import("../subagents/subagentRegistry.ts");
  __resetForTests();
  const registry = getTools();

  const subCore = makeFaux();
  subCore.setResponses([
    faux.fauxAssistantMessage([faux.fauxToolCall("glob", { pattern: "**/*" })]),
    faux.fauxAssistantMessage([faux.fauxText("后台调研报告正文")]),
  ]);
  const notifications = [];
  const agentTool = await createSubagentTool({
    model: subCore.getModel(),
    stream: fauxStream(subCore),
    api: "faux",
    label: "faux",
    getApiKey: () => undefined,
    registryTools: registry,
    catalog: testCatalog(),
    notify: async (info) => {
      notifications.push(info);
    },
  });
  const outputTool = createSubagentOutputTool();

  const launched = await agentTool.execute("call-bg", {
    description: "后台调研",
    prompt: "p",
    subagent_type: "explorer",
    run_in_background: true,
  });
  assert.notEqual(launched.isError, true);
  const launchText = launched.content[0].text;
  assert.ok(launchText.includes("Background subagent started: sub-"), "返回启动事实");
  assert.ok(launchText.includes("subagent_output"), "提示查询方式");
  const runId = launched.details.subagentId;
  assert.ok(runId, "details 带 subagentId");

  const early = await outputTool.execute("call-out", { id: runId });
  assert.notEqual(early.isError, true);
  assert.ok(early.details.status === "running" || early.details.status === "completed");

  for (let i = 0; i < 50 && getSubagentRunSnapshot()[0]?.status === "running"; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const record = getSubagentRunSnapshot().find((r) => r.id === runId);
  assert.equal(record?.status, "completed", "后台收束为 completed");
  assert.equal(record?.summary, "后台调研报告正文");
  assert.equal(notifications.length, 1, "完成通知恰一次");
  assert.equal(notifications[0].status, "completed");

  const report = await outputTool.execute("call-out2", { id: runId });
  assert.ok(report.content[0].text.includes("status: completed"));
  assert.ok(report.content[0].text.includes("后台调研报告正文"));

  const missing = await outputTool.execute("call-out3", { id: "sub-404" });
  assert.equal(missing.isError, true);
  assert.ok(missing.content[0].text.includes("sub-404"));
});
