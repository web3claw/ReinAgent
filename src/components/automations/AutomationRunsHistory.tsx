/**
 * AutomationRunsHistory —— 自动化运行历史（P2-G2 尾巴）。
 *
 * 数据：Rust `automation_list_runs`（每自动化各拉最近 N 条后合并按时间倒序）。
 * 行：状态点 + 自动化标题 + trigger + 时间 + 错误预览；「打开会话」跳转 run 的
 * task（有 task_id 时）。刷新按钮手动重拉。
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "../../i18n";
import { formatDateTime } from "./AutomationsPage";
import type { Automation, AutomationRun } from "../../lib/automations/types";

interface HistoryRow extends AutomationRun {
  automationTitle: string;
}

const STATUS_LABEL: Record<AutomationRun["status"], string> = {
  running: "运行中",
  succeeded: "成功",
  failed: "失败",
  stopped: "已停止",
};

function StatusDot({ status }: { status: AutomationRun["status"] }) {
  const cls =
    status === "running"
      ? "bg-[var(--status-run)] animate-pulse"
      : status === "succeeded"
        ? "bg-[var(--status-ok)]"
        : status === "stopped"
          ? "bg-[var(--text-dim)]"
          : "bg-[var(--danger)]";
  return <span className={`size-2 flex-shrink-0 rounded-full ${cls}`} />;
}

export function AutomationRunsHistory({
  automations,
  onBack,
  onOpenTask,
}: {
  automations: Automation[];
  onBack: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const lists = await Promise.all(
        automations.map(async (a) => {
          try {
            const runs = await invoke<AutomationRun[]>("automation_list_runs", {
              automationId: a.automationId,
              limit: 50,
            });
            return runs.map((r) => ({ ...r, automationTitle: a.title }));
          } catch {
            return [] as HistoryRow[];
          }
        }),
      );
      const merged = lists
        .flat()
        .sort((x, y) => y.createdAt - x.createdAt)
        .slice(0, 100);
      setRows(merged);
    } catch (err) {
      setError(String(err));
    }
  }, [automations]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden text-[var(--text)]">
      <div className="flex-shrink-0 border-b border-[var(--border)] px-6 pb-4 pt-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onBack}
              aria-label={t("automationsBackToList")}
              className="rounded p-1.5 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <h1 className="text-ui-lg font-semibold">{t("automationsHistoryTitle")}</h1>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            aria-label={t("automationsHistoryRefresh")}
            className="rounded p-1.5 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error ? <p className="text-xs text-[var(--danger)]">{error}</p> : null}
        {rows === null ? (
          <div className="flex items-center gap-2 text-xs text-[var(--text-dim)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("automationsHistoryLoading")}
          </div>
        ) : rows.length === 0 ? (
          <p className="text-xs text-[var(--text-dim)]">{t("automationsHistoryEmpty")}</p>
        ) : (
          <div className="space-y-1.5">
            {rows.map((row) => (
              <div
                key={row.runId}
                className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-2.5"
              >
                <StatusDot status={row.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm text-[var(--text)]">{row.automationTitle}</span>
                    <span className="flex-shrink-0 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--text-dim)]">
                      {row.trigger === "manual" ? t("automationsTriggerManual") : t("automationsTriggerSchedule")}
                    </span>
                    <span className="flex-shrink-0 text-[10px] text-[var(--text-dim)]">
                      {STATUS_LABEL[row.status]}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--text-dim)]">
                    <span>{formatDateTime(row.createdAt)}</span>
                    {row.error ? (
                      <span className="min-w-0 truncate text-[var(--danger)]">{row.error}</span>
                    ) : null}
                  </div>
                </div>
                {row.taskId ? (
                  <button
                    type="button"
                    onClick={() => onOpenTask(row.taskId as string)}
                    aria-label={t("automationsHistoryOpenTask")}
                    title={t("automationsHistoryOpenTask")}
                    className="flex-shrink-0 rounded p-1.5 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
