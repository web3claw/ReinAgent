import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClawHubDownloadUrl,
  buildClawHubSkillKey,
  normalizeClawHubSkillCard,
  selectClawHubOwnerCandidate,
} from "./clawHub.ts";

// ---- normalizeClawHubSkillCard：两种 shape ----

test("扁平 shape：顶层字段 + installs 别名 + ownerHandle", () => {
  const card = normalizeClawHubSkillCard({
    slug: "Demo Skill",
    displayName: "Demo",
    summary: "A demo skill",
    topics: ["demo"],
    version: "1.0.0",
    downloads: 5,
    stars: 2,
    installs: 7,
    updatedAt: 100,
    ownerHandle: "@Alice",
  });
  assert.ok(card);
  assert.equal(card.slug, "Demo Skill");
  assert.equal(card.latestVersion, "1.0.0");
  assert.equal(card.downloads, 5);
  assert.equal(card.stars, 2);
  assert.equal(card.installsCurrent, 7);
  assert.equal(card.updatedAt, 100);
  assert.equal(card.ownerHandle, "@Alice");
  assert.equal(card.displayName, "Demo");
  assert.deepEqual(card.topics, ["demo"]);
  // webUrl / downloadUrl 兜底生成
  assert.ok(card.webUrl.startsWith("https://clawhub.ai/"));
  const download = new URL(card.downloadUrl);
  assert.equal(download.origin + download.pathname, "https://clawhub.ai/api/v1/download");
  assert.equal(download.searchParams.get("slug"), "Demo Skill");
  assert.equal(download.searchParams.get("tag"), "latest");
  assert.equal(download.searchParams.get("ownerHandle"), "@Alice");
});

test("嵌套 shape：stats/latestVersion/tags/owner 归一化", () => {
  const card = normalizeClawHubSkillCard({
    slug: "bar",
    stats: { downloads: 10, stars: 3, installsCurrent: 4 },
    latestVersion: { version: "2.0.0" },
    tags: { latest: "1.9.9" },
    owner: { handle: "bob" },
    topics: ["x"],
  });
  assert.ok(card);
  assert.equal(card.latestVersion, "2.0.0", "latestVersion.version 优先于 tags.latest");
  assert.equal(card.downloads, 10);
  assert.equal(card.stars, 3);
  assert.equal(card.installsCurrent, 4);
  assert.equal(card.ownerHandle, "bob");
  assert.equal(card.summary, "");
  assert.equal(card.updatedAt, null);
});

test("缺 slug 返回 null，非对象返回 null", () => {
  assert.equal(normalizeClawHubSkillCard({}), null);
  assert.equal(normalizeClawHubSkillCard({ slug: "   " }), null);
  assert.equal(normalizeClawHubSkillCard("nope"), null);
  assert.equal(normalizeClawHubSkillCard(null), null);
});

// ---- owner 收敛 ----

const base = {
  displayName: "Demo",
  summary: "same summary",
  topics: [],
  latestVersion: null,
  downloads: 0,
  installsCurrent: 0,
  stars: 0,
  updatedAt: null,
};

test("唯一 slug 匹配直接收敛", () => {
  const skill = { ...base, slug: "demo", ownerHandle: null };
  const candidates = [
    { ...base, slug: "demo", ownerHandle: "alice" },
    { ...base, slug: "other", ownerHandle: "bob" },
  ];
  const resolved = selectClawHubOwnerCandidate(skill, candidates);
  assert.equal(resolved.ownerHandle, "alice");
});

test("多候选按 updatedAt 收敛", () => {
  const skill = { ...base, slug: "demo", ownerHandle: null, updatedAt: 100 };
  const candidates = [
    { ...base, slug: "demo", ownerHandle: "alice", updatedAt: 200 },
    { ...base, slug: "demo", ownerHandle: "bob", updatedAt: 100 },
  ];
  const resolved = selectClawHubOwnerCandidate(skill, candidates);
  assert.equal(resolved.ownerHandle, "bob");
});

test("多候选按 latestVersion → downloads 逐级收敛", () => {
  const skill = {
    ...base,
    slug: "demo",
    ownerHandle: null,
    latestVersion: "2.0",
    downloads: 50,
  };
  const candidates = [
    { ...base, slug: "demo", ownerHandle: "alice", latestVersion: "1.0", downloads: 50 },
    { ...base, slug: "demo", ownerHandle: "bob", latestVersion: "2.0", downloads: 1 },
    { ...base, slug: "demo", ownerHandle: "carol", latestVersion: "2.0", downloads: 50 },
  ];
  // latestVersion 收敛到 bob/carol，downloads 再收敛到 carol
  const resolved = selectClawHubOwnerCandidate(skill, candidates);
  assert.equal(resolved.ownerHandle, "carol");
});

test("完全无法区分时返回 null（避免错绑发布者）", () => {
  const skill = { ...base, slug: "demo", ownerHandle: null };
  const candidates = [
    { ...base, slug: "demo", ownerHandle: "alice" },
    { ...base, slug: "demo", ownerHandle: "bob" },
  ];
  assert.equal(selectClawHubOwnerCandidate(skill, candidates), null);
});

test("候选里没有带 owner 的同名 slug 返回 null", () => {
  const skill = { ...base, slug: "demo", ownerHandle: null };
  const candidates = [
    { ...base, slug: "demo", ownerHandle: null },
    { ...base, slug: "demo", ownerHandle: "" },
  ];
  assert.equal(selectClawHubOwnerCandidate(skill, candidates), null);
});

// ---- key 与下载地址 ----

test("buildClawHubSkillKey 归一化 owner 与 slug", () => {
  assert.equal(buildClawHubSkillKey({ slug: "Demo", ownerHandle: "@Alice" }), "clawhub:alice/demo");
  assert.equal(buildClawHubSkillKey({ slug: "Demo", ownerHandle: null }), "clawhub:?/demo");
});

test("buildClawHubDownloadUrl 缺省不带 ownerHandle", () => {
  const url = new URL(buildClawHubDownloadUrl("demo"));
  assert.equal(url.searchParams.get("ownerHandle"), null);
  assert.equal(url.searchParams.get("slug"), "demo");
});
