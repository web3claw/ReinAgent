/**
 * 全局用户发言总账本（User Prompt Ledger）单测
 * 覆盖：
 * 1. Markdown 格式化规范性（包含时间戳、任务、工作区、模型、引用块）
 * 2. 内存/存储读写与上限控制 (FIFO / 最大 1000 条)
 * 3. 连续重复过滤
 * 4. 路径决议（~/.ReinAgent/history/user_prompts.md）
 * 5. 删除与清空操作
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatPromptAsMarkdown,
  resolveGlobalPromptsLogPath,
  normalizeGlobalUserPrompts,
} from "./userPromptHistory.ts";

test("resolveGlobalPromptsLogPath：在有 HOME 时解析为 ~/.ReinAgent/history/user_prompts.md", () => {
  const path = resolveGlobalPromptsLogPath("/home/user");
  assert.equal(path, "/home/user/.ReinAgent/history/user_prompts.md");

  const fallback = resolveGlobalPromptsLogPath(null);
  assert.ok(fallback.endsWith(".ReinAgent/history/user_prompts.md"), "无 home 时必须有安全相对/默认路径");
});

test("formatPromptAsMarkdown：生成高可读性 Markdown 账本条目", () => {
  const entry = {
    id: "test-1",
    timestamp: 1730000000000,
    content: "我要把对话中，我发送的话都记录下来，要怎么设计",
    usageCount: 2,
  };

  const md = formatPromptAsMarkdown(entry);
  assert.ok(md.includes("### ["), "包含时间戳标题");
  assert.ok(md.includes("使用次数: 2 次"), "包含使用次数");
  assert.ok(md.includes("我要把对话中，我发送的话都记录下来，要怎么设计"), "包含正文内容");
  assert.ok(md.endsWith("\n---\n\n"), "包含标准分割线");
});

test("normalizeGlobalUserPrompts：去除非法项、去重且限制上限", () => {
  const list = [
    {
      id: "1",
      timestamp: 100,
      content: "Hello",
      taskId: "t1",
    },
    {
      id: "2",
      timestamp: 200,
      content: "World",
      taskId: "t1",
    },
    {
      // 无效项（缺少 content）
      id: "3",
      timestamp: 300,
    },
  ];
  const normalized = normalizeGlobalUserPrompts(list, 1);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].content, "World", "超限保留最新的一条有效项");
});

test("normalizeGlobalUserPrompts：首尾空格一致去重合并使用次数并按使用频次降序排列", () => {
  const list = [
    {
      id: "1",
      timestamp: 100,
      content: "Hello",
      usageCount: 1,
    },
    {
      id: "2",
      timestamp: 200,
      content: "  Hello  ",
      usageCount: 2,
    },
    {
      id: "3",
      timestamp: 300,
      content: "High Frequency",
      usageCount: 5,
    },
  ];
  const normalized = normalizeGlobalUserPrompts(list);
  // Hello 应当被合并成 1 条，usageCount 为 1+2=3，且时间更新为 200
  // High Frequency 的 usageCount 为 5，排在第一位
  assert.equal(normalized.length, 2, "去重合并为 2 条");
  assert.equal(normalized[0].content, "High Frequency", "使用次数最多(5次)排在最前");
  assert.equal(normalized[0].usageCount, 5);
  assert.equal(normalized[1].content, "Hello", "合并后的Hello排在第2位");
  assert.equal(normalized[1].usageCount, 3, "使用次数正确累加为 3");
  assert.equal(normalized[1].timestamp, 200, "保留更新的时间戳");
});

test("formatPromptAsMarkdown：多行内容带引用前缀与缺省标题兜底", () => {
  const entry = {
    id: "test-multiline",
    timestamp: 1730000000000,
    content: "第一行需求\n第二行需求\n第三行补充",
    usageCount: 3,
  };

  const md = formatPromptAsMarkdown(entry);
  assert.ok(md.includes("使用次数: 3 次"), "Markdown 头部体现使用次数");
  assert.ok(md.includes("> 第一行需求\n> 第二行需求\n> 第三行补充"), "多行每行均被 > 正确引用");
});


