/**
 * modelFactory 真实元数据解析测试（铁律整改项 A2）。
 *
 * 覆盖：真实值透传 / 未声明走「未知」语义（contextWindow=0 不钳制、openai 不发
 * max_tokens、anthropic 用请求级常量）/ 多模态只在明确 true 时声明 / 非法值防御。
 *
 * 运行：node --test src/lib/providers/modelFactory.test.mjs
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
          if (existsSync(fileURLToPath(candidate))) {
            return { url: candidate.href, shortCircuit: true };
          }
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const { buildModel, ANTHROPIC_REQUIRED_MAX_TOKENS } = await import("./modelFactory.ts");

const baseConfig = { apiKey: "k", modelId: "test-model", provider: "deepseek" };

test("A2-1 · 全真实值：contextWindow/maxTokens/input 均按声明透传", () => {
  const model = buildModel({
    ...baseConfig,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsImage: true,
  });
  assert.equal(model.contextWindow, 200_000);
  assert.equal(model.maxTokens, 64_000);
  assert.deepEqual(model.input, ["text", "image"]);
});

test("A2-2 · 全缺失：未知语义（contextWindow=0，openai 协议 maxTokens=0 即不发送）", () => {
  const model = buildModel({ ...baseConfig });
  assert.equal(model.contextWindow, 0, "未知上下文窗口必须是 0（pi-ai 对 <=0 跳过钳制）");
  assert.equal(model.maxTokens, 0, "openai 兼容协议未知时不声明 max_tokens（0 即不发送）");
  assert.deepEqual(model.input, ["text"], "未声明多模态时不得含 image");
});

test("A2-3 · 部分缺失：只有窗口有值，输出未知", () => {
  const model = buildModel({ ...baseConfig, contextWindow: 65_536 });
  assert.equal(model.contextWindow, 65_536);
  assert.equal(model.maxTokens, 0);
  assert.deepEqual(model.input, ["text"]);
});

test("A2-4 · supportsImage=false / null / undefined 一律不含 image（不臆测多模态）", () => {
  for (const value of [false, null, undefined]) {
    const model = buildModel({ ...baseConfig, supportsImage: value });
    assert.deepEqual(model.input, ["text"], `supportsImage=${String(value)} 时不得声明 image`);
  }
});

test("A2-5 · 非法值防御：负数 / NaN / Infinity / 字符串 一律按未知处理", () => {
  const model = buildModel({
    ...baseConfig,
    contextWindow: -1,
    maxOutputTokens: Number.NaN,
  });
  assert.equal(model.contextWindow, 0);
  assert.equal(model.maxTokens, 0);

  const model2 = buildModel({
    ...baseConfig,
    // 类型系统之外的真实场景（配置损坏）：
    contextWindow: Number.POSITIVE_INFINITY,
    maxOutputTokens: "8192",
  });
  assert.equal(model2.contextWindow, 0);
  assert.equal(model2.maxTokens, 0);
});

test("A2-6 · anthropic 协议未知输出：用请求级常量而非 0（0 会被 pi-ai 兜成 1 token）", () => {
  const model = buildModel({ ...baseConfig, provider: "anthropic" });
  assert.equal(
    model.maxTokens,
    ANTHROPIC_REQUIRED_MAX_TOKENS,
    "anthropic 的 max_tokens 是必填字段：未知时用请求级上限常量",
  );
  // 有真实声明时仍以真实值为准
  const declared = buildModel({ ...baseConfig, provider: "anthropic", maxOutputTokens: 12_000 });
  assert.equal(declared.maxTokens, 12_000);
});

test("A2-7 · contextWindow 未知不得伪造（回归：历史实现曾写死 128000/8192）", () => {
  const model = buildModel({ ...baseConfig });
  assert.notEqual(model.contextWindow, 128_000, "严禁回退到写死 128000");
  assert.notEqual(model.maxTokens, 8192, "严禁回退到写死 8192");
});
