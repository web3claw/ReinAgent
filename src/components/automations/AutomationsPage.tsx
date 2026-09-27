/**
 * AutomationsPage —— 自动化定时任务主页面（对齐 ZCode AutomationsSection 一期范围：
 * header + 创建入口 + 状态筛选 + 卡片网格 + 启用开关/立即运行/删除；编辑页由
 * AutomationEditView 承载）。样式对齐 ZCode 卡片网格语义，颜色/字号走本项目语义变量。
 */

import { useEffect, useState } from "react";
import { ChevronLeft, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useTranslation } from "../../i18n";
import { useAutomationStore } from "../../lib/automations/store";
import { describeRule } from "../../lib/automations/types";
import type { Automation, AutomationDuePayload, AutomationUpsert } from "../../lib/automations/types";
import { AutomationEditView } from "./AutomationEditView";
import type { ProviderItem } from "../settings/model-provider/types";

export interface AutomationsPageProps {
  onBack: () => void;
  /** 派发一次运行（立即运行按钮 → App 的 dispatcher） */
  onDispatch: (payload: AutomationDuePayload) => void;
  providers: ProviderItem[];
  defaultProviderId: string;
  defaultModelId: string;
  /** 当前工作区（selectedProject；空 = 默认工作区） */
  workspacePath?: string;
}

type StatusFilter = "all" | "active" | "paused" | "failed";

