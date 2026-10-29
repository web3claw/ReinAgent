/**
 * 全局用户发言总账本（Global User Prompt Ledger）。
 *
 * 极简高频复用库设计：
 * 1. 界面抽屉极简展示：移除冗余的项目与模型标签，按钮合并到卡片顶部；
 * 2. 使用次数统计与合并：去除头尾空格后内容一致的发言，自动合并并使 usageCount + 1，更新时间戳；
 * 3. 排序规则：默认按使用次数降序（最常用的排在最前），次数相同时按最新时间倒序；
 * 4. 双写本地文件：自动追加写入宿主 ~/.ReinAgent/history/user_prompts.md。
 */

import { kvGet, kvSet, getStoredUserHome } from "../storage/db";

export const MAX_GLOBAL_USER_PROMPTS = 1000;
export const GLOBAL_PROMPT_HISTORY_STORAGE_KEY = "reinagent-global-user-prompts";

export interface UserPromptEntry {
  id: string;
  timestamp: number;
  content: string;
  usageCount: number;
  taskId?: string;
  taskTitle?: string;
  workspaceRoot?: string;
  providerId?: string;
  modelId?: string;
}

/** 格式化日期为 YYYY-MM-DD HH:mm:ss 本地时间 */
export function formatLocalTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/** 解析本地全局日志文件的绝对路径 */
export function resolveGlobalPromptsLogPath(homeDir?: string | null): string {
  const home = homeDir?.trim() || getStoredUserHome()?.trim();
  if (home && home.length > 0) {
    const cleanHome = home.replace(/[/\\]+$/, "");
    return `${cleanHome}/.ReinAgent/history/user_prompts.md`;
  }
  return ".ReinAgent/history/user_prompts.md";
}

/** 格式化单条发言为极简的 Markdown 账本片段（强调时间与使用频次） */
export function formatPromptAsMarkdown(entry: UserPromptEntry): string {
  const timeStr = formatLocalTimestamp(entry.timestamp);
  const count = entry.usageCount || 1;
  const lines: string[] = [];

  lines.push(`### [${timeStr}] 使用次数: ${count} 次`);
  lines.push("");
  lines.push(`> ${entry.content.replace(/\n/g, "\n> ")}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  return lines.join("\n") + "\n";
}

/** 校验并清理数据：去除头尾空格后一致的内容去重合并并累加使用次数，默认按使用频次从多到少降序排列 */
export function normalizeGlobalUserPrompts(
  entries: readonly unknown[],
  limit = MAX_GLOBAL_USER_PROMPTS,
): UserPromptEntry[] {
  if (!Array.isArray(entries)) return [];
  const map = new Map<string, UserPromptEntry>();

  for (const item of entries) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.content !== "string") continue;
    const cleanContent = raw.content.trim();
    if (!cleanContent) continue;

    const currentCount =
      typeof raw.usageCount === "number" && raw.usageCount > 0
        ? Math.floor(raw.usageCount)
        : 1;
    const currentTs =
      typeof raw.timestamp === "number" ? raw.timestamp : Date.now();
    const currentId =
      typeof raw.id === "string"
        ? raw.id
        : `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const existing = map.get(cleanContent);
    if (existing) {
      existing.usageCount += currentCount;
      existing.timestamp = Math.max(existing.timestamp, currentTs);
    } else {
      map.set(cleanContent, {
        id: currentId,
        timestamp: currentTs,
        content: cleanContent,
        usageCount: currentCount,
        taskId: typeof raw.taskId === "string" ? raw.taskId : undefined,
      });
    }
  }

  const result = Array.from(map.values());

  // 排序规则：使用次数降序（高频排在最前）；次数相同时按最新时间倒序
  result.sort((a, b) => {
    if (b.usageCount !== a.usageCount) {
      return b.usageCount - a.usageCount;
    }
    return b.timestamp - a.timestamp;
  });

  const maxLimit = Math.max(1, limit);
  return result.slice(0, maxLimit);
}

/** 读取全局历史记录 */
export function readGlobalUserPrompts(): UserPromptEntry[] {
  const raw = kvGet(GLOBAL_PROMPT_HISTORY_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return normalizeGlobalUserPrompts(Array.isArray(parsed) ? parsed : []);
  } catch {
    return [];
  }
}

/** 持久化保存全局历史记录 */
export function persistGlobalUserPrompts(entries: readonly UserPromptEntry[]): void {
  const cleaned = normalizeGlobalUserPrompts(entries);
  kvSet(GLOBAL_PROMPT_HISTORY_STORAGE_KEY, JSON.stringify(cleaned));
  notifyListeners();
}

type PromptHistoryListener = () => void;
const listeners = new Set<PromptHistoryListener>();

export function subscribeGlobalUserPrompts(listener: PromptHistoryListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyListeners(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      console.error("[userPromptHistory] listener error:", err);
    }
  }
}

/**
 * 记录一条用户发言（双写通道）：
 * 1. 查找是否已存在相同内容（忽略首尾空格）：若存在则 usageCount + 1 并刷新时间；若不存在则新增；
 * 2. 异步追加到本地总账本 Markdown 文件。
 */
export async function recordGlobalUserPrompt(
  draft: Omit<UserPromptEntry, "id" | "timestamp" | "usageCount"> & {
    id?: string;
    timestamp?: number;
    usageCount?: number;
  },
): Promise<UserPromptEntry | null> {
  const content = draft.content.trim();
  if (!content) return null;

  const current = readGlobalUserPrompts();
  const existingIndex = current.findIndex((item) => item.content.trim() === content);

  let targetEntry: UserPromptEntry;
  if (existingIndex >= 0) {
    const existing = current[existingIndex];
    targetEntry = {
      ...existing,
      content,
      timestamp: Date.now(),
      usageCount: (existing.usageCount || 1) + 1,
      taskId: draft.taskId || existing.taskId,
    };
    current[existingIndex] = targetEntry;
  } else {
    targetEntry = {
      id: draft.id || `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: draft.timestamp || Date.now(),
      content,
      usageCount: draft.usageCount || 1,
      taskId: draft.taskId,
    };
    current.push(targetEntry);
  }

  persistGlobalUserPrompts(current);

  // 异步追加落盘，不阻断前端渲染
  appendPromptToLogFile(targetEntry).catch((err) => {
    console.warn("[userPromptHistory] 落盘总账本失败（可能是 Web 环境或文件权限问题）:", err);
  });

  return targetEntry;
}

/** 追加写入本地 Markdown 文件 */
export async function appendPromptToLogFile(entry: UserPromptEntry): Promise<void> {
  const filePath = resolveGlobalPromptsLogPath();
  const mdSnippet = formatPromptAsMarkdown(entry);

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("fs_append_file", {
      path: filePath,
      content: mdSnippet,
    });
  } catch (err) {
    console.debug("[userPromptHistory] fs_append_file skipped or failed:", err);
  }
}

/** 删除单条记录 */
export function deleteGlobalUserPrompt(id: string): void {
  const current = readGlobalUserPrompts();
  const filtered = current.filter((item) => item.id !== id);
  persistGlobalUserPrompts(filtered);
}

/** 清空所有历史记录 */
export function clearGlobalUserPrompts(): void {
  persistGlobalUserPrompts([]);
}
