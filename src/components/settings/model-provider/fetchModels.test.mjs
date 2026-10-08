import test from "node:test";
import assert from "node:assert/strict";
import { mergeFetchedModels, buildModelListAuthHeaders } from "./fetchModels.ts";

test("mergeFetchedModels: retains existing models state and appends new ones", () => {
  const existing = [
    { id: "gpt-4o", name: "GPT-4o (Renamed)", enabled: false, isCustom: false },
    { id: "my-custom-model", name: "Custom Fine-tuned", enabled: true, isCustom: true },
  ];

  const fetched = ["gpt-4o", "gpt-4o-mini", "o1-preview"];

  const { merged, newCount } = mergeFetchedModels(existing, fetched);

  assert.equal(newCount, 2);
  assert.equal(merged.length, 4);

  // Existing model properties preserved
  const gpt4o = merged.find((m) => m.id === "gpt-4o");
  assert.equal(gpt4o.name, "GPT-4o (Renamed)");
  assert.equal(gpt4o.enabled, false);

  const custom = merged.find((m) => m.id === "my-custom-model");
  assert.equal(custom.isCustom, true);

  // Newly fetched models added with enabled = false by default
  const mini = merged.find((m) => m.id === "gpt-4o-mini");
  assert.ok(mini);
  assert.equal(mini.enabled, false);

  const o1 = merged.find((m) => m.id === "o1-preview");
  assert.ok(o1);
  assert.equal(o1.enabled, false);
});

test("mergeFetchedModels: deduplicates identical IDs gracefully", () => {
  const existing = [{ id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet", enabled: true }];
  const fetched = ["claude-3-5-sonnet", "claude-3-5-sonnet"];

  const { merged, newCount } = mergeFetchedModels(existing, fetched);
  assert.equal(newCount, 0);
  assert.equal(merged.length, 1);
});

test("PRESET_PROVIDERS: all 5 mainstream providers have empty models array by default", async () => {
  const { PRESET_PROVIDERS } = await import("./types.ts");
  assert.equal(PRESET_PROVIDERS.length, 5);
  for (const provider of PRESET_PROVIDERS) {
    assert.deepEqual(provider.models, [], `${provider.id} should have empty models`);
    assert.equal(provider.defaultModelId, "", `${provider.id} should have empty defaultModelId`);
  }
});

test("parseProviderRawModels: accurately extracts real API metadata without guessing", async () => {
  const { parseProviderRawModels } = await import("./fetchModels.ts");

  // Real DeepSeek API response payload
  const deepseekPayload = {
    object: "list",
    data: [
      {
        id: "deepseek-flash",
        name: "DeepSeek-V4.1-Flash",
        context_window: 1048576,
        max_output_tokens: 393216,
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
      },
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek-V4-Pro",
        context_window: 1048576,
        max_output_tokens: 393216,
        input_modalities: ["text"],
        output_modalities: ["text"],
      },
    ],
  };

  const parsed = parseProviderRawModels(deepseekPayload);
  assert.equal(parsed.length, 2);

  const flash = parsed.find((m) => m.id === "deepseek-flash");
  assert.ok(flash);
  assert.equal(flash.name, "DeepSeek-V4.1-Flash");
  assert.equal(flash.contextWindow, 1048576);
  assert.equal(flash.maxOutputTokens, 393216);
  assert.equal(flash.supportsImage, true);

  const pro = parsed.find((m) => m.id === "deepseek-v4-pro");
  assert.ok(pro);
  assert.equal(pro.contextWindow, 1048576);
  assert.equal(pro.supportsImage, false);

  // Model without context window or modalities: NO fake guessing
  const minimalPayload = {
    data: [{ id: "custom-raw-model" }],
  };
  const minimalParsed = parseProviderRawModels(minimalPayload);
  assert.equal(minimalParsed.length, 1);
  assert.equal(minimalParsed[0].id, "custom-raw-model");
  assert.equal(minimalParsed[0].contextWindow, undefined);
  assert.equal(minimalParsed[0].supportsImage, undefined);
});

test("formatModelContextWindowLabel: formats compact labels correctly", async () => {
  const { formatModelContextWindowLabel } = await import("./types.ts");
  assert.equal(formatModelContextWindowLabel(1000000), "1M");
  assert.equal(formatModelContextWindowLabel(1048576), "1M");
  assert.equal(formatModelContextWindowLabel(2000000), "2M");
  assert.equal(formatModelContextWindowLabel(200000), "200K");
  assert.equal(formatModelContextWindowLabel(128000), "128K");
  assert.equal(formatModelContextWindowLabel(64000), "64K");
  assert.equal(formatModelContextWindowLabel(32000), "32K");
  assert.equal(formatModelContextWindowLabel(0), "");
  assert.equal(formatModelContextWindowLabel(undefined), "");
});

test("parseProviderRawModels: accurately parses real effort configuration without guessing", async () => {
  const { parseProviderRawModels, mergeFetchedModels } = await import("./fetchModels.ts");

  const payloadWithEffort = {
    data: [
      {
        id: "deepseek-reasoner",
        name: "DeepSeek Reasoner",
        effort: {
          supported_levels: ["low", "high", "max"],
          default_level: "high",
        },
      },
      {
        id: "deepseek-chat",
        name: "DeepSeek Chat",
      },
    ],
  };

  const parsed = parseProviderRawModels(payloadWithEffort);
  assert.equal(parsed.length, 2);

  const reasoner = parsed.find((m) => m.id === "deepseek-reasoner");
  assert.ok(reasoner);
  assert.ok(reasoner.effort);
  assert.deepEqual(reasoner.effort.supportedLevels, ["low", "high", "max"]);
  assert.equal(reasoner.effort.defaultLevel, "high");

  // Non-effort model MUST NOT have fake effort injected
  const chat = parsed.find((m) => m.id === "deepseek-chat");
  assert.ok(chat);
  assert.equal(chat.effort, undefined);

  // mergeFetchedModels merges effort
  const existing = [{ id: "deepseek-reasoner", name: "DeepSeek Reasoner", enabled: true }];
  const { merged } = mergeFetchedModels(existing, parsed);
  const mergedReasoner = merged.find((m) => m.id === "deepseek-reasoner");
  assert.ok(mergedReasoner?.effort);
  assert.equal(mergedReasoner.effort.defaultLevel, "high");
});

test("parseProviderRawModels: supports 6 levels including default and xhigh", async () => {
  const { parseProviderRawModels } = await import("./fetchModels.ts");

  const payload = {
    data: [
      {
        id: "o3-mini",
        name: "o3-mini",
        effort: {
          supported_levels: ["default", "low", "medium", "high", "xhigh", "max"],
          default_level: "default",
        },
      },
    ],
  };

  const parsed = parseProviderRawModels(payload);
  assert.equal(parsed.length, 1);
  assert.ok(parsed[0].effort);
  assert.deepEqual(parsed[0].effort.supportedLevels, ["default", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(parsed[0].effort.defaultLevel, "default");
});

test("parseProviderRawModels: accurately parses supports_images and supports_image booleans", async () => {
  const { parseProviderRawModels } = await import("./fetchModels.ts");

  const payload = {
    data: [
      {
        id: "qwen-vl",
        name: "Qwen-VL",
        supports_images: true,
      },
      {
        id: "qwen-text",
        name: "Qwen-Text",
        supports_images: false,
      },
      {
        id: "glm-vision",
        name: "GLM-Vision",
        supports_image: true,
      },
    ],
  };

  const parsed = parseProviderRawModels(payload);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].supportsImage, true);
  assert.equal(parsed[0].enabled, false);
  assert.equal(parsed[1].supportsImage, false);
  assert.equal(parsed[2].supportsImage, true);
});

test("parseProviderRawModels: accurately parses object-shaped modalities { input: ['text', 'image'] }", async () => {
  const { parseProviderRawModels } = await import("./fetchModels.ts");

  const payload = {
    data: [
      {
        id: "workbuddy/deepseek-v4.1-flash",
        name: "DeepSeek v4.1 Flash",
        modalities: {
          input: ["text", "image"],
        },
      },
      {
        id: "text-only-model",
        name: "Text Only",
        modalities: {
          input: ["text"],
        },
      },
    ],
  };

  const parsed = parseProviderRawModels(payload);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].supportsImage, true);
  assert.equal(parsed[1].supportsImage, false);
});


