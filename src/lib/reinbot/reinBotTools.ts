/**
 * reinBotTools.ts —— ReinBot 专属工具集（方案 D：智能管家对话创建任务）
 *
 * 核心功能：
 * 1. create_task: 大模型在对话中根据用户需求新建工程任务，参数包含 title、initialPrompt、project、autoRun；
 * 2. 任务创建后真实落库于 useAppStore / SQLite（syncTasks），并预填首条用户需求；
 * 3. 产物与工作区默认遵循 ~/.ReinAgent/ReinBot 规范。
 */

import { Type } from "typebox";
import { useAppStore } from "../../store/useAppStore";
import { getReinBotWorkspaceRoot } from "../agent/workspace";

export const CREATE_TASK_TOOL_NAME = "create_task";

export interface CreateTaskParams {
  title: string;
  initialPrompt?: string;
  project?: string;
  autoRun?: boolean;
}

export interface CreateTaskResult {
  success: boolean;
  taskId: string;
  title: string;
  project: string;
  autoRun: boolean;
}

/** 识别任务是否属于 ReinBot 专属管家任务（基于 source: 'reinbot' 或路径位于 ~/.ReinAgent/ReinBot） */
export function isReinBotTask(task: { source?: string; project?: string | null }): boolean {
  if (task.source === "reinbot") return true;
  if (
    typeof task.project === "string" &&
    (task.project.includes("/ReinBot") ||
      task.project.includes("\\ReinBot") ||
      task.project === "~/.ReinAgent/ReinBot")
  ) {
    return true;
  }
  return false;
}

export function createReinBotTaskTool(options?: {
  defaultProject?: string;
  providerId?: string;
  modelId?: string;
  onTaskCreated?: (task: { id: string; title: string; project: string }) => void;
  onDispatchTask?: (taskId: string, prompt: string, workspacePath?: string) => void;
}) {
  return {
    name: CREATE_TASK_TOOL_NAME,
    label: "创建新任务",
    description:
      "Create a new engineering task in ReinAgent. Use this tool when the user asks to create, schedule, initialize, or dispatch a new task. Provide a clear and concise title, and optionally the initial user prompt and target project workspace directory.",
    parameters: Type.Object({
      title: Type.String({
        description: "Concise title for the new task (max 100 characters)",
        minLength: 1,
        maxLength: 100,
      }),
      initialPrompt: Type.Optional(
        Type.String({
          description: "Initial prompt or requirement description for the task (max 5000 characters)",
          maxLength: 5000,
        }),
      ),
      project: Type.Optional(
        Type.String({
          description: "Target workspace project directory. Defaults to ~/.ReinAgent/ReinBot or active project",
        }),
      ),
      autoRun: Type.Optional(
        Type.Boolean({
          description: "Whether the task should be prepared for immediate run (default false)",
        }),
      ),
    }),
    execute: async (_toolCallId: string, params: unknown) => {
      const args = params as CreateTaskParams;
      const rawTitle = (args?.title ?? "").trim();
      if (!rawTitle) {
        throw new Error("create_task: 任务标题不能为空");
      }

      const store = useAppStore.getState();
      const resolvedProject =
        (args?.project ?? "").trim() ||
        options?.defaultProject ||
        store.selectedProject ||
        getReinBotWorkspaceRoot();

      // 在 store 与 SQLite 中真实落库新任务：绑定 ReinBot 当前选中的模型与 source: "reinbot"
      const taskId = store.createTask(
        rawTitle,
        resolvedProject,
        options?.providerId,
        options?.modelId,
        store.thinkingLevel,
        store.approvalMode,
        "reinbot",
      );

      const initialPrompt = (args?.initialPrompt ?? "").trim();
      const shouldAutoRun = args?.autoRun !== false;

      // 任务创建后：若包含初始需求且允许自动运行，直接接入会话执行池启动后台任务；
      // 若不自动运行，则派发预填事件填入输入框，确保用户点进任务不为空白主页。
      if (initialPrompt && shouldAutoRun && options?.onDispatchTask) {
        options.onDispatchTask(taskId, initialPrompt, resolvedProject);
      } else if (initialPrompt && typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("reinagent-prefill-prompt", {
            detail: { text: initialPrompt },
          }),
        );
      }

      options?.onTaskCreated?.({ id: taskId, title: rawTitle, project: resolvedProject });

      return {
        content: [
          {
            type: "text" as const,
            text: `已成功创建新任务「${rawTitle}」（ID: ${taskId}），工作区绑定为: ${resolvedProject}${
              initialPrompt && shouldAutoRun ? "，并已自动启动后台执行" : ""
            }。\n请在回复中向用户汇报，并使用「@任务[${rawTitle}]」标记以便用户点击胶囊直接跳转。`,
          },
        ],
        details: {
          success: true,
          taskId,
          title: rawTitle,
          project: resolvedProject,
          autoRun: shouldAutoRun,
        },
      };
    },
  };
}
