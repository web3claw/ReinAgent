import { test } from "node:test";
import assert from "node:assert/strict";
const {
  parseAssistantModel,
  isValidThinkingLevel,
  buildAssistantBindingsPlan,
} = await import("./assistantBindings.ts");
const { isBuiltinShadowId, builtinAssistantDefs } = await import("./assistantDefs.ts");

test("parseAssistantModel：合法形态解析，非法返回 null（No-Fallback）", () => {
  assert.deepEqual(parseAssistantModel("deepseek/deepseek-chat"), {
    providerId: "deepseek",
    modelId: "deepseek-chat",
  });
  // modelId 本身可含斜杠（providerId = 第一个 / 之前）
  assert.deepEqual(parseAssistantModel("workbuddy/deepseek-v4.1-flash"), {
    providerId: "workbuddy",
    modelId: "deepseek-v4.1-flash",
  });
  assert.equal(parseAssistantModel(undefined), null);
  assert.equal(parseAssistantModel(""), null);
  assert.equal(parseAssistantModel("no-slash"), null);
  assert.equal(parseAssistantModel("/model-only"), null);
  assert.equal(parseAssistantModel("provider/"), null);
});

test("isValidThinkingLevel：七档全认，未知拒绝", () => {
  for (const level of ["off", "default", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(isValidThinkingLevel(level), true, level);
  }
  assert.equal(isValidThinkingLevel("ultra"), false);
  assert.equal(isValidThinkingLevel(undefined), false);
  assert.equal(isValidThinkingLevel(""), false);
});

test("buildAssistantBindingsPlan：全绑定", () => {
  const plan = buildAssistantBindingsPlan(
    {
      id: "a",
      name: "A",
      description: "",
      prompt: "p",
      model: "deepseek/deepseek-chat",
      thinkingLevel: "high",
      skills: ["s1", "s2"],
      mcpServers: ["m1"],
    },
    ["m1", "m2", "m3"],
  );
  assert.deepEqual(plan.taskModel, { providerId: "deepseek", modelId: "deepseek-chat" });
  assert.equal(plan.taskThinkingLevel, "high");
  assert.deepEqual(plan.skillSelection, ["s1", "s2"]);
  // 整组替换：绑定外（m2/m3）不在启用集合内
  assert.deepEqual(plan.mcpEnabledIds, ["m1"]);
  assert.match(plan.summary, /模型/);
  assert.match(plan.summary, /思考级别/);
  assert.match(plan.summary, /技能×2/);
  assert.match(plan.summary, /MCP×1/);
});

test("buildAssistantBindingsPlan：无绑定 = 全 undefined（维持现状）", () => {
  const plan = buildAssistantBindingsPlan({ id: "g", name: "G", description: "", prompt: "p" }, ["m1"]);
  assert.equal(plan.taskModel, undefined);
  assert.equal(plan.taskThinkingLevel, undefined);
  assert.equal(plan.skillSelection, undefined);
  assert.equal(plan.mcpEnabledIds, undefined);
  assert.equal(plan.summary, "");
});

test("buildAssistantBindingsPlan：非法值跳过（thinkingLevel 未知 / model 无斜杠）", () => {
  const plan = buildAssistantBindingsPlan(
    { id: "x", name: "X", description: "", prompt: "p", model: "bad", thinkingLevel: "ultra", skills: ["s"] },
    ["m1"],
  );
  assert.equal(plan.taskModel, undefined);
  assert.equal(plan.taskThinkingLevel, undefined);
  assert.deepEqual(plan.skillSelection, ["s"]);
});

test("buildAssistantBindingsPlan：null 助手 = 维持现状", () => {
  const plan = buildAssistantBindingsPlan(null, ["m1"]);
  assert.equal(plan.taskModel, undefined);
  assert.equal(plan.skillSelection, undefined);
  assert.equal(plan.mcpEnabledIds, undefined);
});

test("isBuiltinShadowId：与内置 id 同名 = 编辑过的内置（仍归内置组）", () => {
  for (const def of builtinAssistantDefs()) {
    assert.equal(isBuiltinShadowId(def.id), true, def.id);
  }
  assert.equal(isBuiltinShadowId("my-custom-assistant"), false);
  assert.equal(isBuiltinShadowId(""), false);
});
