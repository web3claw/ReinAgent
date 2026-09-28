/**
 * selectionReference 单测（P2-C1）：限额 / 去重 / 移除 / userselect 尾块协议。
 * 运行：bun test src/lib/chat/selectionReference.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addSelectionReference,
  buildPromptWithSelections,
  clearSelectionReferences,
  getSelectionReferences,
  removeSelectionReference,
} from "./selectionReference.ts";

const T = "task-test";

test("添加/去重/限额", () => {
  clearSelectionReferences(T);
  assert.equal(addSelectionReference(T, { text: "第一段引用" }), null);
  assert.equal(addSelectionReference(T, { text: "第一段引用" }), "duplicate", "同文本去重");
  assert.equal(getSelectionReferences(T).length, 1);
  // 单条超限
  assert.equal(addSelectionReference(T, { text: "x".repeat(8_001) }), "single-limit");
  // 满员
  clearSelectionReferences(T);
  for (let i = 0; i < 8; i += 1) {
    assert.equal(addSelectionReference(T, { text: `引用${i}` }), null);
  }
  assert.equal(addSelectionReference(T, { text: "第 9 条" }), "max-items");
  // 总量超限：单条上限 8000 × 2 = 16000 不够撞总限——需三条（7900+7900+500=16300）
  clearSelectionReferences(T);
  assert.equal(addSelectionReference(T, { text: "y".repeat(7_900) }), null);
  assert.equal(addSelectionReference(T, { text: "z".repeat(7_900) }), null);
  assert.equal(addSelectionReference(T, { text: "w".repeat(500) }), "total-limit");
  clearSelectionReferences(T);
});

test("userselect 尾块协议：JSON 数组、path 可选、无引用原样返回", () => {
  clearSelectionReferences(T);
  assert.equal(buildPromptWithSelections(T, "原始问题"), "原始问题");
  addSelectionReference(T, { text: "选中 A" });
  addSelectionReference(T, { text: "选中 B", path: "src/a.ts" });
  const prompt = buildPromptWithSelections(T, "帮我看看");
  assert.ok(prompt.startsWith("帮我看看\n\n# userselect:\n```userselect\n"), "尾块格式");
  assert.ok(prompt.endsWith("\n```"));
  const json = prompt.split("```userselect\n")[1].split("\n```")[0];
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed, [{ text: "选中 A" }, { path: "src/a.ts", text: "选中 B" }]);
  clearSelectionReferences(T);
  assert.equal(buildPromptWithSelections(T, "原始问题"), "原始问题");
});

test("removeSelectionReference：按下标移除", () => {
  clearSelectionReferences(T);
  addSelectionReference(T, { text: "a" });
  addSelectionReference(T, { text: "b" });
  removeSelectionReference(T, 0);
  assert.deepEqual(getSelectionReferences(T).map((r) => r.text), ["b"]);
});
