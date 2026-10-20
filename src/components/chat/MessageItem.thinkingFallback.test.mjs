import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("MessageItem: 当助手正文为空且存在思考输出时，必须启用 thinking 兜底展示与复制", () => {
  const content = fs.readFileSync(path.resolve("src/components/chat/MessageItem.tsx"), "utf8");

  // 1. 检查思考兜底判断逻辑
  assert.match(
    content,
    /isThinkingFallback\s*=\s*[\s\S]*?message\.role === "assistant"[\s\S]*?!rawText\.trim\(\)[\s\S]*?assistantThinking\.trim\(\)\.length > 0/,
    "必须在助手正文为空且存在非空思考文本时判定为 isThinkingFallback",
  );

  // 2. 检查 MarkdownText 是否使用 displayText 兜底文本
  assert.match(
    content,
    /<MarkdownText\s+text=\{displayText\}/,
    "MarkdownText 必须使用 displayText 进行渲染，确保思考文本能外显",
  );

  // 3. 检查是否展示了思考兜底提示标识
  assert.match(
    content,
    /isThinkingFallback\s*&&\s*\([\s\S]*?<Brain[\s\S]*?thinkingOutputFallback/,
    "isThinkingFallback 为真时必须展示含有 thinkingOutputFallback 与 Brain 图标的提示标识",
  );

  // 4. 检查复制逻辑中是否回退复制 thinkingText
  assert.match(
    content,
    /thinkingText[\s\S]*?message\.role === "assistant"[\s\S]*?"thinking" in message[\s\S]*?const text =[\s\S]*?thinkingText/,
    "handleCopy 必须在正文为空时回退复制 thinkingText，防止复制出空内容",
  );
});

test("i18n: 必须在 zh 与 en 中定义 thinkingOutputFallback", () => {
  const i18nContent = fs.readFileSync(path.resolve("src/i18n/index.ts"), "utf8");

  assert.match(
    i18nContent,
    /thinkingOutputFallback:\s*"思考过程输出（模型未区分独立正文）"/,
    "zh 字典必须包含 thinkingOutputFallback",
  );

  assert.match(
    i18nContent,
    /thinkingOutputFallback:\s*"Thought output \(model did not separate final text\)"/,
    "en 字典必须包含 thinkingOutputFallback",
  );
});
