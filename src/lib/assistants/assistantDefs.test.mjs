import { test } from "node:test";
import assert from "node:assert/strict";
const {
  builtinAssistantDefs,
  parseAssistantDocument,
  renderAssistantDocument,
  assistantSlug,
  getTaskAssistantId,
  setTaskAssistantId,
} = await import("./assistantDefs.ts");

test("内置助手：4 个预设、general 空人设、其余有人设", () => {
  const defs = builtinAssistantDefs();
  assert.equal(defs.length, 4);
  const general = defs.find((d) => d.id === "general");
  assert.equal(general.prompt, "");
  for (const d of defs) {
    if (d.id !== "general") assert.ok(d.prompt.length > 50, d.id + " 有人设正文");
    assert.ok(d.description.length > 0);
  }
});

test("parse/render round-trip", () => {
  const doc = renderAssistantDocument({
    id: "my-assistant",
    name: "my-assistant",
    description: "测试助手",
    model: "deepseek/deepseek-chat",
    thinkingLevel: "high",
    prompt: "You are a test assistant.",
  });
  const parsed = parseAssistantDocument(doc);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.def.id, "my-assistant");
  assert.equal(parsed.def.description, "测试助手");
  assert.equal(parsed.def.model, "deepseek/deepseek-chat");
  assert.equal(parsed.def.thinkingLevel, "high");
  assert.equal(parsed.def.prompt, "You are a test assistant.");
});

test("parse 错误：缺 name/description/空 body", () => {
  assert.equal(parseAssistantDocument("---\nname: x\n---\n\nbody").ok, false);
  assert.equal(parseAssistantDocument("---\nname: x\ndescription: d\n---\n\n  ").ok, false);
});

test("slug 与任务绑定 kv", () => {
  assert.equal(assistantSlug("Doc Writer!"), "doc-writer");
  setTaskAssistantId("t1", "coder");
  assert.equal(getTaskAssistantId("t1"), "coder");
  setTaskAssistantId("t1", "general");
  assert.equal(getTaskAssistantId("t1"), "general");
});
