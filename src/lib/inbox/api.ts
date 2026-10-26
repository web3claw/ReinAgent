/**
 * 应用内通知收件箱 API（v2 尾巴 ⑤，Hetu InboxService 精简版）：
 * 看板 blocked/failed 与自动化派发失败经 pushNotification 落库聚合
 * （同键正文刷新/计数+1/回未读）；铃铛面板经事件+调用刷新。
 */

import { invoke } from "@tauri-apps/api/core";

export interface NotificationRow {
  categoryKey: string;
  kind: string;
  title: string;
  body: string;
  linkView: string | null;
  linkTaskId: string | null;
  count: number;
  unread: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 收件箱变更事件（同窗口推送后广播，铃铛监听刷新） */
export const INBOX_CHANGE_EVENT = "reinagent-inbox-change";

export function emitInboxChange(): void {
  window.dispatchEvent(new CustomEvent(INBOX_CHANGE_EVENT));
}

export interface NotifyPushInput {
  categoryKey: string;
  kind: string;
  title: string;
  body?: string;
  linkView?: string | null;
  linkTaskId?: string | null;
}

/** push 失败只警告不阻塞主链路（通知是锦上添花，不倒置优先级） */
export async function pushNotification(input: NotifyPushInput): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  try {
    await invoke("notify_push", { args: input });
    emitInboxChange();
  } catch (err) {
    console.warn("[inbox] push failed:", err);
  }
}

export async function listNotifications(limit = 50): Promise<NotificationRow[]> {
  return invoke<NotificationRow[]>("notify_list", { limit });
}

export async function archiveNotification(categoryKey: string): Promise<void> {
  await invoke("notify_archive", { categoryKey });
  emitInboxChange();
}

export async function archiveAllNotifications(): Promise<void> {
  await invoke("notify_archive_all");
  emitInboxChange();
}
