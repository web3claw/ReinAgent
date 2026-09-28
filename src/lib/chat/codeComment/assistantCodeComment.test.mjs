/**
 * ::code-comment 指令解析单测（P2-C2，ZCode assistantCodeComment 契约）。
 * 运行：bun test src/lib/chat/codeComment/assistantCodeComment.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAssistantCodeCommentCards,
  projectAssistantCodeComments,
} from "./assistantCodeComment.ts";

const WORKSPACE = "/repo";

test("解析完整指令：title/body/file 必填、start/end/priority 可选", () => {
  const content = [
    "前言。",
    '::code-comment{title="缺默认值" body="字段应加 #[serde(default)]" file="crates/foo/src/bar.rs" start=10 priority=0}',
    "后记。",
  ].join("\n");
  const cards = buildAssistantCodeCommentCards(content, WORKSPACE);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, "缺默认值");
  assert.equal(cards[0].priority, 0);
  assert.equal(cards[0].startLine, 10);
  assert.ok(cards[0].path.includes("bar.rs"), "路径应解析为绝对路径");
  assert.ok(cards[0].displayPath.endsWith("crates/foo/src/bar.rs"), "displayPath 应为相对路径");
});

test("代码围栏内的指令被忽略；缺必填字段的丢弃", () => {
  const content = [
    "```rust",
    '::code-comment{title="inside" body="x" file="a.rs"}',
    "```",
    '::code-comment{title="只有标题"}',
    "正文。",
  ].join("\n");
  assert.equal(buildAssistantCodeCommentCards(content, WORKSPACE).length, 0);
});

test("投影：指令原文从可见文本抹除，正文保留", () => {
  const content = [
    "开头。",
    '::code-comment{title="T" body="B" file="a.rs" priority=1}',
    "结尾。",
  ].join("\n");
  const projection = projectAssistantCodeComments(content, { streaming: false });
  assert.ok(!projection.visibleText.includes("::code-comment"), "指令原文应被抹除");
  assert.ok(projection.visibleText.includes("开头。"));
  assert.ok(projection.visibleText.includes("结尾。"));
  assert.equal(projection.comments.length, 1);
});

test("流式：未闭合指令尾部整体隐藏（防闪现）", () => {
  const content = "开头。\n\n::code-comment{title=\"T\" body=\"B\" file=\"a.rs\"";
  const projection = projectAssistantCodeComments(content, { streaming: true });
  assert.ok(!projection.visibleText.includes("::code-comment"), "半截指令不应闪现");
});

test("上限 50 张；priority 非法值丢弃", () => {
  // 合法指令放最前（limit=50 截断取前 50，噪声在后才不会被截掉）
  const parts = ['::code-comment{title="好的" body="b" file="ok.rs" priority=2}'];
  for (let i = 0; i < 55; i += 1) {
    parts.push(`::code-comment{title="t${i}" body="b${i}" file="f${i}.rs" priority=1}`);
  }
  const cards = buildAssistantCodeCommentCards(parts.join("\n"), WORKSPACE);
  assert.equal(cards.length, 50);
  assert.equal(cards.filter((c) => c.title === "好的").length, 1, "合法指令在 55 条噪声后仍被收录");
});
