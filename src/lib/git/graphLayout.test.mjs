/**
 * graphLayout 的自动化验证（node:test）。
 * 运行：bun test src/lib/git/graphLayout.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { layoutGitGraph } from "./graphLayout.ts";

const c = (hash, parents = []) => ({ hash, parents });

test("线性历史：单泳道、行数与提交数一致", () => {
  // git log 顺序：最新在前，parent 恒在更高下标
  const layout = layoutGitGraph([c("c", ["b"]), c("b", ["a"]), c("a")]);
  assert.equal(layout.laneCount, 1, "线性历史应只有 1 条泳道");
  assert.equal(layout.rows.length, 3);
  for (const row of layout.rows) assert.equal(row.laneIndex, 0);
  // 顺序 = git log 顺序（新→旧），首行 y 最小
  assert.equal(layout.rows[0].hash, "c");
  assert.ok(layout.rows[0].y < layout.rows[1].y);
});

test("分支合并：合并提交产生第二条泳道并回归主线", () => {
  //          a --- b (main)
  //           \     \
  //            f1 --- m   （m 合并 f1，两父）
  const layout = layoutGitGraph([
    c("m", ["b", "f1"]),
    c("b", ["a"]),
    c("f1", ["a"]),
    c("a"),
  ]);
  assert.ok(layout.laneCount >= 2, "合并历史应出现 ≥2 条泳道");
  const laneSet = new Set(layout.rows.map((r) => r.laneIndex));
  assert.ok(laneSet.size >= 2, "节点应分布在多条泳道");
  // 每行都有坐标且 x 随泳道递增
  const lane0 = layout.rows.find((r) => r.laneIndex === 0);
  const lane1 = layout.rows.find((r) => r.laneIndex === 1);
  assert.ok(lane0 && lane1 && lane1.x > lane0.x);
});

test("窗口截断（parent 不在窗口内）：不崩溃且行完整", () => {
  const layout = layoutGitGraph([c("y", ["z"]), c("z", ["ghost-parent"])]);
  assert.equal(layout.rows.length, 2);
  assert.ok(layout.paths.length >= 1, "可见拓扑至少画出一条连线");
});

test("空历史：不崩溃、laneCount 兜底 1", () => {
  const layout = layoutGitGraph([]);
  assert.equal(layout.rows.length, 0);
  assert.equal(layout.laneCount, 1);
  assert.equal(layout.height > 0, true);
});

test("倒序/损坏拓扑（parent 在子之前）：护栏介入不死循环", () => {
  const layout = layoutGitGraph([c("a"), c("b", ["a"])]);
  assert.equal(layout.rows.length, 2, "行完整（护栏只终止布局，不丢行）");
});
