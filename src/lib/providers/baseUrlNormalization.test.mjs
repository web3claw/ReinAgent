import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cleanBaseUrl,
  ensureV1BaseUrl,
  normalizeBaseUrl,
  buildModel,
} from "./modelFactory.ts";

test("cleanBaseUrl: 无论是否带斜杠或 /v1，保存时统一剥离为干净的根地址", () => {
  const cases = [
    ["http://192.168.3.27:8787", "http://192.168.3.27:8787"],
    ["http://192.168.3.27:8787/", "http://192.168.3.27:8787"],
    ["http://192.168.3.27:8787///", "http://192.168.3.27:8787"],
    ["http://192.168.3.27:8787/v1", "http://192.168.3.27:8787"],
    ["http://192.168.3.27:8787/v1/", "http://192.168.3.27:8787"],
    ["http://192.168.3.27:8787/V1///", "http://192.168.3.27:8787"],
    ["  http://192.168.3.27:8787/v1/  ", "http://192.168.3.27:8787"],
    ["https://api.openai.com/v1", "https://api.openai.com"],
    ["https://api.openai.com/v1/", "https://api.openai.com"],
    ["", ""],
    [null, ""],
    [undefined, ""],
  ];

  for (const [input, expected] of cases) {
    assert.equal(cleanBaseUrl(input), expected, `cleanBaseUrl(${input}) failed`);
  }
});

test("ensureV1BaseUrl: 发起请求时自动追加 /v1，不重复拼接", () => {
  const cases = [
    ["http://192.168.3.27:8787", "http://192.168.3.27:8787/v1"],
    ["http://192.168.3.27:8787/", "http://192.168.3.27:8787/v1"],
    ["http://192.168.3.27:8787///", "http://192.168.3.27:8787/v1"],
    ["http://192.168.3.27:8787/v1", "http://192.168.3.27:8787/v1"],
    ["http://192.168.3.27:8787/v1/", "http://192.168.3.27:8787/v1"],
    ["https://api.openai.com", "https://api.openai.com/v1"],
    ["https://api.openai.com/v1", "https://api.openai.com/v1"],
    ["", ""],
  ];

  for (const [input, expected] of cases) {
    assert.equal(ensureV1BaseUrl(input), expected, `ensureV1BaseUrl(${input}) failed`);
  }
});

test("buildModel: 针对 OpenAI 兼容模型，构造的模型 baseUrl 自动带上 /v1", () => {
  const model = buildModel({
    provider: "openai",
    apiKey: "test-key",
    modelId: "gpt-4o",
    baseUrl: "http://192.168.3.27:8787",
  });

  assert.equal(model.baseUrl, "http://192.168.3.27:8787/v1");
});
