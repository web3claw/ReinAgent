/**
 * useTaskOpen —— ZCode hooks/useWebRemoteControlTaskOpen.ts 直移适配：
 * 无远程 SSH 工作区分支（本仓全部为本地工作区），错误消息检查相应裁剪。
 */
import { useCallback, useMemo, useState } from "react";
import type { WebRemoteControlTaskTarget } from "../api/protocol";
import { resolveWebRemoteControlWorkspaceKey } from "../api/protocol";
import type { WebRemoteControlWorkspaceSwitcherApi } from "../api/protocol";

export function useWebRemoteControlTaskOpen({
  activeTaskId,
  activeWorkspaceIdentity,
  activeWorkspacePath,
  markTaskReadOnOpen,
  onNavigateHome,
  onNavigateToChat,
  onSelectTask,
  onSwitchingChange,
  switcher,
}: {
  activeTaskId: string | null;
  activeWorkspaceIdentity?: string;
  activeWorkspacePath: string;
  markTaskReadOnOpen: boolean;
  onNavigateHome?: () => void;
  onNavigateToChat?: () => void;
  onSelectTask: (targetWorkspacePath: string, taskId: string, targetWorkspaceIdentity?: string) => void;
  onSwitchingChange?: (switching: boolean) => void;
  switcher: WebRemoteControlWorkspaceSwitcherApi;
}) {
  const [switchingTaskKey, setSwitchingTaskKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeWorkspaceKey = useMemo(
    () =>
      resolveWebRemoteControlWorkspaceKey({
        workspacePath: activeWorkspacePath,
        workspaceIdentity: activeWorkspaceIdentity,
      }),
    [activeWorkspaceIdentity, activeWorkspacePath],
  );

  const openTask = useCallback(
    (task: WebRemoteControlTaskTarget) => {
      void (async () => {
        const taskWorkspaceKey = resolveWebRemoteControlWorkspaceKey(task);
        const isCrossWorkspace = taskWorkspaceKey !== activeWorkspaceKey;

        if (!isCrossWorkspace) {
          if (markTaskReadOnOpen && typeof task.unreadAt === "number" && switcher.markTaskRead) {
            try {
              void switcher.markTaskRead(task).catch(() => undefined);
            } catch (err) {
              console.warn("[useTaskOpen] mark read failed:", err);
            }
          }
          onSelectTask(task.workspacePath, task.taskId, task.workspaceIdentity);
          try {
            await switcher.updateMobileViewState?.(taskWorkspaceKey, task.taskId);
          } catch (err) {
            console.warn("[useTaskOpen] update view state failed:", err);
          }
          onNavigateToChat?.();
          return;
        }

        const rowKey = `${taskWorkspaceKey}:${task.taskId}`;
        onSwitchingChange?.(true);
        setSwitchingTaskKey(rowKey);
        setError(null);
        try {
          await switcher.switchWorkspace(taskWorkspaceKey, { taskId: task.taskId });
          if (markTaskReadOnOpen && typeof task.unreadAt === "number" && switcher.markTaskRead) {
            void switcher.markTaskRead(task).catch(() => undefined);
          }
          onSelectTask(task.workspacePath, task.taskId, task.workspaceIdentity);
          await switcher.updateMobileViewState?.(taskWorkspaceKey, task.taskId);
          onNavigateToChat?.();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[useTaskOpen] open task failed:", { taskId: task.taskId, message });
          setError(message);
        } finally {
          setSwitchingTaskKey(null);
          onSwitchingChange?.(false);
        }
      })();
    },
    [
      activeTaskId,
      activeWorkspaceIdentity,
      activeWorkspaceKey,
      activeWorkspacePath,
      markTaskReadOnOpen,
      onNavigateHome,
      onNavigateToChat,
      onSelectTask,
      onSwitchingChange,
      switcher,
    ],
  );

  return { activeWorkspaceKey, error, openTask, switchingTaskKey };
}
