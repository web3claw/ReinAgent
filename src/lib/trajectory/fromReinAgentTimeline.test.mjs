/**
 * 轨迹适配器测试（fromReinAgentTimeline.ts）+ 账本→布局→时间轴投影抽检。
 * 运行：node --test src/lib/trajectory/fromReinAgentTimeline.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Node 直跑需 resolve 钩子补扩展名；bun 原生支持 .ts。
const { registerHooks } = await import("node:module");
if (typeof registerHooks === "function") registerHooks({
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

const { buildTrajectoryFromTimeline } = await import("./fromReinAgentTimeline.ts");
const { deriveTrajectoryLayout, flattenTrajectoryRecords } = await import("./layout.ts");
const { deriveTrajectoryTimeline } = await import("./timeline.ts");

const userEntry = (id, text, startedAt) => ({
  id,
  role: "user",
  text,
  thinking: "",
  status: "done",
  startedAt,
});

const assistantEntry = (id, text, opts = {}) => ({
  id,
  role: "assistant",
  text,
  thinking: opts.thinking ?? "",
  status: opts.status ?? "done",
  startedAt: opts.startedAt ?? 1000,
  endedAt: opts.endedAt ?? 4000,
  ...(opts.thinkingStartedAt === undefined ? {} : { thinkingStartedAt: opts.thinkingStartedAt }),
  ...(opts.usage === undefined ? {} : { apiMessage: { role: "assistant", usage: opts.usage, provider: "deepseek", model: "deepseek-v4", api: "openai-completions", stopReason: "stop" } }),
  ...(opts.retryAttempts === undefined ? {} : { retryAttempts: opts.retryAttempts }),
});

const toolEntry = (id, name, callId, opts = {}) => ({
  id,
  role: "tool",
  toolName: name,
  toolCallId: callId,
  args: opts.args ?? { path: "src/a.ts" },
  resultText: opts.resultText ?? "Successfully written",
  isError: opts.isError ?? false,
  status: opts.status ?? "done",
  text: "",
  thinking: "",
  startedAt: opts.startedAt ?? 4100,
  endedAt: opts.endedAt ?? 4300,
});

const compactEntry = (id, summary, startedAt) => ({
  id,
  role: "assistant",
  kind: "compact",
  coveredCount: 3,
  text: summary,
  thinking: "",
  status: "done",
  startedAt,
  endedAt: startedAt,
});

test("适配：两轮 + 工具 + 用量 + 思考打点 → 账本结构完整", () => {
  const { ledger, content } = buildTrajectoryFromTimeline([
    userEntry("m0", "帮我改代码", 100),
    assistantEntry("m1", "先看一下文件", {
      thinking: "用户要改代码",
      thinkingStartedAt: 1500,
      usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 5 },
    }),
    toolEntry("m2", "read_file", "call-1"),
    assistantEntry("m3", "改完了", { startedAt: 5000, endedAt: 8000 }),
    userEntry("m4", "再改一处", 9000),
    assistantEntry("m5", "好的", { startedAt: 9100, endedAt: 9300 }),
  ]);
  assert.equal(ledger.turns.length, 2);
  assert.equal(ledger.hasTiming, true);
  const t1 = ledger.turns[0];
  assert.equal(t1.turn, 1);
  assert.equal(t1.inputs[0].messageId, "m0");
  assert.equal(t1.steps.length, 2, "两条 assistant = 两步");
  assert.equal(t1.steps[0].step, 1);
  assert.equal(t1.steps[0].tools.length, 1, "工具归属第一步");
  assert.equal(t1.steps[0].tools[0].callId, "call-1");
  assert.equal(t1.steps[0].tools[0].startedAt, 4100);
  assert.equal(t1.steps[0].firstTokenAt, 1500, "thinkingStartedAt 映射为首 token 时刻");
  const usage = t1.steps[0].usage;
  assert.equal(usage.input, 100);
  assert.equal(usage.output, 50);
  assert.equal(usage.totalTokens, 150, "totalTokens = input + output（cache 不叠加）");
  assert.equal(t1.status, "complete");
  assert.equal(t1.startedAt, 100);
  assert.equal(t1.endedAt, 8000);
  assert.equal(content.assistantByStep.get("1\u00001").text, "先看一下文件");
  assert.equal(content.assistantByStep.get("1\u00001").thinking, "用户要改代码");
  assert.equal(content.toolByCallId.get("call-1").result, "Successfully written");
  assert.equal(ledger.turns[1].turn, 2);
});

test("适配：压缩条目 → standaloneCompactions，不进轮", () => {
  const { ledger } = buildTrajectoryFromTimeline([
    compactEntry("compact-0", "早前摘要", 50),
    userEntry("m0", "继续", 100),
    assistantEntry("m1", "好", { startedAt: 200, endedAt: 300 }),
  ]);
  assert.equal(ledger.turns.length, 1, "压缩不产生轮");
  assert.equal(ledger.turns[0].turn, 1);
  assert.equal(ledger.standaloneCompactions.length, 1);
  assert.equal(ledger.standaloneCompactions[0].status, "complete");
  assert.equal(ledger.standaloneCompactions[0].startedAt, 50);
});

test("适配：重试记录与错误轮状态", () => {
  const { ledger } = buildTrajectoryFromTimeline([
    userEntry("m0", "hi", 100),
    assistantEntry("m1", "", {
      status: "error",
      retryAttempts: [
        { attempt: 1, maxAttempts: 10, errorMessage: "Connection error.", plannedDelayMs: 200 },
      ],
    }),
  ]);
  const step = ledger.turns[0].steps[0];
  assert.equal(step.status, "error");
  assert.equal(step.retries.length, 1);
  assert.equal(step.retries[0].attempt, 1);
  assert.equal(step.retries[0].maxRetries, 10);
  assert.equal(ledger.turns[0].status, "error");
});

test("适配：无打点历史 → hasTiming=false（不伪造时间）", () => {
  const { ledger } = buildTrajectoryFromTimeline([
    { id: "m0", role: "user", text: "旧消息", thinking: "", status: "done" },
    { id: "m1", role: "assistant", text: "旧回复", thinking: "", status: "done" },
  ]);
  assert.equal(ledger.hasTiming, false);
  assert.equal(ledger.turns[0].steps[0].startedAt, null);
});

test("端到端：适配 → layout → 记录字段（正文/思考/用量/工具结果）", () => {
  const { ledger, content } = buildTrajectoryFromTimeline([
    userEntry("m0", "帮我改代码", 100),
    assistantEntry("m1", "先看一下文件", {
      thinking: "分析中",
      thinkingStartedAt: 1500,
      usage: { input: 100, output: 50 },
    }),
    toolEntry("m2", "read_file", "call-1"),
  ]);
  const turns = deriveTrajectoryLayout({ ledger, content });
  const records = flattenTrajectoryRecords(turns);
  const kinds = records.map((record) => record.kind);
  assert.deepEqual(kinds, ["user", "message", "tool"]);
  const assistant = records.find((record) => record.kind === "message");
  assert.equal(assistant.outputDetail, "先看一下文件");
  assert.equal(assistant.thinkingDetail, "分析中");
  assert.equal(assistant.usage.input, 100);
  assert.equal(assistant.cumulativeUsage.totalTokens, 150);
  assert.equal(assistant.assistantMetrics.firstTokenAt, 1500);
  assert.equal(assistant.timeSeconds, 3, "1000→4000 = 3s");
  const tool = records.find((record) => record.kind === "tool");
  assert.equal(tool.toolName, "read_file");
  assert.equal(tool.result, "Successfully written");
  assert.equal(tool.outputDetail, "Successfully written");
  assert.ok(tool.inputDetail.includes("src/a.ts"), "参数 JSON 进 inputDetail");
  assert.equal(records[0].index, 1, "全局 index 从 1 起");
});

test("原始块：user/assistant/tool 三类块映射（对齐 LA contentIndex）", () => {
  const messages = [
    { ...userEntry("m0", "你好", 100), attachments: [{ path: "C:/tmp/a.png", name: "a.png", kind: "image" }] },
    assistantEntry("m1", "看到了", { thinking: "分析中", thinkingStartedAt: 1500 }),
    toolEntry("m2", "read_file", "call-1", { resultText: "file body" }),
  ];
  const { ledger, content } = buildTrajectoryFromTimeline(messages);
  const turns = deriveTrajectoryLayout({ ledger, content });
  const records = flattenTrajectoryRecords(turns);
  const user = records.find((r) => r.kind === "user");
  assert.deepEqual(
    user.sourceBlocks.map((b) => b.type),
    ["text", "attachment:image"],
    "user = text 块 + 附件块",
  );
  assert.equal(user.sourceBlocks[0].content, "你好");
  assert.equal(user.sourceBlocks[1].imageAlt, "a.png");
  const assistant = records.find((r) => r.kind === "message");
  assert.deepEqual(
    assistant.sourceBlocks.map((b) => b.type),
    ["thinking", "text", "tool-call"],
    "assistant = thinking/text 块 + 其后工具的 tool-call 块",
  );
  assert.equal(assistant.sourceBlocks[2].toolName, "read_file");
  const tool = records.find((r) => r.kind === "tool");
  assert.deepEqual(tool.sourceBlocks.map((b) => b.type), ["tool-call"]);
  assert.deepEqual(tool.outputBlocks.map((b) => b.type), ["text"], "无 apiMessage 原件 → resultText 文本块兜底");
  assert.equal(tool.outputBlocks[0].content, "file body");
});

test("端到端：duration 投影产生 spans 与泳道", () => {
  const { ledger, content } = buildTrajectoryFromTimeline([
    userEntry("m0", "问题", 100),
    assistantEntry("m1", "回答", { startedAt: 1000, endedAt: 4000 }),
    toolEntry("m2", "exec_command", "c1", { startedAt: 4100, endedAt: 4500 }),
  ]);
  const turns = deriveTrajectoryLayout({ ledger, content });
  const model = deriveTrajectoryTimeline(turns, "duration");
  assert.ok(model);
  assert.equal(model.spans.length, 3);
  const lanes = model.spans.map((span) => span.lane).sort();
  assert.deepEqual(lanes, [0, 1, 2], "输入/模型/工具三泳道各一");
  assert.ok(model.turnBoundaries.length === 1);
  assert.ok(model.turnBoundaries[0].activeMs !== null, "回合净活跃由区间并集计算");
});
