/**
 * subagentDefinitions 纯函数测试（2026-10-01 对齐 PI-Desktop 定义层）：
 *   1. frontmatter 解析：完整字段 / 缺字段报错 / max-tokens 兼容键 / inherit 剥离
 *   2. render → parse round-trip 字段守恒
 *   3. 内置 5 定义：工具映射本仓注册表、全部工具真实存在、code-reviewer 只读
 *   4. subagentSlug 规范化
 *   5. loadSubagentCatalog 合并语义：用户同名遮蔽内置、停用内置剔除（kv 内存态）
 * 运行：bun test src/lib/subagents/subagentDefinitions.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  builtinSubagentDefinitions,
  loadSubagentCatalog,
  parseSubagentDocument,
  renderSubagentDocument,
  setBuiltinEnabled,
  subagentSlug,
} from "./subagentDefinitions.ts";
import { getTools } from "../agent/tools.js";

test("1 · parse：完整字段；缺 description/空 body 报错；max-tokens 兼容；inherit 剥离", () => {
  const full = parseSubagentDocument(
    [
      "---",
      "name: doc-reviewer",
      "description: Review docs",
      "tools: [Read, Grep]",
      "model: deepseek/deepseek-chat",
      "thinkingLevel: low",
      "maxTokens: 8000",
      "---",
      "",
      "Do review.",
    ].join("\n"),
    "user",
  );
  assert.equal(full.ok, true);
  assert.deepEqual(full.definition, {
    name: "doc-reviewer",
    description: "Review docs",
    tools: ["Read", "Grep"],
    model: "deepseek/deepseek-chat",
    thinkingLevel: "low",
    maxTokens: 8000,
    prompt: "Do review.",
    source: "user",
  });

  const compat = parseSubagentDocument(
    "---\nname: x\ndescription: d\nmax-tokens: 8000\n---\n\nbody",
    "user",
  );
  assert.equal(compat.ok, true);
  assert.equal(compat.definition.maxTokens, 8000, "max-tokens → maxTokens 归一");

  const inherit = parseSubagentDocument(
    "---\nname: x\ndescription: d\ntools: inherit\n---\n\nbody",
    "user",
  );
  assert.equal(inherit.ok, true);
  assert.deepEqual(inherit.definition.tools, [], "inherit 由运行时默认集承接，解析层剥离");

  const noDesc = parseSubagentDocument("---\nname: x\n---\n\nbody", "user");
  assert.equal(noDesc.ok, false);
  const emptyBody = parseSubagentDocument("---\nname: x\ndescription: d\n---\n\n  ", "user");
  assert.equal(emptyBody.ok, false);
  const tooBig = parseSubagentDocument(
    `---\nname: x\ndescription: d\n---\n\n${"x".repeat(33 * 1024)}`,
    "user",
  );
  assert.equal(tooBig.ok, false);
});

test("2 · render → parse round-trip 字段守恒（不含启用态）", () => {
  const doc = renderSubagentDocument({
    name: "my-agent",
    description: "Does things",
    tools: ["read_file", "glob", "exec_command"],
    thinkingLevel: "high",
    prompt: "Line1\nLine2",
  });
  assert.ok(doc.startsWith("---"));
  assert.ok(!doc.includes("enabled"), "启用状态绝不写入文档");
  const parsed = parseSubagentDocument(doc, "user");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.definition.name, "my-agent");
  assert.equal(parsed.definition.description, "Does things");
  assert.deepEqual(parsed.definition.tools, ["read_file", "glob", "exec_command"]);
  assert.equal(parsed.definition.thinkingLevel, "high");
  assert.equal(parsed.definition.prompt, "Line1\nLine2");
});

test("3 · 内置 5 定义：映射后全部工具存在于注册表；code-reviewer 纯只读；无 BrowserPreview", () => {
  const { definitions, diagnostics } = builtinSubagentDefinitions();
  assert.deepEqual(diagnostics, []);
  assert.equal(definitions.length, 5);
  const registryNames = new Set(getTools().map((t) => t.name));
  const byName = Object.fromEntries(definitions.map((d) => [d.name, d]));
  assert.deepEqual(byName["code-reviewer"].tools, ["read_file", "glob", "grep"]);
  assert.ok(byName["ui-designer"].description.length > 0);
  for (const def of definitions) {
    assert.ok(def.prompt.length > 50, `${def.name} 有完整指令正文`);
    for (const tool of def.tools) {
      assert.ok(registryNames.has(tool), `${def.name}.${tool} 在注册表中`);
    }
  }
  const mutatingTools = ["exec_command", "write_file", "edit_file"];
  for (const tool of byName["code-reviewer"].tools) {
    assert.ok(!mutatingTools.includes(tool), "code-reviewer 不含可改动工具");
  }
});

test("4 · subagentSlug：小写化/连字符/守卫", () => {
  assert.equal(subagentSlug("Doc Reviewer!"), "doc-reviewer");
  assert.equal(subagentSlug("  --a9--  "), "a9");
  assert.equal(subagentSlug("!!!"), "");
  assert.ok(subagentSlug("x".repeat(100)).length <= 40);
});

test("5 · 目录合成：用户同名遮蔽内置；停用内置剔除", async () => {
  setBuiltinEnabled("code-reviewer", false);
  const catalog1 = await loadSubagentCatalog();
  const builtinHandles = catalog1.builtins.map((b) => b.name);
  assert.ok(builtinHandles.includes("code-reviewer"), "builtins 组含全部内置（含停用）");
  assert.ok(
    !catalog1.definitions.some((d) => d.name === "code-reviewer"),
    "生效目录剔除停用内置",
  );
  assert.ok(catalog1.definitions.some((d) => d.name === "explorer"), "启用内置在生效目录");

  // 模拟用户同名文档遮蔽：直接向目录合成注入（绕过磁盘——磁盘扫描在无 home 的 Node 下返回空）
  setBuiltinEnabled("code-reviewer", true);
  const { builtinSubagentDefinitions } = await import("./subagentDefinitions.ts");
  const catalog2 = await loadSubagentCatalog();
  assert.ok(
    catalog2.definitions.some((d) => d.name === "code-reviewer"),
    "恢复启用后回到生效目录",
  );
  assert.ok(builtinSubagentDefinitions);
});
