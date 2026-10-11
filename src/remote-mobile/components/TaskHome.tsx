/**
 * TaskHome —— ZCode WebRemoteControlMobileTaskHome.tsx 逐字移植适配。
 * 裁剪：TaskWorkflowRunLines（本仓无动态工作流）、远程 SSH 工作区重连按钮；
 * 数据层 switcher → 本仓 WS 客户端。布局/样式/交互与 ZCode 移动端 1:1。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronsUp,
  Clock3,
  FolderOpen,
  LoaderIcon,
  MessageCircleCheck,
  MessageCirclePlus,
  Pin,
  Plus,
  RefreshCw,
  Settings2,
} from "lucide-react";
import type {
  WebRemoteControlTaskDisplayStatus,
  WebRemoteControlTaskTarget,
  WebRemoteControlWorkspaceListResult,
} from "../api/protocol";
import { resolveWebRemoteControlWorkspaceKey } from "../api/protocol";
import type { WebRemoteControlWorkspaceSwitcherApi } from "../api/protocol";
import { cn } from "../lib/cn";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui";
import {
  buildWebRemoteControlTaskRowKey,
  buildWebRemoteControlMobileTaskHomeModel,
  getWebRemoteControlTaskStatusClassName,
  getWorkspaceLatestUpdatedAt,
  type WebRemoteControlMobileTaskHomePreferences,
} from "../lib/taskHomeModel";
import { useWebRemoteControlTaskOpen } from "../lib/useTaskOpen";
import { formatTaskRelativeTime } from "../lib/relativeTime";
import { getTaskTimelineGroupMessage, groupTaskTimelineItems } from "../lib/timelineGroups";
import { RemoteThemeMenu, type RemoteTheme } from "./ThemeMenu";
import type { LocalePreference } from "../i18n";
import { useRemoteIntl, useRemoteT } from "../i18n";

export { buildWebRemoteControlMobileTaskHomeModel } from "../lib/taskHomeModel";
export {
  persistWebRemoteControlMobileTaskHomePreferences,
  readWebRemoteControlMobileTaskHomePreferences,
  type WebRemoteControlMobileTaskHomePreferences,
} from "../lib/taskHomeModel";

function getStatusIcon(status: WebRemoteControlTaskDisplayStatus) {
  if (status === "running") {
    return <LoaderIcon className="size-3 animate-spin" />;
  }
  if (status === "completed") {
    return <CheckCircle2 className="size-3" />;
  }
  if (status === "error") {
    return <AlertCircle className="size-3" />;
  }
  return null;
}

function noopSelectTask() {}

export function WebRemoteControlMobileTaskHome({
  activeTaskId,
  activeWorkspaceIdentity,
  activeWorkspacePath,
  initialResult,
  onNavigateHome,
  onNavigateToChat,
  preferences,
  onPreferencesChange,
  onSelectTask = noopSelectTask,
  onStartDraftInWorkspace,
  refreshKey,
  onCrossWorkspaceSwitchingChange,
  switcher,
  theme,
  onThemeChange,
  localePref,
  onLocaleChange,
}: {
  switcher: WebRemoteControlWorkspaceSwitcherApi;
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  initialResult?: WebRemoteControlWorkspaceListResult;
  onSelectTask?: (targetWorkspacePath: string, taskId: string, targetWorkspaceIdentity?: string) => void;
  onStartDraftInWorkspace?: (targetWorkspacePath: string) => void;
  onNavigateHome?: () => void;
  onNavigateToChat?: () => void;
  preferences: WebRemoteControlMobileTaskHomePreferences;
  onPreferencesChange: (preferences: WebRemoteControlMobileTaskHomePreferences) => void;
  refreshKey?: number;
  onCrossWorkspaceSwitchingChange?: (switching: boolean) => void;
  theme: RemoteTheme;
  onThemeChange: (theme: RemoteTheme) => void;
  localePref: LocalePreference;
  onLocaleChange: (pref: LocalePreference) => void;
}) {
  const t = useRemoteT();
  const locale = useRemoteLocale();
  const [result, setResult] = useState<WebRemoteControlWorkspaceListResult>(
    initialResult ?? { workspaces: [], tasks: [] },
  );
  const [loading, setLoading] = useState(!initialResult);
  const [loadError, setLoadError] = useState<string | null>(null);
  const taskOrganizeBy = preferences.organizeBy;
  const taskSortBy = preferences.sortBy;
  const initialExpansionModel = useMemo(
    () =>
      buildWebRemoteControlMobileTaskHomeModel({
        activeTaskId,
        activeWorkspaceIdentity,
        activeWorkspacePath,
        sortBy: taskSortBy,
        result: initialResult ?? { workspaces: [], tasks: [] },
      }),
    [activeTaskId, activeWorkspaceIdentity, activeWorkspacePath, initialResult, taskSortBy],
  );
  const [expandedWorkspaceKeys, setExpandedWorkspaceKeys] = useState<Set<string>>(
    () => new Set(initialExpansionModel.defaultExpandedWorkspaceKeys),
  );
  const didInitializeLoadedExpansionRef = useRef(Boolean(initialResult));
  const model = useMemo(
    () =>
      buildWebRemoteControlMobileTaskHomeModel({
        activeTaskId,
        activeWorkspaceIdentity,
        activeWorkspacePath,
        sortBy: taskSortBy,
        result,
      }),
    [activeTaskId, activeWorkspaceIdentity, activeWorkspacePath, result, taskSortBy],
  );
  const timelineGroups = useMemo(
    () =>
      groupTaskTimelineItems(model.timelineTasks, {
        sortBy: taskSortBy,
        now: Date.now(),
        locale,
      }),
    [locale, model.timelineTasks, taskSortBy],
  );
  const {
    error: taskOpenError,
    openTask,
    switchingTaskKey,
  } = useWebRemoteControlTaskOpen({
    activeTaskId: model.activeTaskId,
    activeWorkspaceIdentity,
    activeWorkspacePath,
    markTaskReadOnOpen: true,
    onNavigateHome,
    onNavigateToChat,
    onSelectTask,
    onSwitchingChange: onCrossWorkspaceSwitchingChange,
    switcher,
  });
  const error = loadError ?? taskOpenError;

  const loadWorkspaces = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setResult(await switcher.listWorkspaces());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[TaskHome] 加载远控首页失败", { error: message });
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, [switcher]);

  useEffect(() => {
    // 空快照（hello 前挂载 / 桌面水合未完成）不算有效的 initialResult——主动拉一次
    const hasData =
      initialResult && ((initialResult.workspaces?.length ?? 0) > 0 || (initialResult.tasks?.length ?? 0) > 0);
    if (hasData) return;
    void loadWorkspaces();
  }, [initialResult, loadWorkspaces]);

  useEffect(() => {
    if (!refreshKey) return;
    void loadWorkspaces();
  }, [loadWorkspaces, refreshKey]);

  useEffect(() => {
    return switcher.onWorkspaceListUpdated?.((nextResult) => {
      setResult(nextResult);
      setLoadError(null);
      setLoading(false);
    });
  }, [switcher]);

  useEffect(() => {
    if (didInitializeLoadedExpansionRef.current || loading) return;
    didInitializeLoadedExpansionRef.current = true;
    setExpandedWorkspaceKeys(new Set(model.defaultExpandedWorkspaceKeys));
  }, [loading, model.defaultExpandedWorkspaceKeys]);

  const toggleWorkspace = useCallback((workspaceKey: string) => {
    setExpandedWorkspaceKeys((current) => {
      const next = new Set(current);
      if (next.has(workspaceKey)) {
        next.delete(workspaceKey);
      } else {
        next.add(workspaceKey);
      }
      return next;
    });
  }, []);

  const collapseAllWorkspaces = useCallback(() => {
    setExpandedWorkspaceKeys(new Set());
  }, []);

  const handleOpenTask = useCallback(
    (task: WebRemoteControlTaskTarget) => {
      openTask(task);
    },
    [openTask],
  );
  const [creatingWorkspaceKey, setCreatingWorkspaceKey] = useState<string | null>(null);
  const handleStartDraft = useCallback(
    async (workspace: WebRemoteControlWorkspaceListResult["workspaces"][number]) => {
      const workspaceKey = resolveWebRemoteControlWorkspaceKey(workspace);
      const isCrossWorkspace = workspaceKey !== model.activeWorkspaceKey;
      setLoadError(null);
      setCreatingWorkspaceKey(workspaceKey);
      onCrossWorkspaceSwitchingChange?.(true);
      try {
        if (switcher.startDraft) {
          await switcher.startDraft(workspaceKey);
        } else {
          await switcher.switchWorkspace(workspaceKey);
          await switcher.updateMobileViewState?.(workspaceKey);
        }
        if (!isCrossWorkspace) {
          onStartDraftInWorkspace?.(workspace.workspacePath);
          onNavigateToChat?.();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[TaskHome] 手机端新建任务失败", { error: message, workspaceKey });
        setLoadError(message);
      } finally {
        setCreatingWorkspaceKey(null);
        onCrossWorkspaceSwitchingChange?.(false);
      }
    },
    [
      model.activeWorkspaceKey,
      onCrossWorkspaceSwitchingChange,
      onNavigateToChat,
      onStartDraftInWorkspace,
      switcher,
    ],
  );

  return (
    <section className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="shrink-0 border-b border-border bg-header px-4 py-3">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-ui-lg font-medium">
              {t("webRemoteControl.mobileHome.title")}
            </div>
            <div className="mt-1 text-ui-base text-foreground-subtle">
              {t("webRemoteControl.mobileHome.connected")}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <RemoteThemeMenu theme={theme} onThemeChange={onThemeChange} localePref={localePref} onLocaleChange={onLocaleChange} />
          </div>
        </div>
      </header>

      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="rounded-lg border border-card-border bg-card p-3 text-ui-base/relaxed text-foreground-subtle">
          {t("webRemoteControl.mobileHome.notice")}
        </div>

        <div className="mt-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-ui-base font-medium">
              {t("webRemoteControl.mobileHome.sectionTitle")}
            </h1>
            <p className="mt-1 text-ui-base text-foreground-subtle">
              {t("webRemoteControl.mobileHome.summary", {
                taskCount: String(model.totalTaskCount),
                workspaceCount: String(model.totalWorkspaceCount),
              })}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {taskOrganizeBy === "workspace" ? (
              <Button
                size="icon-sm"
                aria-label={t("webRemoteControl.mobileHome.collapseAll")}
                onClick={collapseAllWorkspaces}
              >
                <ChevronsUp className="size-3.5" />
              </Button>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-sm"
                  aria-label={t("webRemoteControl.mobileHome.organize")}
                >
                  <Settings2 className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52 min-w-52">
                <DropdownMenuLabel>{t("webRemoteControl.mobileHome.organize")}</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={taskOrganizeBy}
                  onValueChange={(value) => {
                    if (value === "workspace" || value === "timeline") {
                      onPreferencesChange({ ...preferences, organizeBy: value });
                    }
                  }}
                >
                  <DropdownMenuRadioItem value="workspace">
                    <FolderOpen className="size-4" />
                    {t("webRemoteControl.mobileHome.organizeByWorkspace")}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="timeline">
                    <Clock3 className="size-4" />
                    {t("webRemoteControl.mobileHome.organizeByTimeline")}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t("webRemoteControl.mobileHome.sortBy")}</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={taskSortBy}
                  onValueChange={(value) => {
                    if (value === "created" || value === "updated") {
                      onPreferencesChange({ ...preferences, sortBy: value });
                    }
                  }}
                >
                  <DropdownMenuRadioItem value="created">
                    <MessageCirclePlus className="size-4" />
                    {t("webRemoteControl.mobileHome.sortByCreated")}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="updated">
                    <MessageCircleCheck className="size-4" />
                    {t("webRemoteControl.mobileHome.sortByUpdated")}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="icon-sm"
              aria-label={t("webRemoteControl.mobileHome.refresh")}
              onClick={() => {
                void loadWorkspaces();
              }}
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            </Button>
          </div>
        </div>

        {error ? (
          <div className="mt-3 rounded-lg border border-destructive/40 bg-card px-3 py-2 text-ui-base text-destructive">
            {error}
          </div>
        ) : null}

        {loading && model.totalWorkspaceCount === 0 ? (
          <div className="mt-3 flex items-center gap-2 px-1 py-2 text-ui-base text-foreground-subtle">
            <LoaderIcon className="size-3.5 animate-spin" />
            {t("common.loading")}
          </div>
        ) : null}

        {!loading && !error && model.totalWorkspaceCount === 0 ? (
          <div className="mt-3 px-1 py-2 text-ui-base text-foreground-subtle">
            {t("webRemoteControl.noTasks")}
          </div>
        ) : null}

        {model.pinnedTasks.length > 0 ? (
          <section className="mt-3">
            <h2 className="px-1 py-1 text-ui-base font-medium text-foreground-subtlest">
              {t("taskList.pinnedSection")}
            </h2>
            <ul className="space-y-1">
              {model.pinnedTasks.map((task) => {
                const rowKey = buildWebRemoteControlTaskRowKey(task);
                const taskWorkspaceKey = resolveWebRemoteControlWorkspaceKey(task);
                const selected =
                  taskWorkspaceKey === model.activeWorkspaceKey && task.taskId === model.activeTaskId;
                const switching = switchingTaskKey === rowKey;
                const taskTitle = task.title || t("taskList.untitled");
                const displayStatus = task.displayStatus ?? "idle";

                return (
                  <li key={rowKey}>
                    <button
                      type="button"
                      data-testid={`task-item-${task.taskId}`}
                      data-state={selected ? "selected" : "idle"}
                      className={cn(
                        "flex min-h-12 w-full min-w-0 items-center gap-2 rounded-lg border border-card-border bg-card px-3 py-2 text-left transition-colors disabled:cursor-wait disabled:opacity-70",
                        selected ? "bg-selected text-foreground" : "hover:bg-surface-hover",
                      )}
                      disabled={Boolean(switchingTaskKey)}
                      onClick={() => {
                        handleOpenTask(task);
                      }}
                      aria-label={t("webRemoteControl.openTask", { title: taskTitle })}
                    >
                      <span className="relative flex size-4 shrink-0 items-center justify-center text-foreground-subtle">
                        {switching ? (
                          <LoaderIcon className="size-4 animate-spin" />
                        ) : (
                          <Pin className="size-4" />
                        )}
                        {!switching && task.unreadAt ? (
                          <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-sky-500 dark:bg-sky-400" />
                        ) : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-ui-base text-foreground">{taskTitle}</span>
                        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-ui-base text-foreground-subtle">
                          <span className="truncate">
                            {taskWorkspaceKey === "__conversations__"
                              ? t("workspaceSidebar.conversationsSection")
                              : task.workspaceLabel || task.workspacePath}
                          </span>
                          <span className="shrink-0">·</span>
                          <span className="truncate">
                            {formatTaskRelativeTime(
                              taskSortBy === "created" ? task.createdAt : task.updatedAt,
                              locale,
                            )}
                          </span>
                        </span>
                      </span>
                      <span
                        className={cn(
                          "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-ui-xs leading-none",
                          getWebRemoteControlTaskStatusClassName(displayStatus),
                        )}
                      >
                        {getStatusIcon(displayStatus)}
                        {t(`webRemoteControl.taskStatus.${displayStatus}`)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {taskOrganizeBy === "timeline" ? (
          <ul className="mt-3 space-y-2">
            {model.totalTaskCount === 0 && model.totalWorkspaceCount > 0 ? (
              <li className="px-1 py-2 text-ui-base text-foreground-subtle">
                {t("webRemoteControl.noTasks")}
              </li>
            ) : null}
            {timelineGroups.map((group) => {
              const labelMessage = getTaskTimelineGroupMessage(group.label);

              return (
                <li key={group.key} className="space-y-1">
                  <div className="px-1 py-1 text-ui-base font-medium text-foreground-subtle">
                    {t(labelMessage.id, labelMessage.values)}
                  </div>
                  <ul className="space-y-1">
                    {group.items.map((task) => {
                      const rowKey = buildWebRemoteControlTaskRowKey(task);
                      const taskWorkspaceKey = resolveWebRemoteControlWorkspaceKey(task);
                      const selected =
                        taskWorkspaceKey === model.activeWorkspaceKey &&
                        task.taskId === model.activeTaskId;
                      const switching = switchingTaskKey === rowKey;
                      const taskTitle = task.title || t("taskList.untitled");
                      const displayStatus = task.displayStatus ?? "idle";

                      return (
                        <li key={rowKey}>
                          <button
                            type="button"
                            data-testid={`task-item-${task.taskId}`}
                            data-state={selected ? "selected" : "idle"}
                            className={cn(
                              "flex min-h-14 w-full min-w-0 items-center gap-2 rounded-lg border border-card-border bg-card px-3 py-2 text-left transition-colors disabled:cursor-wait disabled:opacity-70",
                              selected ? "bg-selected text-foreground" : "hover:bg-surface-hover",
                            )}
                            disabled={Boolean(switchingTaskKey)}
                            onClick={() => {
                              handleOpenTask(task);
                            }}
                          >
                            <span className="relative flex size-4 shrink-0 items-center justify-center">
                              {switching ? (
                                <LoaderIcon className="size-4 animate-spin text-foreground-subtle" />
                              ) : task.unreadAt ? (
                                <span className="h-1.5 w-1.5 rounded-full bg-sky-500 dark:bg-sky-400" />
                              ) : null}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-ui-base text-foreground">
                                {taskTitle}
                              </span>
                              <span className="mt-1 flex min-w-0 items-center gap-1.5 text-ui-base text-foreground-subtle">
                                <span className="truncate">
                                  {taskWorkspaceKey === "__conversations__"
                                    ? t("workspaceSidebar.conversationsSection")
                                    : task.workspaceLabel || task.workspacePath}
                                </span>
                                <span className="shrink-0">·</span>
                                <span className="truncate">
                                  {formatTaskRelativeTime(
                                    taskSortBy === "created" ? task.createdAt : task.updatedAt,
                                    locale,
                                  )}
                                </span>
                              </span>
                            </span>
                            <span
                              className={cn(
                                "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-ui-xs leading-none",
                                getWebRemoteControlTaskStatusClassName(displayStatus),
                              )}
                            >
                              {getStatusIcon(displayStatus)}
                              {t(`webRemoteControl.taskStatus.${displayStatus}`)}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        ) : (
          <ul className="mt-3 space-y-2">
            {model.groups.map((group) => {
              const expanded = expandedWorkspaceKeys.has(group.workspaceKey);
              const latestUpdatedAt = getWorkspaceLatestUpdatedAt(group.tasks);

              return (
                <li key={group.workspaceKey} className="rounded-lg border border-card-border bg-card">
                  <div className="flex min-w-0 items-center gap-2 px-3 py-3">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      aria-expanded={expanded}
                      onClick={() => toggleWorkspace(group.workspaceKey)}
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface text-foreground-subtle">
                        {group.workspace.workspacePurpose === "conversation" ? (
                          <MessageCirclePlus className="size-4" />
                        ) : (
                          <FolderOpen className="size-4" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-ui-base font-medium text-foreground">
                            {group.workspace.workspacePurpose === "conversation"
                              ? t("workspaceSidebar.conversationsSection")
                              : group.workspace.label}
                          </span>
                          <span className="shrink-0 rounded-full border border-border bg-surface px-1.5 py-0.5 text-ui-xs leading-none text-foreground-subtle">
                            {t(
                              group.workspace.workspacePurpose === "conversation"
                                ? "webRemoteControl.mobileHome.workspaceKind.conversation"
                                : "webRemoteControl.mobileHome.workspaceKind.local",
                            )}
                          </span>
                        </span>
                        <span className="mt-1 block truncate font-mono text-ui-base text-foreground-subtlest">
                          {group.workspace.workspacePath}
                        </span>
                        {latestUpdatedAt ? (
                          <span className="mt-1 block text-ui-base text-foreground-subtle">
                            {t("webRemoteControl.mobileHome.updatedAt", {
                              time: formatTaskRelativeTime(latestUpdatedAt, locale),
                            })}
                          </span>
                        ) : null}
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-ui-base text-foreground-subtle">
                        {!expanded && group.hasUnread ? (
                          <span
                            aria-hidden="true"
                            data-workspace-unread-indicator="true"
                            className="h-1.5 w-1.5 rounded-full bg-sky-500 dark:bg-sky-400"
                          />
                        ) : null}
                        {t("webRemoteControl.mobileHome.taskCount", { count: String(group.tasks.length) })}
                        {expanded ? (
                          <ChevronDown className="size-4" />
                        ) : (
                          <ChevronRight className="size-4" />
                        )}
                      </span>
                    </button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={Boolean(switchingTaskKey) || Boolean(creatingWorkspaceKey)}
                      onClick={() => {
                        void handleStartDraft(group.workspace);
                      }}
                    >
                      {creatingWorkspaceKey === group.workspaceKey ? (
                        <LoaderIcon className="size-3.5 animate-spin" />
                      ) : (
                        <Plus className="size-3.5" />
                      )}
                    </Button>
                  </div>

                  {expanded ? (
                    <ul className="border-t border-card-border px-2 py-2">
                      {group.tasks.length === 0 ? (
                        <li className="px-2 py-2 text-ui-base text-foreground-subtle">
                          {t("webRemoteControl.mobileHome.workspaceEmpty")}
                        </li>
                      ) : null}
                      {group.tasks.map((task) => {
                        const rowKey = buildWebRemoteControlTaskRowKey(task);
                        const taskWorkspaceKey = resolveWebRemoteControlWorkspaceKey(task);
                        const selected =
                          taskWorkspaceKey === model.activeWorkspaceKey &&
                          task.taskId === model.activeTaskId;
                        const switching = switchingTaskKey === rowKey;
                        const taskTitle = task.title || t("taskList.untitled");
                        const displayStatus = task.displayStatus ?? "idle";

                        return (
                          <li key={rowKey}>
                            <button
                              type="button"
                              data-testid={`task-item-${task.taskId}`}
                              data-state={selected ? "selected" : "idle"}
                              className={cn(
                                "flex min-h-12 w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors disabled:cursor-wait disabled:opacity-70",
                                selected ? "bg-selected text-foreground" : "hover:bg-surface-hover",
                              )}
                              disabled={Boolean(switchingTaskKey)}
                              onClick={() => {
                                handleOpenTask(task);
                              }}
                            >
                              <span className="relative flex size-4 shrink-0 items-center justify-center">
                                {switching ? (
                                  <LoaderIcon className="size-4 animate-spin text-foreground-subtle" />
                                ) : task.unreadAt ? (
                                  <span className="h-1.5 w-1.5 rounded-full bg-sky-500 dark:bg-sky-400" />
                                ) : null}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-ui-base text-foreground">
                                  {taskTitle}
                                </span>
                                <span className="mt-1 flex min-w-0 items-center gap-1.5 text-ui-base text-foreground-subtle">
                                  <span className="truncate">
                                    {formatTaskRelativeTime(task.updatedAt, locale)}
                                  </span>
                                </span>
                              </span>
                              <span
                                className={cn(
                                  "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-ui-xs leading-none",
                                  getWebRemoteControlTaskStatusClassName(displayStatus),
                                )}
                              >
                                {getStatusIcon(displayStatus)}
                                {t(`webRemoteControl.taskStatus.${displayStatus}`)}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function useRemoteLocale() {
  return useRemoteIntl().locale;
}
