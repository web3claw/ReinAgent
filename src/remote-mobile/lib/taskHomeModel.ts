/**
 * taskHomeModel —— ZCode lib/webRemoteControlMobileTaskHome.ts 直移适配：
 * 分组/排序（原 webRemoteControlTaskIndex 的两个函数 + taskListOrdering 比较器一并内联），
 * 偏好持久化键改 reinagent- 前缀。纯逻辑无 React。
 */
import type {
  WebRemoteControlTaskDisplayStatus,
  WebRemoteControlTaskTarget,
  WebRemoteControlWorkspaceListResult,
  WebRemoteControlWorkspaceTarget,
} from "../api/protocol.ts";
import { resolveWebRemoteControlWorkspaceKey } from "../api/protocol.ts";

export interface WebRemoteControlWorkspaceTaskGroup {
  workspaceKey: string;
  workspace: WebRemoteControlWorkspaceTarget;
  tasks: WebRemoteControlTaskTarget[];
  hasUnread: boolean;
}

export const EMPTY_WEB_REMOTE_CONTROL_WORKSPACE_LIST: WebRemoteControlWorkspaceListResult = {
  workspaces: [],
  tasks: [],
};

export interface WebRemoteControlMobileTaskHomeModel {
  activeTaskId: string | null;
  activeWorkspaceKey: string;
  defaultExpandedWorkspaceKeys: Set<string>;
  pinnedTasks: WebRemoteControlTaskTarget[];
  timelineTasks: WebRemoteControlTaskTarget[];
  groups: WebRemoteControlWorkspaceTaskGroup[];
  totalTaskCount: number;
  totalWorkspaceCount: number;
}

export type WebRemoteControlMobileTaskSortBy = "created" | "updated";
export type WebRemoteControlMobileTaskOrganizeBy = "workspace" | "timeline";

export type WebRemoteControlMobileTaskHomePreferences = {
  organizeBy: WebRemoteControlMobileTaskOrganizeBy;
  sortBy: WebRemoteControlMobileTaskSortBy;
};

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

const WEB_REMOTE_CONTROL_MOBILE_TASK_HOME_PREFERENCES_STORAGE_KEY =
  "reinagent-web-remote-control-mobile-task-home-preferences";

const DEFAULT_WEB_REMOTE_CONTROL_MOBILE_TASK_HOME_PREFERENCES: WebRemoteControlMobileTaskHomePreferences = {
  organizeBy: "workspace",
  sortBy: "updated",
};

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isWebRemoteControlMobileTaskHomePreferences(
  value: unknown,
): value is WebRemoteControlMobileTaskHomePreferences {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WebRemoteControlMobileTaskHomePreferences>;
  return (
    (candidate.organizeBy === "workspace" || candidate.organizeBy === "timeline") &&
    (candidate.sortBy === "created" || candidate.sortBy === "updated")
  );
}

export function readWebRemoteControlMobileTaskHomePreferences(
  storage: StorageLike | null = getBrowserStorage(),
): WebRemoteControlMobileTaskHomePreferences {
  try {
    const raw = storage?.getItem(WEB_REMOTE_CONTROL_MOBILE_TASK_HOME_PREFERENCES_STORAGE_KEY);
    if (!raw) return DEFAULT_WEB_REMOTE_CONTROL_MOBILE_TASK_HOME_PREFERENCES;
    const parsed = JSON.parse(raw) as unknown;
    if (!isWebRemoteControlMobileTaskHomePreferences(parsed)) {
      return DEFAULT_WEB_REMOTE_CONTROL_MOBILE_TASK_HOME_PREFERENCES;
    }
    return parsed;
  } catch {
    return DEFAULT_WEB_REMOTE_CONTROL_MOBILE_TASK_HOME_PREFERENCES;
  }
}

export function persistWebRemoteControlMobileTaskHomePreferences(
  preferences: WebRemoteControlMobileTaskHomePreferences,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  try {
    storage?.setItem(
      WEB_REMOTE_CONTROL_MOBILE_TASK_HOME_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences),
    );
  } catch {
    // localStorage 隐私模式可能不可写，忽略失败（ZCode 同语义）
  }
}

// ---- 排序（taskListOrdering.ts 两层排序直移：运行层置顶且按创建时间稳定，非运行层按时间偏好） ----

interface SortableTask {
  taskId: string;
  createdAt: number;
  updatedAt: number;
}

const isWebRemoteControlTaskRunning = (task: WebRemoteControlTaskTarget): boolean =>
  task.displayStatus === "running";

function compareTaskListItemsByTime(left: SortableTask, right: SortableTask, sortBy: WebRemoteControlMobileTaskSortBy): number {
  if (sortBy === "created") {
    if (right.createdAt !== left.createdAt) return right.createdAt - left.createdAt;
    if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
    return right.taskId.localeCompare(left.taskId);
  }
  if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
  if (right.createdAt !== left.createdAt) return right.createdAt - left.createdAt;
  return right.taskId.localeCompare(left.taskId);
}

export function compareWebRemoteControlTasksByTime(sortBy: WebRemoteControlMobileTaskSortBy) {
  return (left: WebRemoteControlTaskTarget, right: WebRemoteControlTaskTarget): number => {
    const leftRunning = isWebRemoteControlTaskRunning(left);
    const rightRunning = isWebRemoteControlTaskRunning(right);
    if (leftRunning !== rightRunning) return leftRunning ? -1 : 1;
    if (leftRunning) {
      if (right.createdAt !== left.createdAt) return right.createdAt - left.createdAt;
      // 运行层禁止以 updatedAt 决胜（事件会频繁刷新它）；taskId 是稳定 tie-break
      return right.taskId.localeCompare(left.taskId);
    }
    return compareTaskListItemsByTime(left, right, sortBy);
  };
}

