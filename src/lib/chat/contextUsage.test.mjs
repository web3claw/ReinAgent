import { test } from "node:test";
import assert from "node:assert/strict";
import { findLastAssistantUsageMessage, buildContextUsageData, weightedChars } from "./contextUsage.ts";

test("weightedChars: 中文字符按 2 计，英文字符按 1 计", () => {
  assert.equal(weightedChars("hello"), 5);
  assert.equal(weightedChars("你好"), 4);
  assert.equal(weightedChars("hello 世界!"), 5 + 1 + 4 + 1);
});

test("findLastAssistantUsageMessage: 优先返回最近一条包含非零用量的 assistant 消息", () => {
  const m1 = { role: "user", text: "hi" };
  const m2 = {
    role: "assistant",
    text: "hello",
    apiMessage: { usage: { input: 2000, output: 100 } },
  };
  const m3 = { role: "user", text: "continue" };
  const m4 = {
    role: "assistant",
    text: "partial",
    apiMessage: { usage: { input: 0, output: 0, cacheRead: 0 } },
  };

  // 即使最后一条 m4 存在，但用量为 0，应精准挑出 m2
  const found = findLastAssistantUsageMessage([m1, m2, m3, m4]);
  assert.equal(found, m2);
});

test("findLastAssistantUsageMessage: 全部助手用量均为 0 时回退最后一条", () => {
  const m1 = {
    role: "assistant",
    apiMessage: { usage: { input: 0, output: 0 } },
  };
  const m2 = {
    role: "assistant",
    apiMessage: { usage: { input: 0, output: 0 } },
  };
  assert.equal(findLastAssistantUsageMessage([m1, m2]), m2);
});

test("findLastAssistantUsageMessage: 空列表或无 assistant 消息返回 undefined", () => {
  assert.equal(findLastAssistantUsageMessage([]), undefined);
  assert.equal(findLastAssistantUsageMessage([{ role: "user", text: "hi" }]), undefined);
});

test("buildContextUsageData: used <= 0 或 total <= 0 时 No-Fallback 返回 null", () => {
  const base = {
    messages: [{ role: "user", text: "hi" }],
    systemPrompt: "sys",
    toolsJson: "{}",
  };
  assert.equal(buildContextUsageData({ ...base, used: 0, total: 200000 }), null);
  assert.equal(buildContextUsageData({ ...base, used: 1000, total: 0 }), null);
  assert.equal(buildContextUsageData({ ...base, used: -1, total: 200000 }), null);
});

test("buildContextUsageData: 正常计算已用百分比与分类占比", () => {
  const data = buildContextUsageData({
    used: 50000,
    total: 200000,
    hitRate: 0.85,
    messages: [{ role: "user", text: "hello" }, { role: "assistant", text: "world" }],
    systemPrompt: "system prompt here",
    toolsJson: '{"tools":[]}',
    skillsJson: "enabled skill",
  });
  assert.ok(data !== null);
  assert.equal(data.used, 50000);
  assert.equal(data.total, 200000);
  assert.equal(data.percent, 25);
  assert.equal(data.hitRate, 0.85);
  assert.ok(data.categories.length > 0);
  const msgsCat = data.categories.find((c) => c.key === "messages");
  assert.ok(msgsCat && msgsCat.percent > 0);
});
