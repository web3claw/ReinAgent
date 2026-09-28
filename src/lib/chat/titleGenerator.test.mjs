import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 让裸 node 能解析「无扩展名的相对导入」
// Node 直跑需 resolve 钩子补扩展名；bun 原生支持 .ts 且 1.4.x 无 registerHooks —— 动态导入 + 能力检测。
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

const { cleanGeneratedTitle, generateLocalFallbackTitle } = await import("./titleGenerator.ts");

test("cleanGeneratedTitle strips thinking tags, markdown headers, and quotes", () => {
  const input = "<think>some thought</think>### \"快速排序算法实现\"。";
  const cleaned = cleanGeneratedTitle(input);
  assert.equal(cleaned, "快速排序算法实现");
});

test("cleanGeneratedTitle handles English concise titles", () => {
  const input = "'Quick Sort Algorithm Implementation.'";
  const cleaned = cleanGeneratedTitle(input);
  assert.equal(cleaned, "Quick Sort Algorithm Implementation");
});

test("generateLocalFallbackTitle removes conversational prefixes", () => {
  assert.equal(generateLocalFallbackTitle("你好，请帮我写一个二叉树遍历"), "写一个二叉树遍历");
  assert.equal(generateLocalFallbackTitle("请问如何配置 Tailwind CSS？"), "如何配置 Tailwind CSS");
  assert.equal(generateLocalFallbackTitle("帮我优化这段 React 代码"), "优化这段 React 代码");
  assert.equal(generateLocalFallbackTitle("你好"), "你好");
});
