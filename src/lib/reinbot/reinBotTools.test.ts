import { describe, it, expect, beforeEach } from "bun:test";
import { createReinBotTaskTool, CREATE_TASK_TOOL_NAME } from "./reinBotTools";
import { useAppStore } from "../../store/useAppStore";
import { getReinBotWorkspaceRoot } from "../agent/workspace";

describe("ReinBot Tools & Task Creation Verification", () => {
  beforeEach(() => {
    // Reset store tasks
    useAppStore.setState({
      tasks: [],
      activeTaskId: null,
      selectedProject: null,
    });
  });

  it("1. create_task tool schema has correct name, parameters, and description", () => {
    const tool = createReinBotTaskTool();
    expect(tool.name).toBe(CREATE_TASK_TOOL_NAME);
    expect(tool.name).toBe("create_task");
    expect(tool.label).toBe("创建新任务");
    expect(tool.parameters).toBeDefined();
    expect(typeof tool.execute).toBe("function");
  });

  it("2. create_task successfully creates task in store with default ReinBot project", async () => {
    let createdEvent: { id: string; title: string; project: string } | null = null;
    const tool = createReinBotTaskTool({
      defaultProject: "/home/test/.ReinAgent/ReinBot",
      onTaskCreated: (task) => {
        createdEvent = task;
      },
    });

    const result = await tool.execute("call-1", {
      title: "排查接口 500 报错",
      initialPrompt: "检查 user API 的 500 根因",
    });

    expect(result.details.success).toBe(true);
    expect(result.details.title).toBe("排查接口 500 报错");
    expect(result.details.project).toBe("/home/test/.ReinAgent/ReinBot");

    const tasks = useAppStore.getState().tasks;
    expect(tasks.length).toBe(1);
    expect(tasks[0].title).toBe("排查接口 500 报错");
    expect(tasks[0].project).toBe("/home/test/.ReinAgent/ReinBot");

    expect(createdEvent).not.toBeNull();
    expect(createdEvent?.title).toBe("排查接口 500 报错");
  });

  it("3. create_task respects explicitly provided project workspace", async () => {
    const tool = createReinBotTaskTool();
    const result = await tool.execute("call-2", {
      title: "重构前端组件",
      project: "/home/web3claw/GitCode/MyProject",
    });

    expect(result.details.project).toBe("/home/web3claw/GitCode/MyProject");
    const tasks = useAppStore.getState().tasks;
    expect(tasks[0].project).toBe("/home/web3claw/GitCode/MyProject");
  });

  it("4. Red/Break Check: empty or whitespace title throws validation error", async () => {
    const tool = createReinBotTaskTool();
    await expect(tool.execute("call-err-1", { title: "" })).rejects.toThrow("任务标题不能为空");
    await expect(tool.execute("call-err-2", { title: "   " })).rejects.toThrow("任务标题不能为空");
  });

  it("5. Workspace Root Resolution: getReinBotWorkspaceRoot resolves to .ReinAgent/ReinBot", () => {
    const root = getReinBotWorkspaceRoot();
    expect(root).toContain(".ReinAgent/ReinBot");
  });

  it("6. Auto-Dispatch Verification: initialPrompt triggers onDispatchTask callback immediately", async () => {
    let dispatched: { taskId: string; prompt: string; project?: string } | null = null;
    const tool = createReinBotTaskTool({
      onDispatchTask: (taskId, prompt, project) => {
        dispatched = { taskId, prompt, project };
      },
    });

    const result = await tool.execute("call-auto-1", {
      title: "查询当前电脑 IP 地址",
      initialPrompt: "看看当前电脑ip是多少",
      autoRun: true,
    });

    expect(result.details.autoRun).toBe(true);
    expect(dispatched).not.toBeNull();
    expect(dispatched?.prompt).toBe("看看当前电脑ip是多少");
  });

  it("7. Red/Break Check: autoRun false prevents onDispatchTask from executing", async () => {
    let dispatched = false;
    const tool = createReinBotTaskTool({
      onDispatchTask: () => {
        dispatched = true;
      },
    });

    const result = await tool.execute("call-auto-2", {
      title: "草稿任务",
      initialPrompt: "准备稍后运行",
      autoRun: false,
    });

    expect(result.details.autoRun).toBe(false);
    expect(dispatched).toBe(false);
  });
});

