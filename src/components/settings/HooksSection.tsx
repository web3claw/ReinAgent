/**
 * HooksSection —— 工作区 Hooks 管理页。
 * LiveAgent 移植：crates/agent-ui/src/pages/settings/HooksSection.tsx（1:1 样式与功能）。
 * 差异（用户定稿 2026-10-01）：
 * - 左侧导航在「生命周期」8 事件外追加「兼容事件」分组（ZCode 契约事件，旧配置可见可编辑）；
 * - 无信任横幅、无单条测试按钮（完全 1:1）；信任门禁仍在运行时与聊天区横幅生效。
 * 数据：活动工作区 `.ReinAgent/config.json` 的 hooks 数组（saveWorkspaceHooks 保留其它顶层键）。
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, SquarePen, Trash2 } from "lucide-react";
import { useTranslation } from "../../i18n";
import {
  CLASSIC_HOOK_EVENTS,
  discoverWorkspaceHooks,
  LIFECYCLE_HOOK_EVENTS,
  saveWorkspaceHooks,
  type HookConfigEntry,
} from "../../lib/hooks/hooksRuntime";
import { cn } from "../lw/lib/utils";
import { AgentActivationSwitch } from "../lw/settings/AgentActivationSwitch";
import { SettingsNotice } from "../lw/settings/SettingsNotice";
import { Button } from "../lw/ui/button";
import { ConfirmActionPopover } from "../lw/ui/confirm-action-popover";
import { HookModal } from "./HookModal";

/** 生命周期事件顺序（LA 同序）。 */
const EVENT_FLOW: string[] = [...LIFECYCLE_HOOK_EVENTS];
/** 兼容事件分组（ZCode 契约，运行时全支持）。 */
const LEGACY_FLOW: string[] = [...CLASSIC_HOOK_EVENTS];

const EVENT_LABEL_KEYS: Record<string, string> = {
  agent_start: "hooksEventAgentStart",
  turn_start: "hooksEventTurnStart",
  message_start: "hooksEventMessageStart",
  message_end: "hooksEventMessageEnd",
  tool_execution_start: "hooksEventToolExecutionStart",
  tool_execution_end: "hooksEventToolExecutionEnd",
  turn_end: "hooksEventTurnEnd",
  agent_end: "hooksEventAgentEnd",
  PreToolUse: "hooksEventPreToolUse",
  UserPromptSubmit: "hooksEventUserPromptSubmit",
  PostToolUse: "hooksEventPostToolUse",
  PermissionRequest: "hooksEventPermissionRequest",
  SessionStart: "hooksEventSessionStart",
  Stop: "hooksEventStop",
};

const EVENT_DESC_KEYS: Record<string, string> = Object.fromEntries(
  Object.entries(EVENT_LABEL_KEYS).map(([event, key]) => [event, `${key}Desc`]),
);

/** 旧条目无 name：用脚本首行 / 首个请求 URL 派生展示名（如实反映配置内容）。 */
function hookDisplayName(hook: HookConfigEntry, untitledLabel: string): string {
  if (hook.name) return hook.name;
  if (hook.command) return hook.command.split(/\r?\n/)[0].trim().slice(0, 60);
  const first = hook.requests?.[0];
  if (first) return `${first.method} ${first.url}`.trim().slice(0, 60);
  return untitledLabel;
}

