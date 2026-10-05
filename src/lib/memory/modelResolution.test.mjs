/**
 * resolveIndependentMemoryModelDeps 验证（P2 尾巴 #6）。
 * 运行：bun test src/lib/memory/modelResolution.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { resolveIndependentMemoryModelDeps } = await import("./modelResolution.ts");

const provider = (over = {}) => ({
  id: "workbench",
  name: "WorkBench",
  apiFormat: "openai-chat-completions",
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test",
  enabled: true,
  models: [{ id: "m1", name: "m1", enabled: true }],
  isCustom: true,
  defaultModelId: "m1",
  ...over,
});

test("未配置 organizerModel → null（回落主模型）", async () => {
  assert.equal(await resolveIndependentMemoryModelDeps({}, [provider()]), null);
  assert.equal(await resolveIndependentMemoryModelDeps({ organizerModel: null }, [provider()]), null);
  assert.equal(
    await resolveIndependentMemoryModelDeps({ organizerModel: { model: "m1" } }, [provider()]),
    null,
    "缺 customProviderId 亦视为未配置",
  );
});

test("供应商不存在 → null 回落（不抛错）", async () => {
  assert.equal(
    await resolveIndependentMemoryModelDeps(
      { organizerModel: { customProviderId: "ghost", model: "m1" } },
      [provider()],
    ),
    null,
  );
});

test("供应商存在但 API Key 为空（云端非免 Key）→ 抛错（No-Fallback，不静默换模型）", async () => {
  await assert.rejects(
    () =>
      resolveIndependentMemoryModelDeps(
        { organizerModel: { customProviderId: "workbench", model: "m1" } },
        // 非本地网关（isCustom=false → 不免 Key），缺 Key 必须抛错
        [provider({ apiKey: "  ", isCustom: false, id: "workbench" })],
      ),
    /API Key 为空/,
  );
});

test("配置完整 → 构建 ExtractionModelDeps（label 含 provider/model）", async () => {
  const deps = await resolveIndependentMemoryModelDeps(
    { organizerModel: { customProviderId: "workbench", model: "m1" } },
    [provider()],
  );
  assert.ok(deps);
  assert.equal(deps.label, "workbench/m1");
  assert.equal(deps.api.includes("openai"), true);
  assert.equal(typeof deps.stream, "function");
  assert.equal(deps.getApiKey("x"), "sk-test");
});

// ---- F7：运行时 enabled 复查（禁用不该只体现在下拉菜单里）----

test("F7 供应商被禁用 → 抛错（不静默回落）", async () => {
  await assert.rejects(
    () =>
      resolveIndependentMemoryModelDeps(
        { organizerModel: { customProviderId: "workbench", model: "m1" } },
        [provider({ enabled: false })],
      ),
    /已被禁用/,
  );
});

test("F7 模型被禁用 → 抛错", async () => {
  await assert.rejects(
    () =>
      resolveIndependentMemoryModelDeps(
        { organizerModel: { customProviderId: "workbench", model: "m1" } },
        [provider({ models: [{ id: "m1", name: "m1", enabled: false }] })],
      ),
    /不可用/,
  );
});

test("F7 模型已删除（不在供应商模型列表）→ 抛错", async () => {
  await assert.rejects(
    () =>
      resolveIndependentMemoryModelDeps(
        { organizerModel: { customProviderId: "workbench", model: "ghost-model" } },
        [provider()],
      ),
    /不可用/,
  );
});

test("F5 免 Key 本地网关（ollama）缺 Key → 不抛错，走真实请求", async () => {
  const deps = await resolveIndependentMemoryModelDeps(
    { organizerModel: { customProviderId: "ollama", model: "m1" } },
    [provider({ id: "ollama", apiKey: "", isCustom: false, baseUrl: "http://localhost:11434" })],
  );
  assert.ok(deps, "免 Key 网关应可解析，不得落入 faux/抛错");
  assert.equal(deps.getApiKey("x"), "");
});

test("F5 自定义本地网关（isCustom + baseUrl）缺 Key → 不抛错", async () => {
  const deps = await resolveIndependentMemoryModelDeps(
    { organizerModel: { customProviderId: "workbench", model: "m1" } },
    [provider({ apiKey: "  " })],
  );
  assert.ok(deps);
});

// ---- 新增：免 Key 判定单一真相源 ----
// modelResolution 走的路径与 settings/types.providerAllowsMissingApiKey 必须一致。

test("免 Key 判定：预设 ollama 恒免 Key；非 ollama 且有 Key 才算可用", async () => {
  const { providerAllowsMissingApiKey, isProviderUsable } = await import(
    "../../components/settings/model-provider/types.ts"
  );
  assert.equal(providerAllowsMissingApiKey({ id: "ollama", isCustom: false, baseUrl: "" }), true);
  assert.equal(providerAllowsMissingApiKey({ id: "deepseek", isCustom: false, baseUrl: "https://api.deepseek.com" }), false);
  assert.equal(providerAllowsMissingApiKey({ id: "custom-1", isCustom: true, baseUrl: "http://localhost:1234" }), true);
  assert.equal(providerAllowsMissingApiKey({ id: "custom-1", isCustom: true, baseUrl: "" }), false);

  // isProviderUsable 额外要求 enabled
  assert.equal(isProviderUsable({ id: "workbench", isCustom: true, baseUrl: "http://x", apiKey: "k", enabled: true }), true);
  assert.equal(isProviderUsable({ id: "workbench", isCustom: true, baseUrl: "http://x", apiKey: "k", enabled: false }), false);
  assert.equal(isProviderUsable({ id: "deepseek", isCustom: false, baseUrl: "https://api.deepseek.com", apiKey: "", enabled: true }), false);
  assert.equal(isProviderUsable({ id: "ollama", isCustom: false, baseUrl: "http://localhost:11434", apiKey: "", enabled: true }), true);
});
