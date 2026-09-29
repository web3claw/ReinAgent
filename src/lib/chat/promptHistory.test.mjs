/**
 * promptHistory 单测（P2）：追加去重 / 导航边界 / 存储消毒。
 * 运行：bun test src/lib/chat/promptHistory.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendPromptHistoryEntry,
  navigatePromptHistory,
} from "./promptHistory.ts";

test("appendPromptHistoryEntry：连续重复不追加，非连续重复保留", () => {
  assert.deepEqual(appendPromptHistoryEntry(["A"], "A"), ["A"], "连续相同不追加");
  assert.deepEqual(appendPromptHistoryEntry(["A", "B"], "A"), ["A", "B", "A"], "A/B/A 非连续保留");
  assert.deepEqual(appendPromptHistoryEntry(["A"], "  "), ["A"], "空白不追加");
  const limited = appendPromptHistoryEntry(
    ["a", "b", "c"],
    "d",
    3,
  );
  assert.deepEqual(limited, ["b", "c", "d"], "超限裁掉最旧");
});

test("navigatePromptHistory：↑ 从末尾往前、到顶停住；↓ 到底回空", () => {
  const entries = ["one", "two", "three"];
  // 首次 ↑：末条
  assert.deepEqual(navigatePromptHistory(entries, null, "up"), {
    nextIndex: 2,
    nextValue: "three",
    shouldHandle: true,
  });
  // ↑ 到顶停住
  assert.equal(navigatePromptHistory(entries, 0, "up").nextIndex, 0);
  // ↓ 在末条：退出浏览态（回空输入）
  assert.equal(navigatePromptHistory(entries, 2, "down").nextIndex, null);
  // ↓ 再按一次 → 回空输入
  assert.deepEqual(navigatePromptHistory(entries, 2, "down"), {
    nextIndex: null,
    nextValue: "",
    shouldHandle: true,
  });
  // 空历史不处理
  assert.equal(navigatePromptHistory([], null, "up").shouldHandle, false);
});
