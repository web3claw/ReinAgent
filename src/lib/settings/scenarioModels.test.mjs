/**
 * 场景化默认模型解析验证（node:test）。
 * 运行：node --test src/lib/settings/scenarioModels.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chatDefaultOf,
  validateBinding,
  resolveScenario,
  bindingToNoteKey,
  noteKeyToBinding,
  scenarioBindingToProviderConfig,
  getActiveOrChatModelConfig,
} from "./scenarioModels.ts";

const providers = [
  {
    id: "prov-a",
    enabled: true,
    defaultModelId: "m1",
    models: [
      { id: "m1", enabled: true },
      { id: "m2", enabled: false },
    ],
  },
  { id: "prov-b", enabled: false, models: [{ id: "x", enabled: true }] },
];

test("chatDefaultOf：modelId 缺省回 defaultModelId，再回首个启用模型", () => {
  assert.deepEqual(chatDefaultOf({ provider: "prov-a", modelId: "" }, providers), { providerId: "prov-a", modelId: "m1" });
  assert.deepEqual(chatDefaultOf({ provider: "prov-a", modelId: "m2" }, providers), { providerId: "prov-a", modelId: "m2" });
  // defaultModelId 恰被禁用时回首个启用模型（m1 本身启用，构造无 default 的场景）
  assert.deepEqual(chatDefaultOf({ provider: "prov-a", modelId: "" }, [{ ...providers[0], defaultModelId: "m2" }]), {
    providerId: "prov-a",
    modelId: "m1",
  });
  assert.equal(chatDefaultOf({ provider: "", modelId: "m1" }, providers), null);
  // 服务商不存在：返回原样 provider + 空 modelId（no-fallback：不猜测替代）
  const dangling = chatDefaultOf({ provider: "prov-none" }, providers);
  assert.equal(dangling?.providerId, "prov-none");
  assert.equal(dangling?.modelId, "");
});

test("validateBinding：四级失效原因精确区分", () => {
  assert.equal(validateBinding(null, providers), null);
  assert.equal(validateBinding({ providerId: "prov-a", modelId: "m1" }, providers), null);
  assert.equal(validateBinding({ providerId: "prov-z", modelId: "m1" }, providers), "providerMissing");
  assert.equal(validateBinding({ providerId: "prov-b", modelId: "x" }, providers), "providerDisabled");
  assert.equal(validateBinding({ providerId: "prov-a", modelId: "mX" }, providers), "modelMissing");
  assert.equal(validateBinding({ providerId: "prov-a", modelId: "m2" }, providers), "modelDisabled");
  // allowModelNotListed：embedding 手填模型跳过模型级校验（服务商级仍校验）
  assert.equal(validateBinding({ providerId: "prov-a", modelId: "bge-m3" }, providers, { allowModelNotListed: true }), null);
  assert.equal(validateBinding({ providerId: "prov-b", modelId: "bge-m3" }, providers, { allowModelNotListed: true }), "providerDisabled");
});

test("resolveScenario：有效绑定直出、失效/未配置回退聊天默认并带原因", () => {
  const chatDefault = { providerId: "prov-a", modelId: "m1" };
  // 有效绑定
  assert.deepEqual(
    resolveScenario({ scenario: "noteAi", providers, chatDefault, binding: { providerId: "prov-a", modelId: "m1" } }),
    { scenario: "noteAi", effective: { providerId: "prov-a", modelId: "m1" }, fallbackUsed: false, invalidReason: null },
  );
  // 未配置 → 回退
  assert.deepEqual(
    resolveScenario({ scenario: "embedding", providers, chatDefault, binding: null }),
    { scenario: "embedding", effective: chatDefault, fallbackUsed: true, invalidReason: null },
  );
  // 绑定失效（模型被禁用）→ 回退 + 原因
  const res = resolveScenario({ scenario: "memoryOrganizer", providers, chatDefault, binding: { providerId: "prov-a", modelId: "m2" } });
  assert.equal(res.fallbackUsed, true);
  assert.equal(res.invalidReason, "modelDisabled");
  assert.deepEqual(res.effective, chatDefault);
  // 聊天默认本身也空 → effective null（UI 明示无默认）
  assert.equal(resolveScenario({ scenario: "noteAi", providers, chatDefault: null, binding: null }).effective, null);
});

test("noteKey ⇄ binding 互转：空、斜杠边界、模型 id 含斜杠", () => {
  assert.equal(bindingToNoteKey(null), "");
  assert.equal(bindingToNoteKey({ providerId: "p", modelId: "m/x" }), "p/m/x");
  assert.deepEqual(noteKeyToBinding(""), null);
  assert.deepEqual(noteKeyToBinding("p/m/x"), { providerId: "p", modelId: "m/x" });
  assert.deepEqual(noteKeyToBinding("/m"), null);
  assert.deepEqual(noteKeyToBinding("p/"), null);
});

test("scenarioBindingToProviderConfig：activeTask 优先回退，再回退全局默认", () => {
  const providersWithConfig = [
    { id: "prov-a", enabled: true, apiKey: "key-a", baseUrl: "https://a.com", models: [{ id: "m1", enabled: true }, { id: "m2", enabled: true }] },
    { id: "prov-b", enabled: true, apiKey: "key-b", baseUrl: "https://b.com", models: [{ id: "b1", enabled: true }] },
  ];
  const settings = { provider: "prov-a", modelId: "m1", apiKey: "default-key" };

  // 1. 显式 binding 存在时优先采用
  const res1 = scenarioBindingToProviderConfig({ providerId: "prov-b", modelId: "b1" }, providersWithConfig, settings, { providerId: "prov-a", modelId: "m2" });
  assert.equal(res1.config?.provider, "prov-b");
  assert.equal(res1.config?.modelId, "b1");
  assert.equal(res1.fallbackUsed, false);

  // 2. 无显式 binding，但 activeTask 指定了模型 → 优先使用 activeTask 模型
  const res2 = scenarioBindingToProviderConfig(null, providersWithConfig, settings, { providerId: "prov-a", modelId: "m2" });
  assert.equal(res2.config?.provider, "prov-a");
  assert.equal(res2.config?.modelId, "m2");
  assert.equal(res2.fallbackUsed, true);

  // 3. 无显式 binding，activeTask 未指定 → 回退全局默认
  const res3 = scenarioBindingToProviderConfig(null, providersWithConfig, settings, null);
  assert.equal(res3.config?.provider, "prov-a");
  assert.equal(res3.config?.modelId, "m1");
  assert.equal(res3.fallbackUsed, true);
});

test("getActiveOrChatModelConfig：统一模型决议（优先当前会话，回退全局设置）", () => {
  const providersWithConfig = [
    { id: "prov-a", enabled: true, apiKey: "key-a", baseUrl: "https://a.com", models: [{ id: "m1", enabled: true }, { id: "m2", enabled: true }] },
  ];
  const settings = { provider: "prov-a", modelId: "m1" };

  // 有活动会话模型
  const activeRes = getActiveOrChatModelConfig({ providerId: "prov-a", modelId: "m2" }, settings, providersWithConfig);
  assert.equal(activeRes.config?.provider, "prov-a");
  assert.equal(activeRes.config?.modelId, "m2");
  assert.equal(activeRes.fromActiveTask, true);

  // 无活动会话模型 → 回退全局默认
  const defaultRes = getActiveOrChatModelConfig(null, settings, providersWithConfig);
  assert.equal(defaultRes.config?.provider, "prov-a");
  assert.equal(defaultRes.config?.modelId, "m1");
  assert.equal(defaultRes.fromActiveTask, false);
});

