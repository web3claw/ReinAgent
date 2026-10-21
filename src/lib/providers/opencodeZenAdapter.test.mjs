import test from "node:test";
import assert from "node:assert/strict";
import {
  opencodeID,
  isOpenCodeZenUrl,
  isOpenCodeZenFreeModel,
  decorateOpenCodeZenRequest,
  OPENCODE_USER_AGENT,
  OPENCODE_CORE_TOOLS,
} from "./opencodeZenAdapter.ts";

test("opencodeID: generates valid format with small inverted counter", () => {
  const sesId = opencodeID("ses", true);
  assert.match(sesId, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);

  const match = /^ses_[0-9a-f]{9}([0-9a-f]{3})[0-9A-Za-z]{14}$/.exec(sesId);
  assert.ok(match);
  // Inverted counter in low 12 bits: difference from 0xfff must be small (< 16)
  const counterVal = 0xfff - Number.parseInt(match[1], 16);
  assert.ok(counterVal >= 0 && counterVal < 16, `counterVal was ${counterVal}`);

  const msgId = opencodeID("msg", false);
  assert.match(msgId, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
});

test("isOpenCodeZenUrl: identifies opencode.ai endpoints correctly", () => {
  assert.equal(isOpenCodeZenUrl("https://opencode.ai/inference/v1"), true);
  assert.equal(isOpenCodeZenUrl("https://opencode.ai/inference/v1/chat/completions"), true);
  assert.equal(isOpenCodeZenUrl("https://api.deepseek.com"), false);
  assert.equal(isOpenCodeZenUrl("http://localhost:11434"), false);
  assert.equal(isOpenCodeZenUrl(undefined), false);
});

test("isOpenCodeZenFreeModel: filters free models and excludes paid ones", () => {
  assert.equal(isOpenCodeZenFreeModel("big-pickle"), true);
  assert.equal(isOpenCodeZenFreeModel("deepseek-v4.1-flash-free"), true);
  assert.equal(isOpenCodeZenFreeModel("glm-5.3-flash-free"), true);
  assert.equal(isOpenCodeZenFreeModel("minimax-m3.1-flash-free"), true);
  assert.equal(isOpenCodeZenFreeModel("beam-free"), true);

  assert.equal(isOpenCodeZenFreeModel("claude-sonnet-4-5"), false);
  assert.equal(isOpenCodeZenFreeModel("deepseek-v4-pro"), false);
  assert.equal(isOpenCodeZenFreeModel("gpt-5"), false);
});

test("decorateOpenCodeZenRequest: leaves non-opencode requests untouched", () => {
  const originalInit = { method: "POST", headers: { "X-Custom": "test" } };
  const { url, init } = decorateOpenCodeZenRequest("https://api.deepseek.com/chat/completions", originalInit);
  assert.equal(url, "https://api.deepseek.com/chat/completions");
  assert.equal(init.headers["X-Custom"], "test");
  assert.equal(init.headers["user-agent"], undefined);
});

test("decorateOpenCodeZenRequest: decorates opencode requests with headers, tools, and stream", () => {
  const originalInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "big-pickle",
      messages: [{ role: "user", content: "hello" }],
    }),
  };

  const { init } = decorateOpenCodeZenRequest("https://opencode.ai/inference/v1/chat/completions", originalInit);
  const headers = init.headers;
  assert.equal(headers.get("user-agent"), OPENCODE_USER_AGENT);
  assert.equal(headers.get("x-opencode-client"), "cli");
  assert.equal(headers.get("x-opencode-project"), "global");
  assert.match(headers.get("x-opencode-session"), /^ses_/);
  assert.match(headers.get("x-opencode-request"), /^msg_/);
  assert.equal(headers.get("authorization"), "Bearer public");

  const body = JSON.parse(init.body);
  assert.equal(body.stream, true);
  assert.equal(body.tools.length, OPENCODE_CORE_TOOLS.length);
  assert.equal(body.tools[0].function.name, "bash");
});

test("normalizeOpenCodeUrl: rewrites legacy /zen/v1 to /inference/v1", () => {
  const { normalizeOpenCodeUrl } = require("./opencodeZenAdapter.ts");
  assert.equal(
    normalizeOpenCodeUrl("https://opencode.ai/zen/v1/chat/completions"),
    "https://opencode.ai/inference/v1/chat/completions"
  );
  assert.equal(
    normalizeOpenCodeUrl("https://opencode.ai/v1/chat/completions"),
    "https://opencode.ai/inference/v1/chat/completions"
  );
  assert.equal(
    normalizeOpenCodeUrl("https://api.deepseek.com/v1"),
    "https://api.deepseek.com/v1"
  );
});

test("decorateOpenCodeZenRequest: supplements missing core tools into existing tools", () => {
  const customTool = {
    type: "function",
    function: { name: "my_custom_tool", description: "custom", parameters: {} }
  };
  const originalInit = {
    method: "POST",
    headers: {},
    body: JSON.stringify({
      model: "big-pickle",
      messages: [{ role: "user", content: "hi" }],
      tools: [customTool]
    })
  };

  const { init } = decorateOpenCodeZenRequest("https://opencode.ai/inference/v1/chat/completions", originalInit);
  const body = JSON.parse(init.body);
  // 1 custom tool + 5 core tools = 6 tools
  assert.equal(body.tools.length, 6);
  const names = body.tools.map((t) => t.function.name);
  assert.ok(names.includes("my_custom_tool"));
  assert.ok(names.includes("bash"));
  assert.ok(names.includes("edit"));
  assert.ok(names.includes("glob"));
  assert.ok(names.includes("grep"));
  assert.ok(names.includes("read"));
});

