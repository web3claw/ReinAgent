/**
 * ChatMessage→pi-ai Message 适配 + 抽取链路回归（2026-10-06 修复）。
 *
 * 回归背景：引擎曾按 pi-ai Message（content 块）直读时间线 ChatMessage（.text），
 * extractLatestUserText 永远读到空串 → 每轮抽取在调模型前被
 * skipped:"empty-user-message" 静默跳过（ok:true 无日志），应用上线 8 天 0 条记忆。
 *
 * 运行：bun test src/lib/memory/extraction/chatMessageAdapter.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { toExtractionMessages } from "./chatMessageAdapter.ts";

// Tauri invoke 桩：必须在引擎（→ api.ts）任何调用发生前就位。
const tauriCalls = [];
globalThis.window = globalThis;
globalThis.__TAURI_INTERNALS__ = {
  invoke: (cmd, args = {}) => {
    tauriCalls.push({ cmd, args });
    if (cmd === "memory_list") return Promise.resolve({ entries: [] });
    if (cmd === "memory_recent_rejections") return Promise.resolve({ entries: [] });
    if (cmd === "memory_apply_batch") return Promise.resolve({ results: [] });
    return Promise.reject(new Error(`unexpected cmd: ${cmd}`));
  },
  transformCallback: (cb) => cb,
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  plugins: {},
};

const faux = await import("@earendil-works/pi-ai/providers/faux");
const { runMemoryExtraction } = await import("./extractionEngine.ts");

const fauxStream = (core) => (model, context, options) => core.stream(model, context, options);

function chatMessage(overrides) {
  return { id: "m", role: "user", text: "", thinking: "", status: "done", ...overrides };
}

test("适配器：user/assistant 文本归一为 content 块", () => {
  const out = toExtractionMessages([
    chatMessage({ id: "u1", role: "user", text: "请记住我喜欢 Rust。" }),
    chatMessage({ id: "a1", role: "assistant", text: "已记住。" }),
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(
    { role: out[0].role, content: out[0].content },
    { role: "user", content: "请记住我喜欢 Rust。" },
  );
  assert.equal(out[1].role, "assistant");
  assert.deepEqual(out[1].content, [{ type: "text", text: "已记住。" }]);
});

test("适配器：tool 条目挂载为前置 assistant 的 toolCall，并产出 toolResult", () => {
  const out = toExtractionMessages([
    chatMessage({ id: "u1", role: "user", text: "建一个 README。" }),
    chatMessage({ id: "a1", role: "assistant", text: "" }),
    chatMessage({
      id: "t1",
      role: "tool",
      toolCallId: "call-1",
      toolName: "Write",
      args: { file_path: "/tmp/w/README.md" },
      isError: false,
    }),
  ]);
  // user → assistant（toolCall 挂载）→ toolResult
  assert.equal(out.length, 3);
  const assistant = out[1];
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.content.length, 1);
  assert.equal(assistant.content[0].type, "toolCall");
  assert.equal(assistant.content[0].name, "Write");
  assert.equal(assistant.content[0].arguments.file_path, "/tmp/w/README.md");
  const toolResult = out[2];
  assert.equal(toolResult.role, "toolResult");
  assert.equal(toolResult.toolCallId, "call-1");
  assert.equal(toolResult.isError, false);
});

test("适配器：孤儿 tool 补合成 assistant；空 assistant 被过滤；空 user 跳过", () => {
  const out = toExtractionMessages([
    chatMessage({ id: "a0", role: "assistant", text: "   " }),
    chatMessage({ id: "u0", role: "user", text: "" }),
    chatMessage({ id: "t1", role: "tool", toolCallId: "c9", toolName: "Bash", args: {}, isError: true }),
  ]);
  // a0（空文本、无工具）被滤掉；u0 空文本跳过；t1 无锚点 → 合成 assistant
  assert.equal(out.length, 2);
  assert.equal(out[0].role, "assistant");
  assert.equal(out[0].content[0].name, "Bash");
  assert.equal(out[1].role, "toolResult");
  assert.equal(out[1].isError, true);
});

test("回归：纯 append_daily 日志计划也落库（decisions 空、dailyAppend 通道）", async () => {
  tauriCalls.length = 0;
  const core = faux.createFauxCore({ api: "faux", tokenSize: { min: 1, max: 3 } });
  core.setResponses([
    faux.fauxAssistantMessage([
      faux.fauxToolCall("SubmitMemoryPlan", {
        status: "updated",
        items: [{ action: "append_daily", body: "修复记忆抽取静默失效 bug。" }],
      }),
    ]),
    faux.fauxAssistantMessage([faux.fauxText("已提交")]),
  ]);
  const result = await runMemoryExtraction({
    taskId: "daily-regression-task",
    workspaceRoot: undefined,
    messages: [
      chatMessage({ id: "u1", role: "user", text: "帮我跑一下测试并修复失败的用例。" }),
      chatMessage({ id: "a1", role: "assistant", text: "已修复并全绿。" }),
    ],
    model: {
      model: core.getModel(),
      stream: fauxStream(core),
      api: "faux",
      label: "faux",
      getApiKey: () => "sk-test",
      thinkingLevel: undefined,
    },
  });
  assert.equal(result.ok, true, `引擎应成功：${JSON.stringify(result)}`);
  assert.equal(result.acceptedCount, 1);
  const apply = tauriCalls.find((c) => c.cmd === "memory_apply_batch");
  assert.ok(apply, "纯 daily 计划也应调用 memory_apply_batch（不能被 decisions 空守卫丢弃）");
  assert.equal(apply.args.args.dailyAppend.bullet, "修复记忆抽取静默失效 bug。");
});

test("回归：ChatMessage 形状输入直达 memory_apply_batch（不再静默 empty-user-message）", async () => {
  tauriCalls.length = 0;
  const core = faux.createFauxCore({ api: "faux", tokenSize: { min: 1, max: 3 } });
  core.setResponses([
    faux.fauxAssistantMessage([
      faux.fauxToolCall("SubmitMemoryPlan", {
        status: "updated",
        items: [
          {
            action: "write",
            slug: "user-prefers-chinese",
            scope: "global",
            type: "user",
            description: "用户偏好中文回复",
            body: "用户要求所有回复默认使用中文。",
            confidence: "medium",
            source_quote: "以后所有回复请默认用中文",
          },
        ],
      }),
    ]),
    faux.fauxAssistantMessage([faux.fauxText("已提交")]),
  ]);
  const result = await runMemoryExtraction({
    taskId: "regression-task",
    workspaceRoot: undefined,
    messages: [
      chatMessage({ id: "u1", role: "user", text: "以后所有回复请默认用中文。" }),
      chatMessage({ id: "a1", role: "assistant", text: "好的。" }),
    ],
    model: {
      model: core.getModel(),
      stream: fauxStream(core),
      api: "faux",
      label: "faux",
      getApiKey: () => "sk-test",
      thinkingLevel: undefined,
    },
  });
  assert.equal(result.ok, true, `引擎应成功而非跳过/失败：${JSON.stringify(result)}`);
  assert.equal(result.acceptedCount, 1);
  assert.match(result.receipt, /1 accepted/);
  const apply = tauriCalls.find((c) => c.cmd === "memory_apply_batch");
  assert.ok(apply, "memory_apply_batch 应被调用");
  assert.equal(apply.args.args.decisions.length, 1);
  assert.equal(apply.args.args.decisions[0].op, "upsert");
});
