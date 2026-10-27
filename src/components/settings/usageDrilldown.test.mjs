/**
 * 用量下钻纯函数验证（node:test）。
 * 运行：node --test src/components/settings/usageDrilldown.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// 经 vite 的 ts 直跑走 .ts 源（node --experimental-strip-types 由测试运行器处理）
import { compareDelta } from "./UsageSourceSection.tsx";

test("compareDelta 五分支", () => {
  assert.deepEqual(compareDelta(100, 80), { text: "+25%", dir: "up" });
  assert.deepEqual(compareDelta(80, 100), { text: "-20%", dir: "down" });
  assert.deepEqual(compareDelta(100, 100), { text: "0%", dir: "flat" });
  assert.deepEqual(compareDelta(0, 0), { text: "0%", dir: "flat" });
  assert.equal(compareDelta(50, 0).dir, "new");
  assert.equal(compareDelta(0, 50).dir, "gone");
});

test("compareDelta 精度：±10% 内保留一位小数，之外取整", () => {
  assert.equal(compareDelta(105, 100).text, "+5%");
  assert.equal(compareDelta(100.5, 100).text, "+0.5%");
  assert.equal(compareDelta(137, 100).text, "+37%");
});
