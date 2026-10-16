import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("TurnGroupView 源码约束：中间叙述文本必须包裹 .md 样式容器", () => {
  const content = fs.readFileSync(path.resolve("src/components/chat/TurnGroupView.tsx"), "utf8");

  // 1. 检查 IntermediateText 内是否包裹了 md 类容器
  const intermediateTextMatch = content.match(/function IntermediateText\(\{[\s\S]*?return \(([\s\S]*?)\);\s*\}/);
  assert.ok(intermediateTextMatch, "必须存在 IntermediateText 组件定义");
  assert.match(
    intermediateTextMatch[1],
    /<div className="md">[\s\S]*?<MarkdownText/,
    "IntermediateText 必须包含 <div className=\"md\"> 容器包裹 MarkdownText，以确保 Markdown 样式生效",
  );
});

test("TurnGroupView 源码约束：ChatLoading 必须置于整个活动体的最底部，严禁嵌在中间文本内", () => {
  const content = fs.readFileSync(path.resolve("src/components/chat/TurnGroupView.tsx"), "utf8");

  // 2. 检查 lastAssistant 渲染内部严禁包含 ChatLoading
  const assistantActivityBlock = content.match(/if \(entry\.role === "assistant"\) \{([\s\S]*?)return \([\s\S]*?\);\s*\}/);
  if (assistantActivityBlock) {
    assert.doesNotMatch(
      assistantActivityBlock[0],
      /<ChatLoading/,
      "assistant entry 渲染体内部严禁直接嵌入 ChatLoading，避免小菊花卡在文本与工具卡片之间",
    );
  }

  // 3. 检查 activitySegments.map 之后，在 turn-body 底部渲染 ChatLoading
  assert.match(
    content,
    /activitySegments\.map\([\s\S]*?\)\}[\s\S]*?<ChatLoading[\s\S]*?<\/div>\s*\)\s*:\s*null\}/,
    "ChatLoading 必须置于 activitySegments 渲染之后、turn-body 闭合之前，确保处于最下方",
  );
});
