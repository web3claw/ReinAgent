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
    assert.equal(d.model, undefined, "内置助手无绑定字段");
    assert.equal(d.thinkingLevel, undefined, "内置助手无绑定字段");
    assert.equal(d.skills, undefined, "内置助手无绑定字段");
    assert.equal(d.mcpServers, undefined, "内置助手无绑定字段");
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

test("parse/render round-trip：绑定字段（model/thinkingLevel/skills/mcpServers）", () => {
  const doc = renderAssistantDocument({
    id: "preset-assistant",
    name: "preset-assistant",
    description: "带绑定",
    prompt: "You are preset.",
    model: "deepseek/deepseek-chat",
    thinkingLevel: "high",
    skills: ["skills-creator", "code-review"],
    mcpServers: ["node_repl"],
  });
  assert.ok(doc.includes("model: deepseek/deepseek-chat"));
  assert.ok(doc.includes("thinkingLevel: high"));
  assert.ok(doc.includes("skills: skills-creator, code-review"));
  assert.ok(doc.includes("mcpServers: node_repl"));
  const parsed = parseAssistantDocument(doc);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.def.model, "deepseek/deepseek-chat");
  assert.equal(parsed.def.thinkingLevel, "high");
  assert.deepEqual(parsed.def.skills, ["skills-creator", "code-review"]);
  assert.deepEqual(parsed.def.mcpServers, ["node_repl"]);
});

test("parse 空绑定字段：空串/空列表 = 未绑定", () => {
  const doc = [
    "---",
    "name: empty-bind",
    "description: 空绑定",
    "model:",
    "thinkingLevel:",
    "skills: , ,",
    "mcpServers:",
    "---",
    "",
    "Body here.",
  ].join("\n");
  const parsed = parseAssistantDocument(doc);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.def.model, undefined);
  assert.equal(parsed.def.thinkingLevel, undefined);
  assert.equal(parsed.def.skills, undefined);
  assert.equal(parsed.def.mcpServers, undefined);
});

test("render 省略未绑定维度（产物无空 frontmatter 行）", () => {
  const doc = renderAssistantDocument({
    id: "partial",
    name: "partial",
    description: "只绑模型",
    prompt: "Body.",
    model: "openai/gpt-5",
  });
  assert.ok(doc.includes("model: openai/gpt-5"));
  assert.ok(!doc.includes("thinkingLevel:"), "未绑定不写行");
  assert.ok(!doc.includes("skills:"), "未绑定不写行");
  assert.ok(!doc.includes("mcpServers:"), "未绑定不写行");
});

test("parse 容错：旧文件的 model/thinkingLevel 现在按绑定读取（零迁移兼容）", () => {
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
  assert.equal(parsed.def.model, "deepseek/deepseek-chat");
  assert.equal(parsed.def.thinkingLevel, "high");
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
