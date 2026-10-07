/**
 * `/init` 提示词模板测试（initPrompt.ts）。
 * 运行：node --test src/lib/commands/initPrompt.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Node 直跑需 resolve 钩子补扩展名；bun 原生支持 .ts 且 1.4.x 无 registerHooks —— 动态导入 + 能力检测。
const { registerHooks } = await import("node:module");
if (typeof registerHooks === "function") registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
      const url = new URL(specifier, context.parentURL);
      if (!/\.[a-z0-9]+$/i.test(url.pathname)) {
        for (const ext of [".js", ".ts", ".mjs", ".json"]) {
          const candidate = new URL(url.href + ext);
          if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const { buildInitAgentsPrompt } = await import("./initPrompt.ts");

test("buildInitAgentsPrompt：Windows 路径用反斜杠拼接目标文件", () => {
  const prompt = buildInitAgentsPrompt({ args: "", workingDirectory: "E:\\Dev\\proj" });
  assert.ok(prompt.includes("- Instruction file: E:\\Dev\\proj\\AGENTS.md"), "目标路径");
  assert.ok(prompt.includes("- Workspace directory: E:\\Dev\\proj"), "工作区路径");
  assert.ok(
    prompt.includes("E:\\Dev\\proj\\.agents/AGENTS.md") &&
      prompt.includes("E:\\Dev\\proj\\CLAUDE.md") &&
      prompt.includes("E:\\Dev\\proj\\.claude/CLAUDE.md"),
    "三个候选指令文件路径",
  );
});

test("buildInitAgentsPrompt：POSIX 路径用斜杠，尾部斜杠归一", () => {
  const prompt = buildInitAgentsPrompt({ args: "", workingDirectory: "/home/u/proj/" });
  assert.ok(prompt.includes("- Instruction file: /home/u/proj/AGENTS.md"), "去尾斜杠后拼接");
});

test("buildInitAgentsPrompt：无参数时不追加 Additional user instructions 段", () => {
  const prompt = buildInitAgentsPrompt({ args: "", workingDirectory: "/w" });
  assert.ok(!prompt.includes("Additional user instructions supplied with /init:"), "无参无附加段");
});

test("buildInitAgentsPrompt：带参数按 ZCode 原文格式追加 text 代码块", () => {
  const prompt = buildInitAgentsPrompt({ args: "重点写构建命令", workingDirectory: "/w" });
  assert.ok(prompt.includes("Additional user instructions supplied with /init:"), "附加段标题");
  assert.ok(
    prompt.includes("```text\n重点写构建命令\n```"),
    "参数包进 text 代码块（ZCode 同款格式）",
  );
});

test("buildInitAgentsPrompt：语义约束齐备（只动工作区/编辑不覆盖/工具名适配/候选检查后停）", () => {
  const prompt = buildInitAgentsPrompt({ args: "", workingDirectory: "/w" });
  assert.ok(prompt.includes("Do not write files outside the workspace"), "只动工作区");
  assert.ok(prompt.includes("update it with edit_file instead of replacing it wholesale"), "编辑不覆盖");
  assert.ok(prompt.includes("read_file, list_dir, glob, and grep"), "工具名适配 ReinAgent");
  assert.ok(prompt.includes("stop without creating a new AGENTS.md"), "候选存在则停");
  assert.ok(!prompt.includes("ZCode"), "不含 ZCode 字样（身份已改为 ReinAgent）");
});
