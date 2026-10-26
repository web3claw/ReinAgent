/**
 * InboxBell —— 侧栏底栏通知铃铛（v2 尾巴 ⑤，Hetu 收件箱聚合精简版）：
 * 未读徽标 + 弹出面板（聚合条目 ×N 计数、点击跳转看板/自动化、单条归档、全部清空）。
 * 数据经 notify_list；push 侧经 window 事件 reinagent-inbox-change 即时刷新。
 */

import { Bell, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../../i18n";
import {
  archiveAllNotifications,
  archiveNotification,
  emitInboxChange,
  INBOX_CHANGE_EVENT,
  listNotifications,
  type NotificationRow,
} from "../../lib/inbox/api";

export function InboxBell() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRows(await listNotifications(50));
    } catch {
      /* 浏览器模式/读取失败静默（铃铛是辅助通道） */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener(INBOX_CHANGE_EVENT, onChange);
    window.addEventListener("focus", onChange);
    return () => {
      window.removeEventListener(INBOX_CHANGE_EVENT, onChange);
      window.removeEventListener("focus", onChange);
    };
  }, [refresh]);

  // 外点关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const unread = rows.length;
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (!isTauri) return null;

  const openItem = async (row: NotificationRow) => {
    setOpen(false);
    const { useAppStore } = await import("../../store/useAppStore");
    const store = useAppStore.getState();
    if (row.linkTaskId && row.kind === "kanban") {
      store.setCurrentView("kanban");
    } else if (row.linkView === "automations") {
      store.setCurrentView("automations");
    }
    // 跳转后即归档（已处理）
    if (row.unread) {
      await archiveNotification(row.categoryKey).catch(() => {});
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t("inboxTitle")}
        title={t("inboxTitle")}
        className="relative rounded p-2 text-[var(--sidebar-text-dim,currentColor)] opacity-70 transition-opacity hover:opacity-100"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--diff-removed)] px-1 text-[9px] font-semibold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute bottom-full left-0 z-50 mb-2 w-80 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] shadow-xl">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
            <span className="text-xs font-semibold text-[var(--text)]">{t("inboxTitle")}</span>
            {rows.length > 0 ? (
              <button
                type="button"
                onClick={() => void archiveAllNotifications().then(emitInboxChange).then(refresh)}
                className="text-[10px] text-[var(--text-dim)] hover:text-[var(--text)]"
              >
                {t("inboxClearAll")}
              </button>
            ) : null}
          </div>
          <div className="max-h-80 overflow-y-auto">
            {rows.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-[var(--text-dim)]">{t("inboxEmpty")}</p>
            ) : (
              rows.map((row) => (
                <div key={row.categoryKey} className="group flex items-start gap-2 border-b border-[var(--border)] px-3 py-2 last:border-b-0 hover:bg-[var(--surface-hover)]">
                  <button type="button" onClick={() => void openItem(row)} className="min-w-0 flex-1 text-left">
                    <div className="flex items-center gap-1.5">
                      {row.unread ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--brand)]" /> : null}
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--text)]" title={row.title}>
                        {row.title}
                      </span>
                      {row.count > 1 ? (
                        <span className="shrink-0 rounded-full bg-[var(--surface-hover)] px-1.5 text-[9px] text-[var(--text-dim)]">×{row.count}</span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-[11px] text-[var(--text-dim)]">{row.body}</div>
                    <div className="mt-0.5 text-[9px] text-[var(--text-dim)]">
                      {new Date(row.updatedAt).toLocaleString()}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => void archiveNotification(row.categoryKey)}
                    aria-label={t("inboxArchive")}
                    className="rounded p-0.5 text-[var(--text-dim)] opacity-0 transition-opacity hover:text-[var(--text)] group-hover:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
