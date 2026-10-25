/**
 * 笔记增强包纯函数测试：标签色/搜索解析/prompt 分区。
 * 运行：node --test src/components/notes/noteEnhance.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { tagColorIndex, parseTagSearch, noteMatchesSearch, buildInlineAiPrompt } = await import("./noteEnhance.ts");

test("tagColorIndex：稳定且分布", () => {
  assert.equal(tagColorIndex("rust"), tagColorIndex("rust"));
  const indexes = new Set(["rust", "笔记", "ai", "工作", "life", "todo", "项目", "idea", "deep", "chat"].map(tagColorIndex));
  assert.ok(indexes.size >= 4, `色板分布应 >=4（实际 ${indexes.size}）`);
  assert.ok(tagColorIndex("x") < 8);
});

test("parseTagSearch：tag: 前缀解析", () => {
  assert.deepEqual(parseTagSearch("tag:rust"), { tag: "rust", query: "" });
  assert.deepEqual(parseTagSearch("tag:rust 指针"), { tag: "rust", query: "指针" });
  assert.deepEqual(parseTagSearch("普通搜索"), { tag: null, query: "普通搜索" });
  assert.deepEqual(parseTagSearch(""), { tag: null, query: "" });
  assert.deepEqual(parseTagSearch("tag:rust  extra"), { tag: "rust", query: "extra" });
});

test("noteMatchesSearch：tag 过滤 + 常规词 + 大小写", () => {
  const note = { title: "Rust 指针指南", fileName: "rust-ptr.md", snippet: "ownership" };
  assert.equal(noteMatchesSearch(note, ["rust", "入门"], "tag:RUST"), true, "tag 大小写不敏感");
  assert.equal(noteMatchesSearch(note, ["入门"], "tag:rust"), false, "未命中标签过滤");
  assert.equal(noteMatchesSearch(note, ["rust"], "tag:rust 指南"), true, "tag+词双过滤");
  assert.equal(noteMatchesSearch(note, ["rust"], "tag:rust 不存在词"), false);
  assert.equal(noteMatchesSearch(note, undefined, "指针"), true, "常规词");
  assert.equal(noteMatchesSearch(note, undefined, ""), true, "空搜索全过");
});

test("buildInlineAiPrompt：有选区=分区（选区待处理/全文背景/禁回显明令）", () => {
  const p = buildInlineAiPrompt({
    instruction: "润色",
    selection: "选中的这句话",
    noteTitle: "测试笔记",
    fullMarkdown: "# 测试笔记\n开头段落。\n选中的这句话\n结尾段落。",
    selectionChars: 6,
    fullChars: 30,
  });
  assert.ok(p.includes("<<<SELECTION\n选中的这句话\nSELECTION>>>"));
  assert.ok(p.includes("<<<CONTEXT"));
  assert.ok(p.includes("严禁把背景内容复述进输出"), "必须有禁回显明令");
  assert.ok(p.indexOf("SELECTION>>>") < p.indexOf("<<<CONTEXT"), "选区段在背景段之前");
});

test("buildInlineAiPrompt：无选区=整篇待处理（现状语义）", () => {
  const p = buildInlineAiPrompt({
    instruction: "翻译",
    selection: "",
    noteTitle: "T",
    fullMarkdown: "全文内容",
    selectionChars: 0,
    fullChars: 4,
  });
  assert.ok(p.includes("<<<TEXT\n全文内容\nTEXT>>>"));
  assert.ok(!p.includes("<<<CONTEXT"), "无选区不得有背景段");
});