/** 时间显示格式（用户定档 2026-09-27）：2026-09-27, 19:05（24 小时制，本地时区） */
export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${date}, ${time}`;
}

export function AutomationsPage(props: AutomationsPageProps) {
  const { onBack, onDispatch, providers, defaultProviderId, defaultModelId, workspacePath } = props;
  const { t } = useTranslation();
  const { automations, loading, error, refresh, setEnabled, remove, runNow } =
    useAutomationStore();
  const [filter, setFilter] = useState<StatusFilter>("all");
  /** null = 列表；"create" = 新建；Automation = 编辑 */
  const [editing, setEditing] = useState<
    { mode: "create" } | { mode: "edit"; automation: Automation } | null
  >(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
    // 页面挂载期间每 30s 静默刷新：调度派发/立即运行会推进 runCount 与 nextRunAt，
    // 保证列表实时反映最新状态（对齐 ZCode 运行数据的定时回读）。
    const timer = window.setInterval(() => {
      void refresh(true);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const handleRunNow = async (automation: Automation) => {
    setRunningId(automation.automationId);
    try {
      const payload = await runNow(automation.automationId);
      onDispatch(payload);
    } catch (err) {
      console.error("[automations] run now failed:", err);
    } finally {
      setRunningId(null);
    }
  };

  const handleSave = async (upsert: AutomationUpsert) => {
    if (editing?.mode === "edit") {
      await useAutomationStore.getState().update(editing.automation.automationId, upsert);
    } else {
      await useAutomationStore.getState().create(upsert);
    }
    setEditing(null);
  };

  const filters: { key: StatusFilter; label: string }[] = [
    { key: "all", label: t("automationsFilterAll") },
    { key: "active", label: t("automationsFilterActive") },
    { key: "paused", label: t("automationsFilterPaused") },
    { key: "failed", label: t("automationsFilterFailed") },
  ];

  const filtered = automations.filter((a) => {
    if (filter === "all") return true;
    if (filter === "active") return a.enabled && a.lifecycleStatus === "active";
    if (filter === "paused") return !a.enabled || a.lifecycleStatus === "paused";
    if (filter === "failed") return a.lastError != null;
    return true;
  });

  // ---- 编辑视图（创建/编辑共用）----
  if (editing) {
    return (
      <AutomationEditView
        automation={editing.mode === "edit" ? editing.automation : null}
        providers={providers}
        defaultProviderId={defaultProviderId}
        defaultModelId={defaultModelId}
        workspacePath={workspacePath}
        onCancel={() => setEditing(null)}
        onSaved={handleSave}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden text-[var(--text)]">
      {/* Header（对齐 ZCode 页头：面包屑返回 + 标题 + 副标题 + 右侧动作） */}
      <div className="flex-shrink-0 border-b border-[var(--border)] px-6 pb-4 pt-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onBack}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-ui-sm text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] cursor-pointer"
              title={t("automationsBack")}
            >
              <ChevronLeft className="h-4 w-4" />
              <span>{t("automationsBack")}</span>
            </button>
            <h1 className="text-ui-lg font-semibold text-[var(--text)]">{t("automationsTitle")}</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] cursor-pointer"
              title={t("automationsRefresh")}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </button>
            <button
              type="button"
              onClick={() => setEditing({ mode: "create" })}
              className="flex items-center gap-1.5 rounded-full bg-[var(--brand)] px-4 py-1.5 text-ui-sm font-medium text-white transition-colors hover:bg-[var(--accent)] cursor-pointer"
            >
              <Plus className="h-4 w-4" />
              <span>{t("automationsCreate")}</span>
            </button>
          </div>
        </div>
        <p className="mt-1 text-ui-xs text-[var(--text-dim)]">{t("automationsSubtitle")}</p>

        {/* 状态筛选 pills（对齐 ZCode statusFilter） */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {filters.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={`rounded-full px-3 py-0.5 text-ui-xs font-medium transition-colors cursor-pointer ${
                filter === f.key
                  ? "bg-[var(--surface-hover)] text-[var(--text)]"
                  : "text-[var(--text-dim)] hover:bg-[var(--surface-hover)]"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* 列表区 */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {error ? (
          <div className="rounded-lg border border-[var(--warn-border)] bg-[var(--warn-bg)] px-3 py-2 text-ui-xs text-[var(--warn-text)]">
            {error}
          </div>
        ) : null}

        {filtered.length === 0 ? (
          <div className="flex h-[226px] w-full flex-col items-center justify-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] px-4">
            <p className="text-ui-sm font-medium text-[var(--text)]">{t("automationsEmptyTitle")}</p>
            <p className="text-ui-xs text-[var(--text-dim)]">{t("automationsEmptyDesc")}</p>
            <button
              type="button"
              onClick={() => setEditing({ mode: "create" })}
              className="flex items-center gap-1.5 rounded-full bg-[var(--brand)] px-4 py-1.5 text-ui-sm font-medium text-white transition-colors hover:bg-[var(--accent)] cursor-pointer"
            >
              <Plus className="h-4 w-4" />
              <span>{t("automationsCreate")}</span>
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-x-4 gap-y-4 lg:grid-cols-2">
            {filtered.map((a) => (
              <AutomationCard
                key={a.automationId}
                automation={a}
                running={runningId === a.automationId}
                confirmDelete={confirmDeleteId === a.automationId}
                onOpen={() => setEditing({ mode: "edit", automation: a })}
                onToggle={(enabled) => void setEnabled(a.automationId, enabled)}
                onRunNow={() => void handleRunNow(a)}
                onDelete={() => remove(a.automationId)}
                onDeleteConfirmStart={() => setConfirmDeleteId(a.automationId)}
                onDeleteCancel={() => setConfirmDeleteId(null)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 单卡（对齐 ZCode 自动化卡片：标题 + 提示词两行 + 底部徽标行 + 开关/运行/删除）
// ---------------------------------------------------------------------------

function AutomationCard(props: {
  automation: Automation;
  running: boolean;
  confirmDelete: boolean;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
  onDelete: () => void;
  onDeleteConfirmStart: () => void;
  onDeleteCancel: () => void;
}) {
  const { t } = useTranslation();
  const { automation: a, running } = props;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={props.onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") props.onOpen();
      }}
      className={`group relative flex h-full min-h-0 cursor-pointer flex-col gap-2 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3 text-left transition-colors hover:bg-[var(--surface-hover)] ${
        a.enabled ? "" : "opacity-60"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 truncate text-ui-sm font-medium text-[var(--text)]">
          {a.title}
        </span>
        <div className="flex flex-shrink-0 items-center gap-1">
          {/* 立即运行（hover 显现） */}
          <button
            type="button"
            disabled={running}
            title={t("automationsRunNow")}
            onClick={(e) => {
              e.stopPropagation();
              props.onRunNow();
            }}
            className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-dim)] opacity-0 transition-opacity hover:bg-[var(--surface-hover)] hover:text-[var(--text)] md:opacity-0 md:group-hover:opacity-100 cursor-pointer disabled:cursor-wait disabled:opacity-40"
          >
            <Play className="h-3.5 w-3.5" />
          </button>
          {/* 删除（行内二次确认，对齐侧边栏删除交互） */}
          {props.confirmDelete ? (
            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                onClick={props.onDelete}
                className="rounded-md border border-[var(--danger)] px-2 py-0.5 text-xs text-[var(--danger)] hover:bg-[var(--danger)]/10 cursor-pointer"
              >
                {t("automationsDeleteConfirm")}
              </button>
              <button
                type="button"
                onClick={props.onDeleteCancel}
                className="rounded-md px-1.5 py-0.5 text-xs text-[var(--text-dim)] hover:bg-[var(--surface-hover)] cursor-pointer"
              >
                ✕
              </button>
            </div>
          ) : (
            <button
              type="button"
              title={t("automationsDelete")}
              onClick={(e) => {
                e.stopPropagation();
                props.onDeleteConfirmStart();
              }}
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-dim)] opacity-0 transition-opacity hover:bg-[var(--surface-hover)] hover:text-[var(--danger)] md:group-hover:opacity-100 cursor-pointer"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
          {/* 启用开关（对齐 ZCode AutomationSwitchToggle） */}
          <button
            type="button"
            role="switch"
            aria-checked={a.enabled}
            title={a.enabled ? t("automationsPause") : t("automationsResume")}
            onClick={(e) => {
              e.stopPropagation();
              props.onToggle(!a.enabled);
            }}
            className={`relative h-4 w-8 flex-shrink-0 rounded-full transition-colors cursor-pointer ${
              a.enabled ? "bg-[var(--brand)]" : "bg-[var(--border)]"
            }`}
          >
            <span
              className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all ${
                a.enabled ? "left-[18px]" : "left-0.5"
              }`}
            />
          </button>
        </div>
      </div>

      <p className="line-clamp-2 h-10 text-ui-xs leading-5 text-[var(--text-dim)]">{a.prompt}</p>

      <div className="mt-auto flex h-6 items-center gap-2">
        <span className="rounded-md bg-[var(--brand-dim)] px-1.5 py-0.5 text-xs text-[var(--brand)]">
          {describeRule(a.scheduleRule)}
        </span>
        <span className="rounded-md bg-[var(--surface)] px-1.5 py-0.5 text-xs text-[var(--text-dim)]">
          {t("automationsRunCount").replace("{count}", String(a.runCount))}
        </span>
        {a.nextRunAt && a.enabled ? (
          <span className="min-w-0 truncate text-xs text-[var(--text-dim)]">
            {t("automationsNextRun").replace("{when}", formatDateTime(a.nextRunAt))}
          </span>
        ) : null}
        {!a.enabled ? (
          <span className="text-xs text-[var(--text-dim)]">{t("automationsPausedLabel")}</span>
        ) : null}
        {a.lastError ? (
          <span
            className="min-w-0 truncate text-xs text-[var(--danger)]"
            title={a.lastError}
          >
            {t("automationsStatusFailed")}
          </span>
        ) : null}
      </div>
    </div>
  );
}
