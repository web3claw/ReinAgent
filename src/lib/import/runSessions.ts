/**
 * 会话导入落库：ImportedSession → 本方任务（task 表）+ 完整消息历史（message/part 表）。
 *
 * - 幂等：任务 id = import-<source>-<externalId>，已存在即 skipped（不重读文件）。
 * - 写入走 conversation_sync（整任务 DELETE+INSERT 事务），序列化复用
 *   conversationPool.serializeEntry，格式与正常聊天完全一致 → UI 激活任务时
 *   自动水合，历史搜索（chat_history_search）直接可搜。
 * - 消息 id 用 m0..mN 连续格式（restoreState 的 nextMessageSeq 依赖此约定）。
 * - 不写 api_message part：外部格式没有我们的 API 原件；用量统计对这些任务
 *   如实显示为无（No-Fallback）。
 * - 不绑定 providerId/modelId：外部工具的模型命名空间与本项目不通，绑定会在
 *   发送时解析失败；导入任务沿用当前会话默认模型。
 */

import { invoke } from "@tauri-apps/api/core";
import { getTaskListCached } from "../storage/db";
import { serializeEntry } from "../chat/conversationPool";
import type { TimelineEntry } from "../chat/conversationModel";
import type { AppTask } from "../../store/useAppStore";
import { useAppStore } from "../../store/useAppStore";
import { convertSession } from "./scan";
import { importedSessionId, toMs, type ExternalSessionSummary, type ImportedSession, type ImportedUiMessage } from "./types";

export interface SessionImportRunResult {
  imported: number;
  skipped: number;
  failed: number;
}

function appTaskFromSession(session: ImportedSession): AppTask {
  return {
    id: session.session.id,
    title: session.session.title || "Imported session",
    createdAt: toMs(session.session.createdAt),
    updatedAt: toMs(session.session.updatedAt, toMs(session.session.createdAt)),
    project: session.session.projectPath ?? null,
  };
}

function entryFromImported(msg: ImportedUiMessage, index: number): TimelineEntry {
  const startedAt = toMs(msg.createdAt);
  const base = {
    id: `m${index}`,
    text: "",
    thinking: "",
    startedAt,
    endedAt: startedAt,
  };
  if (msg.role === "tool") {
    return {
      ...base,
      role: "tool",
      status: msg.isError ? "error" : "done",
      toolCallId: msg.toolCallId || `import-${index}`,
      toolName: msg.toolName || "tool",
      args: msg.toolArgs ?? null,
      resultText: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""),
      isError: msg.isError === true,
    };
  }
  return {
    ...base,
    role: msg.role === "user" ? "user" : "assistant",
    text: typeof msg.content === "string" ? msg.content : "",
    status: "done",
  };
}

/** 时间线条目 → message/part 两表行（与正常聊天同一序列化格式）。 */
function messageRowsFromImported(session: ImportedSession) {
  return session.messages.map((msg, i) => serializeEntry(entryFromImported(msg, i), i));
}

/** 导入所选会话（已存在的自动 skipped）。 */
export async function runSessionImport(summaries: ExternalSessionSummary[]): Promise<SessionImportRunResult> {
  const existing = new Set(getTaskListCached().map((r) => r.id));
  const newTasks: AppTask[] = [];
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const summary of summaries) {
    const id = importedSessionId(summary.source, summary.externalId);
    if (existing.has(id)) {
      skipped += 1;
      continue;
    }
    try {
      const session = await convertSession(summary);
      // 空会话（过滤合成行后无任何消息）不落库
      if (session.messages.length === 0) {
        skipped += 1;
        continue;
      }
      const messages = await messageRowsFromImported(session);
      await invoke("conversation_sync", { taskId: id, messages });
      newTasks.push(appTaskFromSession(session));
      existing.add(id);
      imported += 1;
    } catch (err) {
      console.error("[import] session import failed:", summary.source, summary.externalId, err);
      failed += 1;
    }
  }

  if (newTasks.length > 0) {
    // 按更新时间新→旧排，插入任务列表尾部（正常任务仍在前）
    newTasks.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    useAppStore.getState().registerExternalTasks(newTasks);
  }
  return { imported, skipped, failed };
}
