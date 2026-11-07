import assert from "node:assert/strict";
import { test } from "node:test";
import { clipSlug, clipToday, clipFileName, clipFrontmatter } from "./clipFormat";

test("clipSlug：空白折叠与禁字符替换", () => {
  assert.equal(clipSlug("Hello World"), "Hello-World");
  assert.equal(clipSlug("Rust: 2026 指南"), "Rust-2026-指南");
  assert.equal(clipSlug("a/b\\c:d*e?f\"g<h>i|j"), "a-b-c-d-e-f-g-h-i-j");
  assert.equal(clipSlug("多  --  连字符"), "多-连字符");
});

test("clipSlug：限长 60 与空标题兜底", () => {
  const long = clipSlug("长".repeat(100));
  assert.equal(long.length, 60);
  assert.equal(clipSlug(""), "untitled");
  assert.equal(clipSlug("///"), "untitled");
  assert.equal(clipSlug("---"), "untitled");
});

test("clipToday：UTC 日期", () => {
  // 2026-11-02T01:20:00Z → 2026-11-02
  assert.equal(clipToday(1793582400 * 1000), "2026-11-02");
});

test("clipFileName：日期 + slug + .md", () => {
  assert.equal(clipFileName("你好 世界", 1793582400 * 1000), "2026-11-02-你好-世界.md");
});

test("clipFrontmatter：字段齐全与标签行", () => {
  const md = clipFrontmatter({
    title: "测试文章",
    summary: "这是总结。",
    sourceUrl: "https://example.com/p/1",
    site: "example.com",
    channel: "qq",
    tags: ["测试", "rust"],
    now: 1793582400 * 1000,
  });
  assert.ok(md.startsWith("---\n"));
  assert.ok(md.includes("source_url: https://example.com/p/1"));
  assert.ok(md.includes("channel: qq"));
  assert.ok(md.includes("tags: [测试, rust]"));
  assert.ok(md.includes("# 测试文章"));
  assert.ok(md.includes("这是总结。"));
  assert.ok(md.includes("来源：https://example.com/p/1"));
});

test("clipFrontmatter：无标签时无 tags 行", () => {
  const md = clipFrontmatter({
    title: "t",
    summary: "s",
    sourceUrl: "https://e.com",
    now: 0,
  });
  assert.ok(!md.includes("tags:"));
});