export function HooksSection({ workspaceRoot }: { workspaceRoot?: string }) {
  const { t } = useTranslation();
  // 动态事件 i18n 键（EVENT_LABEL_KEYS 查表）需要 string 签名
  const tf = t as unknown as (key: string) => string;
  const [activeEvent, setActiveEvent] = useState<string>(EVENT_FLOW[0]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingHook, setEditingHook] = useState<HookConfigEntry | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [hooks, setHooks] = useState<HookConfigEntry[] | null>(null);

  const discover = useCallback(async () => {
    if (!workspaceRoot) {
      setHooks([]);
      return;
    }
    try {
      const discovered = await discoverWorkspaceHooks(workspaceRoot);
      setHooks(discovered?.entries ?? []);
    } catch (err) {
      setHooks([]);
      setActionError(String(err).slice(0, 200));
    }
  }, [workspaceRoot]);

  useEffect(() => {
    setHooks(null);
    setActiveEvent(EVENT_FLOW[0]);
    void discover();
  }, [discover]);

  if (!workspaceRoot) {
    return <p className="text-xs text-[var(--text-dim)]">{t("hooksNoWorkspace")}</p>;
  }
  if (hooks === null) {
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--text-dim)]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("hooksLoading")}
      </div>
    );
  }

  // 早退后 hooks 收窄为非空数组；以下闭包都在收窄之后声明
  const list = hooks;

  const persist = async (next: HookConfigEntry[]) => {
    setActionError(null);
    setHooks(next);
    try {
      await saveWorkspaceHooks(workspaceRoot, next);
    } catch (err) {
      setActionError(String(err).slice(0, 220));
    }
    await discover();
  };

  const handleSave = async (data: HookConfigEntry) => {
    if (editingHook) {
      await persist(list.map((hook) => (hook === editingHook ? data : hook)));
    } else {
      await persist([...list, data]);
    }
  };

  const toggleHook = (hook: HookConfigEntry) => {
    void persist(list.map((item) => (item === hook ? { ...item, enabled: hook.enabled === false } : item)));
  };

  const deleteHook = (hook: HookConfigEntry) => {
    void persist(list.filter((item) => item !== hook));
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditingHook(null);
  };

  const openAdd = () => {
    setEditingHook(null);
    setModalOpen(true);
  };

  const openEdit = (hook: HookConfigEntry) => {
    setEditingHook(hook);
    setActiveEvent(hook.event);
    setModalOpen(true);
  };

  const activeHooks = list.filter((hook) => hook.event === activeEvent);
  const enabledCount = list.filter((hook) => hook.enabled !== false).length;

  const renderEventButton = (event: string) => {
    const count = list.filter((hook) => hook.event === event).length;
    return (
      <button
        key={event}
        type="button"
        aria-pressed={activeEvent === event}
        onClick={() => setActiveEvent(event)}
        className={cn(
          "flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2",
          "text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          activeEvent === event
            ? "bg-settings-active font-medium text-foreground"
            : "text-muted-foreground hover:bg-settings-tile-hover hover:text-foreground",
        )}
      >
        {tf(EVENT_LABEL_KEYS[event])}
        {count > 0 ? <span className="text-xs tabular-nums">{count}</span> : null}
      </button>
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t("hooksDesc")}</p>
        <span className="text-xs text-muted-foreground">
          {t("hooksActiveHooks")} {enabledCount} / {hooks.length}
        </span>
      </div>
      {actionError ? (
        <SettingsNotice variant="action-error">{actionError}</SettingsNotice>
      ) : null}
      <div className="grid items-start gap-6 md:grid-cols-[13rem_minmax(0,1fr)]">
        <nav
          aria-label={t("hooksLifecycle")}
          className="space-y-1 rounded-xl bg-settings-tile p-2"
        >
          <p className="px-3 py-2 text-xs font-medium text-muted-foreground">
            {t("hooksLifecycle")}
          </p>
          {EVENT_FLOW.map(renderEventButton)}
          <p className="px-3 pt-3 pb-2 text-xs font-medium text-muted-foreground">
            {t("hooksLegacy")}
          </p>
          {LEGACY_FLOW.map(renderEventButton)}
        </nav>
        <section className="min-w-0 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">{tf(EVENT_LABEL_KEYS[activeEvent])}</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {tf(EVENT_DESC_KEYS[activeEvent] ?? "")}
              </p>
            </div>
            <Button size="sm" onClick={openAdd}>
              <Plus className="size-3.5" />
              {t("hooksAdd")}
            </Button>
          </div>
          {activeHooks.length === 0 ? (
            <div className="rounded-xl bg-settings-tile px-4 py-6">
              <p className="text-sm font-medium">{t("hooksEmptyTitle")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("hooksEmptyDesc")}</p>
            </div>
          ) : (
            activeHooks.map((hook) => (
              <div
                key={hook.id ?? `${hook.event}:${hook.command ?? hook.requests?.[0]?.url ?? ""}`}
                className="flex flex-wrap items-center gap-3 rounded-xl bg-settings-tile p-4"
              >
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => openEdit(hook)}
                    className="max-w-full cursor-pointer truncate text-left text-sm font-medium hover:underline"
                  >
                    {hookDisplayName(hook, t("hooksUntitled"))}
                  </button>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {hook.type === "http" ? t("hooksTypeHttp") : t("hooksTypeCommand")}
                    {hook.description ? ` · ${hook.description}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <AgentActivationSwitch
                    checked={hook.enabled !== false}
                    title={(hook.enabled !== false ? t("hooksDisable") : t("hooksEnable"))}
                    onToggle={() => toggleHook(hook)}
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("edit")}
                    onClick={() => openEdit(hook)}
                  >
                    <SquarePen className="size-3.5" />
                  </Button>
                  <ConfirmActionPopover
                    title={t("hooksDelete")}
                    description={hookDisplayName(hook, t("hooksUntitled"))}
                    confirmLabel={t("confirm")}
                    cancelLabel={t("cancel")}
                    onConfirm={() => deleteHook(hook)}
                  >
                    {(open) => (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("hooksDelete")}
                        onClick={open}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
                  </ConfirmActionPopover>
                </div>
              </div>
            ))
          )}
        </section>
      </div>
      {modalOpen ? (
        <HookModal
          event={editingHook?.event ?? activeEvent}
          initialData={editingHook ?? undefined}
          onSave={handleSave}
          onClose={closeModal}
        />
      ) : null}
    </div>
  );
}
