import { describe, it, expect, vi } from "bun:test";

/**
 * 自动化任务会话复用逻辑单元测试（对齐 App.tsx 中 dispatchAutomationRun 的决策函数）
 */

export interface AutomationTaskLike {
  id: string;
  title: string;
  workspacePath: string | null;
  providerId: string;
  modelId: string;
  source?: string;
  automationId?: string;
}

export function resolveAutomationTask(
  existingTasks: AutomationTaskLike[],
  payload: {
    automationId?: string;
    title: string;
    workspacePath?: string | null;
    modelProvider?: string;
    modelId?: string;
    reuseConversation?: boolean;
  },
  providerId: string,
  modelId: string,
  createTaskMock: (title: string, ws: string | null, pid: string, mid: string, aId?: string) => string,
  updateModelMock: (taskId: string, pid: string, mid: string) => void,
): string {
  const shouldReuse = payload.reuseConversation !== false;
  let taskId: string | undefined;

  if (shouldReuse) {
    const existingTask = existingTasks.find(
      (t) =>
        (payload.automationId && t.automationId === payload.automationId) ||
        (t.source === "automation" && t.title === payload.title),
    );
    if (existingTask) {
      taskId = existingTask.id;
      if (!existingTask.automationId && payload.automationId) {
        existingTask.automationId = payload.automationId;
      }
      if (existingTask.providerId !== providerId || existingTask.modelId !== modelId) {
        updateModelMock(taskId, providerId, modelId);
      }
    }
  }

  if (!taskId) {
    taskId = createTaskMock(
      payload.title,
      payload.workspacePath ?? null,
      providerId,
      modelId,
      payload.automationId,
    );
  }

  return taskId;
}

describe("Automation Conversation Reuse Logic", () => {
  it("默认开启复用（reuseConversation 未传或 true）：按 automationId 精确命中已有会话并复用", () => {
    const tasks: AutomationTaskLike[] = [
      {
        id: "task-auto-1",
        title: "每日科技日报",
        workspacePath: "/home/test",
        providerId: "deepseek",
        modelId: "deepseek-chat",
        source: "automation",
        automationId: "auto-1001",
      },
    ];

    const createTask = vi.fn();
    const updateModel = vi.fn();

    const selectedTaskId = resolveAutomationTask(
      tasks,
      {
        automationId: "auto-1001",
        title: "每日科技日报",
        reuseConversation: true,
      },
      "deepseek",
      "deepseek-chat",
      createTask,
      updateModel,
    );

    expect(selectedTaskId).toBe("task-auto-1");
    expect(createTask).not.toHaveBeenCalled();
    expect(updateModel).not.toHaveBeenCalled();
  });

  it("无缝兼容旧历史会话：按标题与 source === 'automation' 匹配已有会话并补齐绑定 automationId", () => {
    const tasks: AutomationTaskLike[] = [
      {
        id: "task-legacy-auto",
        title: "每日科技日报（GitHub Trending + HN Show HN）",
        workspacePath: null,
        providerId: "deepseek",
        modelId: "deepseek-chat",
        source: "automation",
        // 旧会话尚无 automationId
      },
    ];

    const createTask = vi.fn();
    const updateModel = vi.fn();

    const selectedTaskId = resolveAutomationTask(
      tasks,
      {
        automationId: "auto-daily-news",
        title: "每日科技日报（GitHub Trending + HN Show HN）",
      },
      "deepseek",
      "deepseek-chat",
      createTask,
      updateModel,
    );

    expect(selectedTaskId).toBe("task-legacy-auto");
    expect(tasks[0].automationId).toBe("auto-daily-news");
    expect(createTask).not.toHaveBeenCalled();
  });

  it("复用已有会话时若自动化更新了模型，自动同步任务绑定的模型", () => {
    const tasks: AutomationTaskLike[] = [
      {
        id: "task-auto-1",
        title: "每日科技日报",
        workspacePath: "/home/test",
        providerId: "deepseek",
        modelId: "deepseek-chat",
        source: "automation",
        automationId: "auto-1001",
      },
    ];

    const createTask = vi.fn();
    const updateModel = vi.fn();

    const selectedTaskId = resolveAutomationTask(
      tasks,
      {
        automationId: "auto-1001",
        title: "每日科技日报",
        reuseConversation: true,
      },
      "custom-magpie",
      "glm-4-flash",
      createTask,
      updateModel,
    );

    expect(selectedTaskId).toBe("task-auto-1");
    expect(createTask).not.toHaveBeenCalled();
    expect(updateModel).toHaveBeenCalledWith("task-auto-1", "custom-magpie", "glm-4-flash");
  });

  it("显式配置为 reuseConversation: false 时，即使存在已有会话也强制创建新任务", () => {
    const tasks: AutomationTaskLike[] = [
      {
        id: "task-auto-1",
        title: "每日科技日报",
        workspacePath: "/home/test",
        providerId: "deepseek",
        modelId: "deepseek-chat",
        source: "automation",
        automationId: "auto-1001",
      },
    ];

    const createTask = vi.fn(() => "task-new-2");
    const updateModel = vi.fn();

    const selectedTaskId = resolveAutomationTask(
      tasks,
      {
        automationId: "auto-1001",
        title: "每日科技日报",
        reuseConversation: false,
      },
      "deepseek",
      "deepseek-chat",
      createTask,
      updateModel,
    );

    expect(selectedTaskId).toBe("task-new-2");
    expect(createTask).toHaveBeenCalledWith(
      "每日科技日报",
      null,
      "deepseek",
      "deepseek-chat",
      "auto-1001",
    );
  });

  it("首次运行无已有任务时，自动创建新任务并打标", () => {
    const tasks: AutomationTaskLike[] = [];

    const createTask = vi.fn(() => "task-created-first");
    const updateModel = vi.fn();

    const selectedTaskId = resolveAutomationTask(
      tasks,
      {
        automationId: "auto-first",
        title: "每周安全巡检",
        reuseConversation: true,
      },
      "deepseek",
      "deepseek-chat",
      createTask,
      updateModel,
    );

    expect(selectedTaskId).toBe("task-created-first");
    expect(createTask).toHaveBeenCalledWith(
      "每周安全巡检",
      null,
      "deepseek",
      "deepseek-chat",
      "auto-first",
    );
  });
});