export function sortWebRemoteControlTasksByTime(
  tasks: readonly WebRemoteControlTaskTarget[],
  sortBy: WebRemoteControlMobileTaskSortBy,
): WebRemoteControlTaskTarget[] {
  return [...tasks].sort(compareWebRemoteControlTasksByTime(sortBy));
}

// ---- 工作区分组（webRemoteControlTaskIndex.groupWebRemoteControlTasksByWorkspace 直移） ----

export function groupWebRemoteControlTasksByWorkspace({
  workspaces,
  tasks,
  sortBy = "updated",
}: {
  workspaces: WebRemoteControlWorkspaceTarget[];
  tasks: WebRemoteControlTaskTarget[];
  sortBy?: WebRemoteControlMobileTaskSortBy;
}): WebRemoteControlWorkspaceTaskGroup[] {
  const groups = workspaces.map((workspace) => ({
    workspaceKey: resolveWebRemoteControlWorkspaceKey(workspace),
    workspace,
    tasks: [] as WebRemoteControlTaskTarget[],
    hasUnread: false,
  }));
  const groupByKey = new Map(groups.map((group) => [group.workspaceKey, group]));

  for (const task of tasks) {
    const group = groupByKey.get(resolveWebRemoteControlWorkspaceKey(task));
    if (!group) continue;
    group.tasks.push(task);
  }

  return groups.map((group) => ({
    ...group,
    tasks: sortWebRemoteControlTasksByTime(group.tasks, sortBy),
    hasUnread: group.tasks.some((task) => typeof task.unreadAt === "number"),
  }));
}

// ---- 首页模型（webRemoteControlMobileTaskHome.ts 主体直移） ----

export function buildWebRemoteControlMobileTaskHomeModel({
  activeTaskId,
  activeWorkspaceIdentity,
  activeWorkspacePath,
  sortBy = "updated",
  result,
}: {
  activeTaskId: string | null;
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  sortBy?: WebRemoteControlMobileTaskSortBy;
  result: WebRemoteControlWorkspaceListResult;
}): WebRemoteControlMobileTaskHomeModel {
  const fallbackWorkspaceKey = resolveWebRemoteControlWorkspaceKey({
    workspacePath: activeWorkspacePath,
    workspaceIdentity: activeWorkspaceIdentity,
  });
  const resolvedActiveWorkspaceKey = result.activeWorkspaceKey ?? fallbackWorkspaceKey;
  const resolvedActiveTaskId = result.activeTaskId ?? activeTaskId;
  const allTasks = (result.tasks ?? []).filter((task) => !task.archived);
  const pinnedTasks = sortWebRemoteControlTasksByTime(
    allTasks.filter((task) => task.pinned),
    sortBy,
  );
  const regularTasks = allTasks.filter((task) => !task.pinned);
  const groups = groupWebRemoteControlTasksByWorkspace({
    workspaces: result.workspaces,
    tasks: regularTasks,
  });
  const hasActiveWorkspace = groups.some((group) => group.workspaceKey === resolvedActiveWorkspaceKey);

  return {
    activeTaskId: resolvedActiveTaskId ?? null,
    activeWorkspaceKey: resolvedActiveWorkspaceKey,
    defaultExpandedWorkspaceKeys: new Set(hasActiveWorkspace ? [resolvedActiveWorkspaceKey] : []),
    pinnedTasks,
    timelineTasks: sortWebRemoteControlTasksByTime(regularTasks, sortBy),
    groups,
    totalTaskCount: allTasks.length,
    totalWorkspaceCount: groups.length,
  };
}

export function hasWebRemoteControlMobileTaskHomeActiveTaskMatch(
  model: Pick<
    WebRemoteControlMobileTaskHomeModel,
    "activeTaskId" | "activeWorkspaceKey" | "groups" | "pinnedTasks"
  >,
): boolean {
  if (!model.activeTaskId) return true;
  return (
    model.pinnedTasks.some(
      (task) =>
        task.taskId === model.activeTaskId &&
        resolveWebRemoteControlWorkspaceKey(task) === model.activeWorkspaceKey,
    ) ||
    model.groups.some(
      (group) =>
        group.workspaceKey === model.activeWorkspaceKey &&
        group.tasks.some((task) => task.taskId === model.activeTaskId),
    )
  );
}

/** ZCode getWebRemoteControlTaskStatusClassName 直移。 */
export function getWebRemoteControlTaskStatusClassName(status: WebRemoteControlTaskDisplayStatus) {
  switch (status) {
    case "running":
      return "border-brand/40 bg-accent text-foreground";
    case "completed":
      return "border-success/40 bg-success text-success-foreground";
    case "error":
      return "border-destructive/40 bg-destructive text-destructive-foreground";
    case "idle":
      return "border-border bg-surface text-foreground-subtle";
  }
}

export function getWorkspaceLatestUpdatedAt(tasks: readonly WebRemoteControlTaskTarget[]): number | null {
  if (tasks.length === 0) return null;
  return Math.max(...tasks.map((task) => task.updatedAt));
}

/** ZCode buildWebRemoteControlTaskRowKey 直移。 */
export function buildWebRemoteControlTaskRowKey(task: WebRemoteControlTaskTarget): string {
  return `${resolveWebRemoteControlWorkspaceKey(task)}:${task.taskId}`;
}
