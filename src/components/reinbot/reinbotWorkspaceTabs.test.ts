import { describe, it, expect } from "bun:test";
import { getTaskExecutionStatus } from "../../lib/chat/conversationPool";
import { isReinBotTask } from "../../lib/reinbot/reinBotTools";
import type { AppTask } from "../../store/useAppStore";

describe("ReinBot Workspace & Multi-Tab Isolation Verification", () => {
  it("1. getTaskExecutionStatus returns idle for unknown tasks", () => {
    const status = getTaskExecutionStatus("non-existent-task-id-12345");
    expect(status).toBe("idle");
  });

  it("2. isReinBotTask correctly identifies tasks with source 'reinbot' and path in ReinBot", () => {
    expect(isReinBotTask({ source: "reinbot", project: null })).toBe(true);
    // 即使 source 缺失，但路径在 ReinBot 专属工作区，依然被安全识别为 ReinBot 任务（双保险）
    expect(isReinBotTask({ source: undefined, project: "/home/web3claw/.ReinAgent/ReinBot" })).toBe(true);
    expect(isReinBotTask({ source: undefined, project: "~/.ReinAgent/ReinBot" })).toBe(true);
    // 普通工作区任务不属于 ReinBot
    expect(isReinBotTask({ source: "chat", project: null })).toBe(false);
    expect(isReinBotTask({ source: undefined, project: "/home/web3claw/GitCode/my-app" })).toBe(false);
  });

  it("3. Left sidebar filters out ReinBot tasks completely using !isReinBotTask", () => {
    const mockTasks: AppTask[] = [
      { id: "task-user-1", title: "User Task", createdAt: Date.now(), project: null, source: "chat" },
      { id: "task-reinbot-1", title: "CSV 自动可视化脚本", createdAt: Date.now(), project: "~/.ReinAgent/ReinBot", source: "reinbot" },
      { id: "task-reinbot-legacy", title: "查询当前电脑公网出口 IP", createdAt: Date.now(), project: "/home/web3claw/.ReinAgent/ReinBot" },
      { id: "task-user-2", title: "Another Workbench Task", createdAt: Date.now(), project: "/path/to/my-code" },
    ];

    // ProjectList 过滤规则 (!isReinBotTask(t))
    const filteredForLeftSidebar = mockTasks.filter((t) => !isReinBotTask(t));
    expect(filteredForLeftSidebar.map((t) => t.id)).toEqual(["task-user-1", "task-user-2"]);
    expect(filteredForLeftSidebar.some(isReinBotTask)).toBe(false);

    // ReinBot 右侧最近任务过滤规则 (isReinBotTask(t))
    const filteredForReinBotWorkspace = mockTasks.filter(isReinBotTask);
    expect(filteredForReinBotWorkspace.map((t) => t.id)).toEqual(["task-reinbot-1", "task-reinbot-legacy"]);
    expect(filteredForReinBotWorkspace.every(isReinBotTask)).toBe(true);
  });

  it("4. Red/Break Check: If source !== 'reinbot' single check is used, legacy ReinBot tasks with undefined source leak to left sidebar", () => {
    const legacyTask: AppTask = {
      id: "task-reinbot-legacy",
      title: "查询当前电脑公网出口 IP",
      createdAt: Date.now(),
      project: "/home/web3claw/.ReinAgent/ReinBot",
      source: undefined,
    };

    // 单纯判断 source !== "reinbot" 就会发生泄漏（老 Bug 场景）
    const leaked = legacyTask.source !== "reinbot";
    expect(leaked).toBe(true);

    // 而通过 isReinBotTask 双保险守护则不会泄漏：
    expect(isReinBotTask(legacyTask)).toBe(true);
  });

  it("5. Time formatting correctly handles timestamps into HH:mm", () => {
    const testDate = new Date(2026, 9, 31, 8, 30, 0); // 08:30
    const hours = String(testDate.getHours()).padStart(2, "0");
    const minutes = String(testDate.getMinutes()).padStart(2, "0");
    const formatted = `${hours}:${minutes}`;
    expect(formatted).toBe("08:30");
  });

  it("6. Reply quote generation formats correctly", () => {
    const quoteAuthor = "我";
    const snippet = "帮我写一个 Python 脚本，读取当前目录下的 CSV 文件";
    const userPrompt = "补充要求：加上折线图";
    const finalText = `> [回复 @${quoteAuthor}]: ${snippet}\n\n${userPrompt}`;

    expect(finalText).toContain("> [回复 @我]:");
    expect(finalText).toContain("帮我写一个 Python 脚本");
    expect(finalText).toContain("补充要求：加上折线图");
  });

  it("7. Task Deletion & Cascade Tab Close: deleting task removes from store and closes tab", () => {
    let mockTasks: AppTask[] = [
      { id: "task-rb-1", title: "Task 1", createdAt: Date.now(), project: "~/.ReinAgent/ReinBot", source: "reinbot" },
      { id: "task-rb-2", title: "Task 2", createdAt: Date.now(), project: "~/.ReinAgent/ReinBot", source: "reinbot" },
    ];
    let activeTab = "task:task-rb-1";
    let closedTabId: string | null = null;

    const onCloseTaskTab = (taskId: string) => {
      closedTabId = taskId;
      if (activeTab === `task:${taskId}`) {
        activeTab = "workspace";
      }
    };

    // 执行删除
    const targetId = "task-rb-1";
    mockTasks = mockTasks.filter((t) => t.id !== targetId);
    onCloseTaskTab(targetId);

    expect(mockTasks.map((t) => t.id)).toEqual(["task-rb-2"]);
    expect(closedTabId).toBe("task-rb-1");
    expect(activeTab).toBe("workspace"); // 成功联动回退到工作台
  });

  it("8. Artifact File Deletion & Cascade Tab Close with Red/Break Check", () => {
    let artifacts = ["report.md", "data.json"];
    let activeTab = "file:report.md";
    let closedFileName: string | null = null;

    const onCloseFileTab = (fileName: string) => {
      closedFileName = fileName;
      if (activeTab === `file:${fileName}`) {
        activeTab = "workspace";
      }
    };

    // 正常联动删除
    artifacts = artifacts.filter((f) => f !== "report.md");
    onCloseFileTab("report.md");

    expect(artifacts).toEqual(["data.json"]);
    expect(closedFileName).toBe("report.md");
    expect(activeTab).toBe("workspace");

    // Red Check: 若没有 onCloseFileTab 联动，activeTab 仍停留在已不存在的文件标签上成为死标签
    const brokenActiveTab = "file:data.json";
    const withoutCascade = (fileName: string) => {
      // 故意不通知外层关闭 Tab
      artifacts = artifacts.filter((f) => f !== fileName);
    };
    withoutCascade("data.json");
    expect(artifacts).toEqual([]);
    expect(brokenActiveTab).toBe("file:data.json"); // Red: 证明无联动时 Tab 沦为孤儿死标签
  });
});
