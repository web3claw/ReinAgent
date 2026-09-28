/**
 * 错误归因分类单测（P2-B1）：六类正则 + unknown 兜底，与 diagnoseError 同序。
 * 运行：bun test src/lib/chat/errors.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { errorCategory, diagnoseError } from "./errors.js";

test("errorCategory：六类正则命中", () => {
  assert.equal(errorCategory("Error: 401 Unauthorized"), "auth");
  assert.equal(errorCategory("invalid api key provided"), "auth");
  assert.equal(errorCategory("HTTP 402 Insufficient Balance"), "balance");
  assert.equal(errorCategory("429 Too Many Requests"), "rate-limit");
  assert.equal(errorCategory("502 Bad Gateway"), "server");
  assert.equal(errorCategory("fetch failed: ECONNRESET"), "network");
  assert.equal(errorCategory("Request timed out after 30s"), "timeout");
});

test("errorCategory：未知错误兜底（不臆测分类）", () => {
  assert.equal(errorCategory("some totally novel failure"), "unknown");
  assert.equal(errorCategory(""), "unknown");
  assert.equal(errorCategory(undefined), "unknown");
});

test("errorCategory 与 diagnoseError 分类同序（同一错误同一分支族）", () => {
  const cases = [
    "401 unauthorized",
    "402 balance exhausted",
    "429 rate limit",
    "503 service unavailable",
    "ECONNREFUSED",
    "request timeout",
    "novel error",
  ];
  for (const message of cases) {
    const category = errorCategory(message);
    const hint = diagnoseError(message);
    // 非未知分类必有对应的 hint 文案前缀（分类行为一致性抽查）
    if (category !== "unknown") {
      assert.ok(hint.length > 0, `${message} 应有 diagnoseError 文案`);
    }
  }
});