// ---- 需求 2026-10-05：模型列表请求头统一附带 Authorization: Bearer ----

test("buildModelListAuthHeaders: API Key 非空 → Authorization: Bearer <key>", () => {
  assert.deepEqual(buildModelListAuthHeaders("sk-abc123"), {
    Authorization: "Bearer sk-abc123",
  });
});

test("buildModelListAuthHeaders: 去除首尾空白后再拼 Bearer", () => {
  assert.deepEqual(buildModelListAuthHeaders("  sk-padded  "), {
    Authorization: "Bearer sk-padded",
  });
});

test("buildModelListAuthHeaders: Key 为空/空白/undefined/null → 不带 Authorization", () => {
  assert.deepEqual(buildModelListAuthHeaders(""), {});
  assert.deepEqual(buildModelListAuthHeaders("   "), {});
  assert.deepEqual(buildModelListAuthHeaders(undefined), {});
  assert.deepEqual(buildModelListAuthHeaders(null), {});
});

test("buildModelListAuthHeaders: 返回对象可直接展开进任意协议分支的 headers", () => {
  // 与 anthropic 分支的实际用法一致：Bearer 与协议原生头共存
  const merged = { ...buildModelListAuthHeaders("k1"), "x-api-key": "k1", "anthropic-version": "2023-06-01" };
  assert.equal(merged.Authorization, "Bearer k1");
  assert.equal(merged["x-api-key"], "k1");
  assert.equal(merged["anthropic-version"], "2023-06-01");
});

test("fetchProviderModels 源码：四个协议分支均使用 authHeaders（防回归）", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./fetchModels.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export async function fetchProviderModels"));
  // 每个分支的 headers 都必须展开 authHeaders
  const uses = (fn.match(/\.\.\.authHeaders/g) || []).length;
  assert.ok(uses >= 4, `期望至少 4 处 ...authHeaders（Ollama/Anthropic/Google/OpenAI），实际 ${uses}`);
  // 不允许再出现散落的内联 Bearer 拼接（统一走 helper）
  assert.equal(
    /Authorization:\s*`Bearer/.test(fn),
    false,
    "不应再内联拼 Bearer，统一用 buildModelListAuthHeaders",
  );
});
