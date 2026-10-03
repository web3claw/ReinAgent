import { test } from "node:test";
import assert from "node:assert/strict";
const {
  builtinAssistantDefs,
  parseAssistantDocument,
  renderAssistantDocument,
  assistantSlug,
  GENERAL_ASSISTANT_ID,
} = await import("./assistantDefs.ts");

test("内置助手：4 个预设、general 空人设、其余有人设、无人设外字段", () => {
  const defs = builtinAssistantDefs();
  assert.equal(defs.length, 4);
  const general = defs.find((d) => d.id === GENERAL_ASSISTANT_ID);
  // 2026-10-03：general 不再是空人设（用户定稿：通用助手带生活/工作通用提示词）
  assert.ok(general.prompt.length > 50, "general 有通用人设正文");
  for (const d of defs) {
    assert.ok(d.prompt.length > 50, d.id + " 有人设正文");
    assert.ok(d.description.length > 0);
    assert.equal(d.model, undefined, "助手是纯人设：无模型字段");
    assert.equal(d.thinkingLevel, undefined, "助手是纯人设：无思考等级字段");
  }
});

test("parse/render round-trip（纯人设）", () => {
  const doc = renderAssistantDocument({
    id: "my-assistant",
    name: "my-assistant",
    description: "测试助手",
    prompt: "You are a test assistant.",
  });
  assert.ok(!doc.includes("model:"), "产物不写 model frontmatter");
  assert.ok(!doc.includes("thinkingLevel:"), "产物不写 thinkingLevel frontmatter");
  const parsed = parseAssistantDocument(doc);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.def.id, "my-assistant");
  assert.equal(parsed.def.description, "测试助手");
  assert.equal(parsed.def.prompt, "You are a test assistant.");
});

test("parse 容错：旧文件的 model/thinkingLevel frontmatter 被忽略", () => {
  const legacy = [
    "---",
    "name: legacy-assistant",
    "description: 旧格式助手",
    "model: deepseek/deepseek-chat",
    "thinkingLevel: high",
    "---",
    "",
    "You are legacy.",
  ].join("\n");
  const parsed = parseAssistantDocument(legacy);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.def.model, undefined);
  assert.equal(parsed.def.thinkingLevel, undefined);
  assert.equal(parsed.def.prompt, "You are legacy.");
});

test("parse 错误：缺 name/description/空 body", () => {
  assert.equal(parseAssistantDocument("---\nname: x\n---\n\nbody").ok, false);
  assert.equal(parseAssistantDocument("---\nname: x\ndescription: d\n---\n\n  ").ok, false);
});

test("slug", () => {
  assert.equal(assistantSlug("Doc Writer!"), "doc-writer");
});

test("中文名：name 写显示名、id 行写 ASCII 句柄（round-trip）", () => {
  const doc = renderAssistantDocument({
    id: "assistant-s6shf2",
    name: "高级安卓逆向解密专家",
    description: "安卓 APK 逆向分析专家",
    prompt: "You are an Android RE persona.",
  });
  assert.ok(doc.includes("name: 高级安卓逆向解密专家"), "frontmatter name 写中文显示名");
  assert.ok(doc.includes("id: assistant-s6shf2"), "另存 id 行 ASCII 句柄");
  const parsed = parseAssistantDocument(doc);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.def.id, "assistant-s6shf2", "id 解析为句柄");
  assert.equal(parsed.def.name, "高级安卓逆向解密专家", "name 解析为显示名");
});

test("旧文件（无 id 行）：id 回退取 name（内置预设同款形态）", () => {
  const doc = renderAssistantDocument({
    id: "coder",
    name: "coder",
    description: "内置同款",
    prompt: "p",
  });
  assert.ok(!doc.includes("id:"), "id==name 时不写冗余 id 行");
  const parsed = parseAssistantDocument(doc);
  assert.equal(parsed.def.id, "coder");
  assert.equal(parsed.def.name, "coder");
});
