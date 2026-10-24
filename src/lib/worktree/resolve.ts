/**
 * worktree 决议纯函数（纯模块，node --test 直跑）：
 * 任务开启且已建 → worktree 路径；否则回退主工作区。
 */

export interface WorktreeTaskShape {
  worktreeEnabled?: boolean;
  worktreePath?: string;
}

export function resolveTaskEffectiveRoot(task: WorktreeTaskShape | null | undefined, fallbackRoot: string): string {
  if (task?.worktreeEnabled && task.worktreePath) return task.worktreePath;
  return fallbackRoot;
}
