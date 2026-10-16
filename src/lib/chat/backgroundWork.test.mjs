/**
 * backgroundWork.test.mjs —— 后台工作会话隔离与过滤测试
 * 运行：bun test src/lib/chat/backgroundWork.test.mjs
 */

import { describe, expect, test } from "bun:test";
import {
  bindTerminalToConversation,
  filterBackgroundWork,
  syncConversationTerminals,
  getTerminalConversation,
} from "./backgroundWork.ts";

describe("BackgroundWork 会话级隔离测试 (Red Check)", () => {
  test("1 · 新建任务（conversationId 未提供或 undefined）：必须返回空，绝不泄漏其他任务的进程", () => {
    const rawState = {
      terminals: [
        { taskId: "bg-1", startedAtMs: 1000, outputTail: "server running" },
        { taskId: "bg-2", startedAtMs: 2000, outputTail: "vite ready" },
      ],
      subagents: [
        { id: "sub-1", type: "Explore", description: "research", startedAt: 1000, stoppable: true },
      ],
    };

    // 新建任务时，传入 undefined
    const filtered = filterBackgroundWork(rawState, undefined);
    expect(filtered.terminals).toEqual([]);
    expect(filtered.subagents).toEqual([]);
  });

  test("2 · 跨会话隔离：会话 A 只能看到属于会话 A 的后台终端与子代理", () => {
    bindTerminalToConversation("bg-ocr-1", "conv-A");
    bindTerminalToConversation("bg-dev-2", "conv-B");

    const rawState = {
      terminals: [
        { taskId: "bg-ocr-1", startedAtMs: 1000, outputTail: "ocr ready", conversationId: "conv-A" },
        { taskId: "bg-dev-2", startedAtMs: 2000, outputTail: "dev server", conversationId: "conv-B" },
      ],
      subagents: [
        { id: "sub-A", type: "Code", description: "coder A", startedAt: 1000, stoppable: true, conversationId: "conv-A" },
        { id: "sub-B", type: "Test", description: "tester B", startedAt: 2000, stoppable: true, conversationId: "conv-B" },
      ],
    };

    const workA = filterBackgroundWork(rawState, "conv-A");
    expect(workA.terminals.map((t) => t.taskId)).toEqual(["bg-ocr-1"]);
    expect(workA.subagents.map((s) => s.id)).toEqual(["sub-A"]);

    const workB = filterBackgroundWork(rawState, "conv-B");
    expect(workB.terminals.map((t) => t.taskId)).toEqual(["bg-dev-2"]);
    expect(workB.subagents.map((s) => s.id)).toEqual(["sub-B"]);

    // 未知会话 C
    const workC = filterBackgroundWork(rawState, "conv-C");
    expect(workC.terminals).toEqual([]);
    expect(workC.subagents).toEqual([]);
  });

  test("3 · 从历史消息同步终端归属：从 background_bash 的 toolResult 恢复映射", () => {
    const messages = [
      { role: "user", content: "启动 OCR 服务" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-1",
            name: "background_bash",
            input: { command: "python ocr.py" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: "Background task started: bg-recovered-99",
            details: { taskId: "bg-recovered-99" },
          },
        ],
      },
    ];

    syncConversationTerminals("conv-ocr", messages);
    expect(getTerminalConversation("bg-recovered-99")).toBe("conv-ocr");
  });
});
