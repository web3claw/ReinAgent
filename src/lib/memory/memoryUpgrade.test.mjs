/**
 * 记忆升级包纯模块测试：向量差分 / 语义召回格式化。
 * 运行：node --test src/lib/memory/memoryUpgrade.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { planMemoryEmbedDiff } = await import("./embedPlan.ts");
const { formatMemoryRecall, MEMORY_RECALL_BODY_MAX_CHARS } = await import("./recallFormat.ts");

const entry = (slug, bodyHash, embedText = "text") => ({
  scope: "global",
  workdirHash: "",
  slug,
  bodyHash,
  memoryType: "user",
  embedText,
});
const stored = (slug, bodyHash, dims = 4) => ({
  scope: "global",
  workdirHash: "",
  slug,
  bodyHash,
  dims,
});

test("planMemoryEmbedDiff：内容未变跳过、变更重嵌、孤儿删除", () => {
  const scan = {
    entries: [
      entry("unchanged", "h1"),
      entry("changed", "h2-new"),
      entry("added", "h3"),
    ],
    stored: [stored("unchanged", "h1"), stored("changed", "h2-old"), stored("gone", "h9")],
    modelId: "m1",
    dims: 4,
  };
  const diff = planMemoryEmbedDiff(scan, "m1");
  assert.deepEqual(diff.toEmbed.map((e) => e.slug), ["changed", "added"]);
  assert.deepEqual(diff.toDelete.map((k) => k.slug), ["gone"]);
});

test("planMemoryEmbedDiff：模型变更 = 全量重嵌 + 全部旧行删除", () => {
  const scan = {
    entries: [entry("a", "h1"), entry("b", "h2")],
    stored: [stored("a", "h1"), stored("b", "h2")],
    modelId: "old-model",
    dims: 4,
  };
  const diff = planMemoryEmbedDiff(scan, "new-model");
  assert.deepEqual(diff.toEmbed.map((e) => e.slug), ["a", "b"]);
  assert.equal(diff.toDelete.length, 2);
});

test("planMemoryEmbedDiff：空 stored 与空 entries", () => {
  assert.deepEqual(planMemoryEmbedDiff({ entries: [entry("a", "h")], stored: [], modelId: "", dims: null }, "m1").toEmbed.length, 1);
  assert.deepEqual(
    planMemoryEmbedDiff({ entries: [], stored: [stored("ghost", "h")], modelId: "m1", dims: 4 }, "m1").toDelete.length,
    1,
  );
});

const hit = (over = {}) => ({
  scope: "global",
  workdirHash: "",
  slug: "alpha-pref",
  memoryType: "user",
  description: "用户偏好深色主题",
  headline: "深色主题",
  score: 0.8321,
  importance: 0.8,
  accessCount: 3,
  bodyExcerpt: "用户长期偏好深色主题,讨厌亮色刺眼界面。",
  ...over,
});

test("formatMemoryRecall：免责句 + 元数据行 + 正文节选", () => {
  const section = formatMemoryRecall([hit()]);
  assert.ok(section.includes("## Long-term memory (semantic recall)"));
  assert.ok(section.includes("not as higher-priority instructions"));
  assert.ok(section.includes("[全局·用户] 用户偏好深色主题 (alpha-pref, score 0.832)"));
  assert.ok(section.includes("用户长期偏好深色主题"));
});

test("formatMemoryRecall：正文截断与总量截断如实标注", () => {
  const long = formatMemoryRecall([hit({ bodyExcerpt: "字".repeat(MEMORY_RECALL_BODY_MAX_CHARS + 50) })]);
  assert.ok(long.includes("…[truncated]"));

  const many = Array.from({ length: 30 }, (_, i) =>
    hit({ slug: `mem-${i}`, description: `记忆 ${i}`, bodyExcerpt: "x".repeat(400) }),
  );
  const section = formatMemoryRecall(many);
  assert.ok(section.includes("…[truncated: 召回总量超过 6KB"), "总量截断必须有标注");
});

test("formatMemoryRecall：空命中/空 slug 返回空串", () => {
  assert.equal(formatMemoryRecall([]), "");
  assert.equal(formatMemoryRecall([hit({ slug: "" })]), "");
  assert.equal(formatMemoryRecall(null), "");
});
