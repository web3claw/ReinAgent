/**
 * 会话级 worktree 隔离（ROADMAP ②）：Rust git_worktree.rs 的 TS 包装与任务侧编排。
 *
 * - ensureTaskWorktree：幂等懒创建（开关开了但还没建 → 建并回填任务字段）；
 *   cwd 恒为任务的主工作区（project）——worktree 从主仓当前 HEAD 分出；
 * - 任务级三态开关（worktreeEnabled）+ 草稿态全局默认（hubSettings.worktree）；
 * - effectiveWorkspaceRoot 决议单点在 App.tsx（worktreePath 优先），
 *   终端/Files/Git/预览/hooks/提及全部无感跟随；
 * - 非 git 仓库：ensure 抛 GIT_NOT_REPO → 调用方 toast。
 */

import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store/useAppStore";

export interface WorktreeEnsureResult {
  worktreePath: string;
  branch: string;
  base: string;
  repoRoot: string;
  created: boolean;
}

export interface WorktreeMergeResult {
  merged: boolean;
  mergeCommit: string | null;
  conflict: { message: string; unmergedFiles: string[] } | null;
}

export interface WorktreeEligibility {
  clean: boolean;
  mergedIntoBase: boolean;
  removable: boolean;
}

export async function gitWorktreeEnsure(cwd: string, taskId: string, title: string): Promise<WorktreeEnsureResult> {
  return invoke<WorktreeEnsureResult>("git_worktree_ensure", { cwd, taskId, title });
}

export async function gitWorktreeMerge(worktreePath: string, baseCommit: string): Promise<WorktreeMergeResult> {
  return invoke<WorktreeMergeResult>("git_worktree_merge", { worktreePath, baseCommit });
}

export async function gitWorktreeRemove(worktreePath: string, branch: string, deleteBranch: boolean, force: boolean) {
  return invoke<void>("git_worktree_remove", { worktreePath, branch, deleteBranch, force });
}

export async function gitWorktreeEligibility(worktreePath: string, branch: string): Promise<WorktreeEligibility> {
  return invoke<WorktreeEligibility>("git_worktree_eligibility", { worktreePath, branch });
}

/**
 * 幂等确保任务的 worktree 存在并回填任务字段。
 * @returns worktree 路径；任务未开开关 / 无 project 返回 null（不报错）；
 *          非 git 仓库抛错（调用方 toast）。
 */
export async function ensureTaskWorktree(taskId: string): Promise<string | null> {
  const task = useAppStore.getState().tasks.find((t) => t.id === taskId);
  if (!task || !task.worktreeEnabled) return null;
  if (!task.project) {
    throw new Error("当前任务没有绑定工作区目录，无法启用 worktree 隔离");
  }
  // 幂等：已建 → 直接返回（Rust 侧对已挂分支也幂等，这里省一次 IPC）
  if (task.worktreePath && task.worktreeBranch) return task.worktreePath;
  const result = await gitWorktreeEnsure(task.project, taskId, task.title);
  useAppStore.getState().updateTaskWorktreeInfo(taskId, {
    path: result.worktreePath,
    branch: result.branch,
    base: result.base,
  });
  return result.worktreePath;
}

export { resolveTaskEffectiveRoot } from "./resolve.ts";
