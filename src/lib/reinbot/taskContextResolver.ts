import { invoke } from "@tauri-apps/api/core";
import type { AppTask } from "../../store/useAppStore";

export interface TaskDialogueMessageSummary {
  role: string;
  text?: string;
  toolName?: string;
  toolArgs?: string;
  toolResult?: string;
  error?: string;
  time?: number;
}

/**
 * 从文本中提取所有 @任务[xxx] 标签，并匹配当前任务列表中对应的 AppTask 对象。
 */
export function extractLinkedTasks(text: string, availableTasks: AppTask[]): AppTask[] {
  if (!text || !Array.isArray(availableTasks) || availableTasks.length === 0) {
    return [];
  }
  const regex = /@任务\[([^\]]+)\]/g;
  const matchedTaskIds = new Set<string>();
  const matchedTasks: AppTask[] = [];

  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const target = match[1].trim();
    if (!target) continue;

    // 优先按标题匹配，若未匹配则按任务 ID 匹配
    const found = availableTasks.find(
      (t) =>
        t.title?.trim() === target ||
        t.id?.trim() === target ||
        t.title?.trim().toLowerCase() === target.toLowerCase()
    );

    if (found && !matchedTaskIds.has(found.id)) {
      matchedTaskIds.add(found.id);
      matchedTasks.push(found);
    }
  }

  return matchedTasks;
}

/**
 * 解析 conversation_load_page 返回的原始数据库行，提取对话消息摘要。
 */
export function parseRawMessageRows(rows: any[]): TaskDialogueMessageSummary[] {
  if (!Array.isArray(rows)) return [];
  const results: TaskDialogueMessageSummary[] = [];

  for (const row of rows) {
    const role = row.role || "unknown";
    const parts = Array.isArray(row.parts) ? row.parts : [];

    let textContent = "";
    let toolArgs = "";
    let toolResult = "";

    for (const part of parts) {
      const kind = part.kind;
      let payload = part.payload;
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload);
        } catch {
          // 保持原字符串
        }
      }

      if (kind === "text") {
        if (typeof payload === "string") {
          textContent += payload;
        } else if (payload && typeof payload.text === "string") {
          textContent += payload.text;
        }
      } else if (kind === "tool_args") {
        toolArgs = typeof payload === "string" ? payload : JSON.stringify(payload);
      } else if (kind === "tool_result") {
        if (typeof payload === "string") {
          toolResult = payload;
        } else if (payload && typeof payload.resultText === "string") {
          toolResult = payload.resultText;
        } else if (payload) {
          toolResult = JSON.stringify(payload);
        }
      } else if (kind === "api_message" && !textContent) {
        if (payload && typeof payload.content === "string") {
          textContent = payload.content;
        }
      }
    }

    results.push({
      role,
      text: textContent.trim() || undefined,
      toolName: row.tool_name || undefined,
      toolArgs: toolArgs ? toolArgs.slice(0, 300) : undefined,
      toolResult: toolResult ? toolResult.slice(0, 400) : undefined,
      error: row.error || undefined,
      time: row.started_at || undefined,
    });
  }

  return results;
}

/**
 * 格式化任务的对话历史摘要，适配注入到 LLM 系统/背景提示词中。
 */
export function formatTaskDialogueSummary(
  task: AppTask,
  messages: TaskDialogueMessageSummary[]
): string {
  const lines: string[] = [];
  lines.push(`### 关联任务：【${task.title || task.id}】`);
  lines.push(`- **任务 ID**：\`${task.id}\``);
  if (task.project) {
    lines.push(`- **工作区项目**：\`${task.project}\``);
  }
  if (task.createdAt) {
    lines.push(`- **创建时间**：${new Date(task.createdAt).toLocaleString("zh-CN")}`);
  }

  if (messages.length === 0) {
    lines.push("- **历史对话记录**：*(暂无历史消息)*");
    return lines.join("\n");
  }

  lines.push(`- **历史对话与执行进展 (${messages.length} 轮记录)**：`);

  // 若消息较多，保留首部 2 条（初始目标）以及尾部 10 条（最新进展）
  let displayMsgs = messages;
  let truncatedNotice = "";
  if (messages.length > 14) {
    displayMsgs = [...messages.slice(0, 2), ...messages.slice(-10)];
    truncatedNotice = `\n  *(... 中间省略 ${messages.length - 12} 条早期对话 ...)*\n`;
  }

  const msgLines: string[] = [];
  for (let i = 0; i < displayMsgs.length; i++) {
    const m = displayMsgs[i];
    if (i === 2 && truncatedNotice) {
      msgLines.push(truncatedNotice);
    }
    const roleLabel =
      m.role === "user"
        ? "用户"
        : m.role === "assistant"
        ? "助手"
        : m.role === "tool"
        ? `工具调用[${m.toolName || "未知"}]`
        : m.role;

    if (m.text) {
      msgLines.push(`  - **[${roleLabel}]**: ${m.text.slice(0, 500)}`);
    } else if (m.toolName) {
      let toolLine = `  - **[${roleLabel}]**`;
      if (m.toolArgs) {
        toolLine += ` 参数: \`${m.toolArgs}\``;
      }
      if (m.toolResult) {
        toolLine += ` 结果: ${m.toolResult.replace(/\n+/g, " ")}`;
      }
      if (m.error) {
        toolLine += ` 失败原因: ${m.error}`;
      }
      msgLines.push(toolLine);
    }
  }

  lines.push(msgLines.join("\n"));
  return lines.join("\n");
}

/**
 * 根据 AppTask 列表，从 SQLite 异步加载对话并生成完整的关联任务背景上下文。
 */
export async function buildLinkedTasksPromptContext(tasks: AppTask[]): Promise<string> {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return "";
  }

  const summaries: string[] = [];

  for (const task of tasks) {
    try {
      const page = await invoke<{
        rows: any[];
        total: number;
        has_more: boolean;
      }>("conversation_load_page", { taskId: task.id, limit: 100 });

      const messages = parseRawMessageRows(page?.rows || []);
      summaries.push(formatTaskDialogueSummary(task, messages));
    } catch (err) {
      console.warn(`[taskContextResolver] Failed to load messages for task ${task.id}:`, err);
      // Fallback: 至少提供基础任务元数据
      summaries.push(formatTaskDialogueSummary(task, []));
    }
  }

  if (summaries.length === 0) return "";

  return [
    "",
    "---",
    "## 📌 关联任务的真实历史对话与执行进展背景",
    "以下是用户在当前对话中 @关联 的历史任务上下文（已从本地数据库调取）。请根据这些背景信息深入、准确地回答用户关于该任务的问题，无需再向用户重复索取该任务的历史对话信息：",
    "",
    ...summaries,
    "---",
    "",
  ].join("\n");
}
