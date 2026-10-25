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
