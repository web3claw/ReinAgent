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

// ---------------------------------------------------------------------------
// F2 · 标题请求 No-Fallback + apiFormat 驱动协议（2026-10-05）。
// 用 mock 全局 fetch 捕获请求（无 Tauri 时 proxiedFetch 回退原生 fetch）。
// ---------------------------------------------------------------------------

const { generateSessionTitle } = await import("./titleGenerator.ts");

async function captureTitleRequest(config) {
  const captured = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    let body = undefined;
    try {
      body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    } catch {
      body = {};
    }
    captured.push({ url: String(url), body });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "捕获到标题" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const title = await generateSessionTitle("帮我写一个快排", config);
    return { captured, title };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("F2-T1 · custom 服务商缺 baseUrl/modelId → 本地降级，绝不发请求（旧行为会静默发 deepseek）", async () => {
  const { captured, title } = await captureTitleRequest({
    provider: "custom-123",
    apiKey: "k",
    modelId: "",
    baseUrl: "",
  });
  assert.equal(captured.length, 0, "配置不完整时一个请求都不能发");
  assert.ok(title && title.length > 0, "应有本地降级标题");
});

test("F2-T2 · anthropic-messages 格式的 custom 服务商 → 标题请求打 /v1/messages（修复前误走 chat/completions）", async () => {
  const { captured } = await captureTitleRequest({
    provider: "custom-456",
    apiKey: "k",
    modelId: "my-model",
    baseUrl: "https://gw.example.com",
    apiFormat: "anthropic-messages",
  });
  assert.equal(captured.length, 1);
  assert.ok(
    captured[0].url.includes("/v1/messages"),
    `anthropic 格式应请求 /v1/messages，实际 ${captured[0].url}`,
  );
  assert.equal(captured[0].body.model, "my-model");
  assert.equal(captured[0].body.max_tokens, 30);
});

test("F2-T3 · openai-responses 格式 → 标题请求打 /v1/responses（与对话主链路同端点）", async () => {
  const { captured } = await captureTitleRequest({
    provider: "custom-789",
    apiKey: "k",
    modelId: "my-model",
    baseUrl: "https://gw.example.com",
    apiFormat: "openai-responses",
  });
  assert.equal(captured.length, 1);
  assert.ok(
    captured[0].url.includes("/responses"),
    `responses 格式应请求 /responses，实际 ${captured[0].url}`,
  );
  assert.equal(captured[0].body.max_output_tokens, 30);
});

test("F2-T4 · chat-completions 格式 → /v1/chat/completions，baseUrl 用户值优先", async () => {
  const { captured } = await captureTitleRequest({
    provider: "custom-000",
    apiKey: "k",
    modelId: "my-model",
    baseUrl: "https://gw.example.com",
    apiFormat: "openai-chat-completions",
  });
  assert.equal(captured.length, 1);
  assert.ok(
    captured[0].url.includes("/v1/chat/completions"),
    `实际 ${captured[0].url}`,
  );
  assert.equal(captured[0].body.model, "my-model");
});

test("F2-T5 · custom 服务商未配 apiFormat → 本地降级不发请求（不猜协议）", async () => {
  const { captured } = await captureTitleRequest({
    provider: "custom-111",
    apiKey: "k",
    modelId: "my-model",
    baseUrl: "https://gw.example.com",
  });
  assert.equal(captured.length, 0, "缺 apiFormat 时不得按猜测的协议发请求");
});
