/**
 * 提示词增强纯函数测试（对齐 PI-Desktop prompt-enhancement.test.ts 核心断言）。
 * 运行：node --test src/lib/promptEnhancement/promptEnhancement.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  DEFAULT_PROMPT_ENHANCEMENT_SYSTEM_PROMPT,
  DEFAULT_PROMPT_ENHANCEMENT_USER_TEMPLATE,
  renderPromptEnhancementUserTemplate,
  promptEnhancementTemplateError,
  resolvePromptEnhancementUserTemplate,
  stripEnhancementDecorations,
  PROMPT_ENHANCEMENT_DRAFT_VARIABLE,
} = await import("./templates.ts");

test("内置模板：系统提示词含关键约束；用户模板含 {{draft}} 与中英 few-shot", () => {
  assert.ok(DEFAULT_PROMPT_ENHANCEMENT_SYSTEM_PROMPT.includes("prompt-engineering expert"));
  assert.ok(DEFAULT_PROMPT_ENHANCEMENT_SYSTEM_PROMPT.includes("Only the enhanced prompt"));
  assert.ok(DEFAULT_PROMPT_ENHANCEMENT_USER_TEMPLATE.includes(PROMPT_ENHANCEMENT_DRAFT_VARIABLE));
  assert.ok(DEFAULT_PROMPT_ENHANCEMENT_USER_TEMPLATE.includes("帮我看看这段代码"));
  assert.ok(DEFAULT_PROMPT_ENHANCEMENT_USER_TEMPLATE.includes("fix the login bug"));
});

test("renderPromptEnhancementUserTemplate：{{draft}} 全量替换为草稿原文", () => {
  const rendered = renderPromptEnhancementUserTemplate("<draft>\n{{draft}}\n</draft>", "a {{draft}} b");
  assert.equal(rendered, "<draft>\na {{draft}} b\n</draft>");
  // 无占位符的模板原样返回
  assert.equal(renderPromptEnhancementUserTemplate("no placeholder", "x"), "no placeholder");
});

test("模板校验：空=合法（未覆盖）；必须含 {{draft}}；≤8000 字符", () => {
  assert.equal(promptEnhancementTemplateError(undefined), null);
  assert.equal(promptEnhancementTemplateError(""), null);
  assert.equal(promptEnhancementTemplateError("   "), null);
  assert.ok(promptEnhancementTemplateError("no placeholder").includes("{{draft}}"));
  assert.ok(promptEnhancementTemplateError("x".repeat(7991) + " {{draft}}").includes("8000"));
  assert.equal(promptEnhancementTemplateError("x".repeat(7990) + " {{draft}}"), null);
  assert.equal(promptEnhancementTemplateError("has {{draft}} ok"), null);
});

test("resolvePromptEnhancementUserTemplate：开关关闭/模板非法 → 回退内置默认", () => {
  assert.equal(resolvePromptEnhancementUserTemplate({ customTemplate: false, userTemplate: "custom {{draft}}" }),
    DEFAULT_PROMPT_ENHANCEMENT_USER_TEMPLATE);
  assert.equal(resolvePromptEnhancementUserTemplate({ customTemplate: true, userTemplate: "custom {{draft}}" }),
    "custom {{draft}}");
  // 开启但缺占位符 → 第二道防线回退默认
  assert.equal(resolvePromptEnhancementUserTemplate({ customTemplate: true, userTemplate: "broken" }),
    DEFAULT_PROMPT_ENHANCEMENT_USER_TEMPLATE);
});

test("stripEnhancementDecorations：剥一层匹配包裹引号与改写前缀标签", () => {
  assert.equal(stripEnhancementDecorations('"enhanced text"'), "enhanced text");
  assert.equal(stripEnhancementDecorations("“增强文本”"), "增强文本");
  // 不匹配的引号不剥
  assert.equal(stripEnhancementDecorations('"不匹配'), '"不匹配');
  // 前缀标签（中英）
  assert.equal(stripEnhancementDecorations("增强: 文本"), "文本");
  assert.equal(stripEnhancementDecorations("Enhanced: text"), "text");
  assert.equal(stripEnhancementDecorations("输出：内容"), "内容");
  // 引号 + 标签组合
  assert.equal(stripEnhancementDecorations('"增强：文本"'), "文本");
  // 原文含合法内部引号不受影响
  assert.equal(stripEnhancementDecorations('她说"你好"'), '她说"你好"');
});
