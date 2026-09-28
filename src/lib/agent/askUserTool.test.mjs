/**
 * AskUserQuestion 工具测试（挂起/作答/跳过/参数校验）。
 * 运行：node --test src/lib/agent/askUserTool.test.mjs
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

const { createAskUserQuestionTool, isAskUserAnswer, formatAskUserAnswer } = await import(
  "./askUserTool.ts"
);

const QUESTIONS = {
  questions: [
    {
      question: "用哪种方式实现？",
      options: [
        { label: "方案 A", description: "简单" },
        { label: "方案 B", recommended: true },
      ],
    },
  ],
};

test("ask_user：用户提交结构化回答 → 工具回显 Q/A 文本", async () => {
  const captured = {};
  const tool = createAskUserQuestionTool({
    request: async (req) => {
      captured.req = req;
      return { answers: [{ question: "用哪种方式实现？", answer: "方案 A" }] };
    },
  });
  const result = await tool.execute("call-1", QUESTIONS);
  assert.ok(result.content[0].text.includes("用户已回答"));
  assert.ok(result.content[0].text.includes("方案 A"));
  assert.equal(captured.req.args.kind, "question", "挂起负载应带 kind=question");
  assert.equal(captured.req.args.questions[0].options[1].recommended, true);
});

test("ask_user：reject → 跳过提示（模型继续而非报错）", async () => {
  const tool = createAskUserQuestionTool({ request: async () => "reject" });
  const result = await tool.execute("c", QUESTIONS);
  assert.ok(result.content[0].text.includes("跳过"));
  assert.equal(result.details.skipped, true);
});

test("ask_user：非结构化 resolve（null/undefined）→ 如实提示未回答", async () => {
  for (const value of [null, undefined]) {
    const tool = createAskUserQuestionTool({ request: async () => value });
    const result = await tool.execute("c", QUESTIONS);
    assert.ok(result.content[0].text.includes("未提供回答"));
    assert.equal(result.details.skipped, true);
  }
});

test("ask_user：空 questions 参数 → 抛明确错误（schema 兜底）", async () => {
  const tool = createAskUserQuestionTool({ request: async () => "allow" });
  await assert.rejects(() => tool.execute("c", { questions: [] }), /至少需要 1 个问题/);
});

test("isAskUserAnswer：结构化判定", () => {
  assert.equal(isAskUserAnswer({ answers: [] }), true);
  assert.equal(isAskUserAnswer("allow"), false);
  assert.equal(isAskUserAnswer(null), false);
});

test("formatAskUserAnswer：Q/A 拼接", () => {
  assert.equal(
    formatAskUserAnswer([{ question: "Q1", answer: "A1" }]),
    "Q: Q1\nA: A1",
  );
});
