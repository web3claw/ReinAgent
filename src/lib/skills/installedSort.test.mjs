import test from "node:test";
import assert from "node:assert/strict";
import { sortInstalledSkillItems } from "./installedSort.ts";
import { DEFAULT_INSTALLED_SKILL_SORT, isInstalledSkillSort } from "./installedSort.ts";

const s1 = { name: "skills-creator", baseDir: "a", installedAt: 5 };
const s2 = { name: "zeta", baseDir: "b", installedAt: 100 };
const s3 = { name: "alpha", baseDir: "c", installedAt: 300 };
const s4 = { name: "beta", baseDir: "d", installedAt: null };
const s5 = { name: "aaa", baseDir: "e", installedAt: 50 };
const s6 = { name: "alpha", baseDir: "aa", installedAt: null };
const items = [s1, s2, s3, s4, s5, s6];
const getSkill = (item) => item;
const selected = new Set(["zeta"]);

const names = (list) => list.map((item) => `${item.name}@${item.baseDir}`);

// ---- name-asc ----

test("name-asc：常驻技能 → 已选 → 其余，组内按名称、同名按 baseDir", () => {
  const sorted = sortInstalledSkillItems(items, "name-asc", selected, getSkill);
  assert.deepEqual(names(sorted), [
    "skills-creator@a",
    "zeta@b",
    "aaa@e",
    "alpha@aa",
    "alpha@c",
    "beta@d",
  ]);
});

// ---- name-desc ----

test("name-desc：组间 rank 不变，组内名称倒序，baseDir 仍升序", () => {
  const sorted = sortInstalledSkillItems(items, "name-desc", selected, getSkill);
  assert.deepEqual(names(sorted), [
    "skills-creator@a",
    "zeta@b",
    "beta@d",
    "alpha@aa",
    "alpha@c",
    "aaa@e",
  ]);
});

// ---- installed-desc ----

test("installed-desc：installedAt 新的在前，缺失值垫底，空值间按名称", () => {
  const sorted = sortInstalledSkillItems(items, "installed-desc", selected, getSkill);
  assert.deepEqual(names(sorted), [
    "skills-creator@a",
    "zeta@b",
    "alpha@c",
    "aaa@e",
    "alpha@aa",
    "beta@d",
  ]);
});

// ---- 默认值与校验 ----

test("排序偏好默认值与守卫", () => {
  assert.equal(DEFAULT_INSTALLED_SKILL_SORT, "name-asc");
  assert.equal(isInstalledSkillSort("installed-desc"), true);
  assert.equal(isInstalledSkillSort("name-asc"), true);
  assert.equal(isInstalledSkillSort("name-desc"), true);
  assert.equal(isInstalledSkillSort("newest"), false);
  assert.equal(isInstalledSkillSort(null), false);
});

test("不修改原数组", () => {
  const copy = [...items];
  sortInstalledSkillItems(items, "installed-desc", selected, getSkill);
  assert.deepEqual(items, copy);
});
