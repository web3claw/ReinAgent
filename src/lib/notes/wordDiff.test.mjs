/**
 * 词级 diff 验证（node:test）。
 * 运行：node --test src/lib/notes/wordDiff.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenizeForDiff, wordDiff, wordDiffStats } from "./wordDiff.ts";

test("tokenize：CJK 连串成词、拉丁串（含点分扩展名）成词、空白成段", () => {
  assert.deepEqual(tokenizeForDiff("修改 main.rs 文件"), ["修改", " ", "main.rs", " ", "文件"]);
});

test("wordDiff：中文改词产出 del+add 片段，same 保持", () => {
  const segs = wordDiff("部署在服务器 A", "部署在服务器 B");
  assert.deepEqual(segs, [
    { type: "same", text: "部署在服务器 " },
    { type: "del", text: "A" },
    { type: "add", text: "B" },
  ]);
});

test("wordDiff：英文整词对齐不劈词", () => {
  const segs = wordDiff("update the config file", "update the readme file");
  const kinds = segs.map((s) => s.type).join(",");
  assert.equal(kinds, "same,del,add,same");
  assert.equal(segs[1].text, "config");
  assert.equal(segs[2].text, "readme");
});

test("wordDiff：空侧与全等", () => {
  assert.deepEqual(wordDiff("", "新增内容"), [{ type: "add", text: "新增内容" }]);
  assert.deepEqual(wordDiff("原内容", ""), [{ type: "del", text: "原内容" }]);
  assert.deepEqual(wordDiff("same", "same"), [{ type: "same", text: "same" }]);
  assert.deepEqual(wordDiff("", ""), []);
});

test("wordDiff：超 2000 token 降级为整体替换单段", () => {
  const big = Array.from({ length: 2500 }, (_, i) => `w${i}`).join(" ");
  const segs = wordDiff(big, `${big} tail`);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].type, "del");
  assert.equal(segs[1].type, "add");
});

test("wordDiffStats：增删字符数统计", () => {
  const stats = wordDiffStats(wordDiff("部署在服务器 A", "部署在服务器 B"));
  assert.deepEqual(stats, { added: 1, removed: 1 });
});
