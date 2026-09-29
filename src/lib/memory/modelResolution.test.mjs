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
  models: [],
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

test("供应商存在但 API Key 为空 → 抛错（No-Fallback，不静默换模型）", async () => {
  await assert.rejects(
    () =>
      resolveIndependentMemoryModelDeps(
        { organizerModel: { customProviderId: "workbench", model: "m1" } },
        [provider({ apiKey: "  " })],
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
