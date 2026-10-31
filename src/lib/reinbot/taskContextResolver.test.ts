import { describe, it, expect } from "bun:test";
import {
  extractLinkedTasks,
  parseRawMessageRows,
  formatTaskDialogueSummary,
} from "./taskContextResolver";
import type { AppTask } from "../../store/useAppStore";

describe("taskContextResolver Unit Tests", () => {
  const mockTasks: AppTask[] = [
    {
      id: "task-1791502542526-2ygr1",
      title: "os-taxonomy",
      createdAt: 1791502542526,
      project: "/home/web3claw/GitCode/os-taxonomy",
    },
    {
      id: "task-2",
      title: "每日科技日报",
      createdAt: 1793353373018,
      project: null,
    },
  ];

  it("1. extractLinkedTasks accurately extracts and matches tasks by title or id", () => {
    const text = "@任务[os-taxonomy] 查看一下这个任务，顺便对比 @任务[每日科技日报]";
    const matched = extractLinkedTasks(text, mockTasks);
    expect(matched.length).toBe(2);
    expect(matched[0].id).toBe("task-1791502542526-2ygr1");
    expect(matched[1].id).toBe("task-2");
  });

  it("2. extractLinkedTasks deduplicates multiple identical @任务 tags", () => {
    const text = "@任务[os-taxonomy] 请分析 @任务[os-taxonomy] 这个任务的最新进展";
    const matched = extractLinkedTasks(text, mockTasks);
    expect(matched.length).toBe(1);
    expect(matched[0].title).toBe("os-taxonomy");
  });

  it("3. extractLinkedTasks returns empty array for nonexistent or invalid tags", () => {
    const text = "这是一段没有关联任务的普通消息 @任务[不存在的任务] @任务[]";
    const matched = extractLinkedTasks(text, mockTasks);
    expect(matched.length).toBe(0);
  });

  it("4. parseRawMessageRows correctly extracts text, tool_args and tool_results", () => {
    const mockRows = [
      {
        role: "user",
        started_at: 1000,
        parts: [{ kind: "text", payload: JSON.stringify({ text: "分析一下这个项目" }) }],
      },
      {
        role: "assistant",
        started_at: 1001,
        parts: [{ kind: "text", payload: "我先抓取页面结构" }],
      },
      {
        role: "tool",
        tool_name: "exec_command",
        started_at: 1002,
        parts: [
          { kind: "tool_args", payload: JSON.stringify({ cmd: "git status" }) },
          { kind: "tool_result", payload: JSON.stringify({ resultText: "On branch main" }) },
        ],
      },
    ];

    const parsed = parseRawMessageRows(mockRows);
    expect(parsed.length).toBe(3);
    expect(parsed[0].role).toBe("user");
    expect(parsed[0].text).toBe("分析一下这个项目");
    expect(parsed[1].role).toBe("assistant");
    expect(parsed[1].text).toBe("我先抓取页面结构");
    expect(parsed[2].role).toBe("tool");
    expect(parsed[2].toolName).toBe("exec_command");
    expect(parsed[2].toolArgs).toContain("git status");
    expect(parsed[2].toolResult).toContain("On branch main");
  });

  it("5. formatTaskDialogueSummary generates rich structured context", () => {
    const task = mockTasks[0];
    const messages = [
      { role: "user", text: "分析一下这个项目" },
      { role: "assistant", text: "好的，我已经分析完毕" },
    ];
    const summary = formatTaskDialogueSummary(task, messages);
    expect(summary).toContain("### 关联任务：【os-taxonomy】");
    expect(summary).toContain(task.id);
    expect(summary).toContain("**[用户]**: 分析一下这个项目");
    expect(summary).toContain("**[助手]**: 好的，我已经分析完毕");
  });

  it("6. Red/Break Check: corrupted or empty rows does not crash and handles safely", () => {
    expect(() => parseRawMessageRows(null as any)).not.toThrow();
    expect(parseRawMessageRows(null as any)).toEqual([]);

    const corruptedRows = [
      { role: "user", parts: [{ kind: "unknown", payload: "{invalid json" }] },
      { role: null, parts: null },
    ];
    const parsed = parseRawMessageRows(corruptedRows);
    expect(parsed.length).toBe(2);
    expect(parsed[0].role).toBe("user");
    expect(parsed[1].role).toBe("unknown");
  });
});
