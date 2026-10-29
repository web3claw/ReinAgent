import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveAssistantMcpServers,
  resolveAssistantSkills,
  getAssistantMcpOptions,
  getAssistantSkillOptions,
} from "./assistantToolFilter.ts";

test("Red Check & 隔离规则 1: 助手未勾选任何 MCP 时，绝对不带任何 MCP 工具 (0 个工具)", () => {
  const allServers = [
    { id: "jadx", enabled: true, command: "jadx-mcp", args: [], env: {} },
    { id: "chrome", enabled: true, command: "chrome-mcp", args: [], env: {} },
  ];

  // 通用助手或未勾选助手: allowedIds 为 undefined 或 []
  assert.deepEqual(resolveAssistantMcpServers(allServers, undefined), []);
  assert.deepEqual(resolveAssistantMcpServers(allServers, []), []);
});

test("规则 2: 助手勾选了特定 MCP，仅带该助手勾选且全局启用的 MCP", () => {
  const allServers = [
    { id: "jadx", enabled: true, command: "jadx-mcp", args: [], env: {} },
    { id: "chrome", enabled: false, command: "chrome-mcp", args: [], env: {} },
    { id: "git", enabled: true, command: "git-mcp", args: [], env: {} },
  ];

  // 助手勾选了 jadx 和 git，但没勾选 chrome
  const resolved = resolveAssistantMcpServers(allServers, ["jadx", "git"]);
  assert.deepEqual(resolved.map((s) => s.id), ["jadx", "git"]);

  // 助手勾选了 chrome，但 chrome 全局 enabled: false，必须剔除
  const resolvedChrome = resolveAssistantMcpServers(allServers, ["chrome", "git"]);
  assert.deepEqual(resolvedChrome.map((s) => s.id), ["git"]);
});

test("Red Check & 隔离规则 3: 助手未勾选任何 Skill 时，绝对不注入任何技能 (0 个技能)", () => {
  const discovered = [
    { name: "code-analysis", description: "analyze code" },
    { name: "web-search", description: "search web" },
  ];
  const globalSkillsSettings = {
    enabled: true,
    selected: ["code-analysis", "web-search"],
  };

  // 助手未勾选任何技能 (undefined 或 [])
  assert.deepEqual(resolveAssistantSkills(discovered, globalSkillsSettings, undefined), []);
  assert.deepEqual(resolveAssistantSkills(discovered, globalSkillsSettings, []), []);
});

test("规则 4: 助手勾选了 Skill，仅注入助手勾选且全局开启的技能", () => {
  const discovered = [
    { name: "code-analysis", description: "analyze code" },
    { name: "web-search", description: "search web" },
    { name: "git-commit", description: "commit helper" },
  ];
  const globalSkillsSettings = {
    enabled: true,
    selected: ["code-analysis"], // 全局只启用了 code-analysis，web-search 未启用
  };

  // 助手勾选了 code-analysis 和 web-search
  const active = resolveAssistantSkills(discovered, globalSkillsSettings, ["code-analysis", "web-search"]);
  // web-search 因全局未选中而被过滤，只有 code-analysis 生效
  assert.deepEqual(active, ["code-analysis"]);

  // 若全局总开关关闭，哪怕助手勾选了也全军覆没
  const disabledGlobal = { enabled: false, selected: ["code-analysis"] };
  assert.deepEqual(resolveAssistantSkills(discovered, disabledGlobal, ["code-analysis"]), []);
});

test("规则 5: 助手配置页面的 MCP 候选列表仅展示全局已启用的 MCP 服务", () => {
  const allServers = [
    { id: "jadx", label: "JADX Decompiler", enabled: true, command: "jadx", args: [], env: {} },
    { id: "chrome", label: "Chrome DevTools", enabled: false, command: "chrome", args: [], env: {} },
    { id: "git", enabled: true, command: "git", args: [], env: {} },
  ];

  const options = getAssistantMcpOptions(allServers);
  assert.equal(options.length, 2);
  assert.deepEqual(options.map((o) => o.id), ["jadx", "git"]);
});

test("规则 6: 助手配置页面的 Skill 候选列表仅展示全局已启用的 Skill", () => {
  const discovered = [
    { name: "code-analysis", description: "analyze code" },
    { name: "web-search", description: "search web" },
    { name: "git-commit", description: "commit helper" },
  ];

  // 全局总开关开，选中了 code-analysis 和 git-commit
  const globalSkillsSettings = {
    enabled: true,
    selected: ["code-analysis", "git-commit"],
  };

  const options = getAssistantSkillOptions(discovered, globalSkillsSettings);
  assert.equal(options.length, 2);
  assert.deepEqual(options.map((o) => o.id), ["code-analysis", "git-commit"]);

  // 全局总开关关
  const disabledOptions = getAssistantSkillOptions(discovered, { enabled: false, selected: ["code-analysis"] });
  assert.equal(disabledOptions.length, 0);
});
