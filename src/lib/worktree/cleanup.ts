/**
 * worktree 自动清理（ROADMAP ②）：App 启动 + 每小时扫描一次。
 *
 * - 对有 worktreePath 的任务查 eligibility（干净+已合并，Rust 判定）；
 *   空闲判定（任务 updatedAt > 24h）在 TS 侧叠加；
 *   removable → 自动移除工作树（分支保留）+ 清任务 worktree 字段；
 * - 未交付（未合并或有未提交改动）的任务永不动；
 * - 失败仅 console.warn（旁路不扰主流程）。
 */

import { useAppStore } from "../../store/useAppStore";
import { gitWorktreeEligibility, gitWorktreeRemove } from "./service";

const IDLE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const SCAN_INTERVAL_MS = 60 * 60 * 1000;
let inFlight = false;

export async function worktreeCleanupSweep(): Promise<{ removed: number; skipped: number }> {
  let removed = 0;
  let skipped = 0;
  const tasks = useAppStore.getState().tasks.filter((t) => t.worktreeEnabled && t.worktreePath && t.worktreeBranch);
  for (const task of tasks) {
    const idleMs = Date.now() - (task.updatedAt ?? 0);
    if (idleMs < IDLE_THRESHOLD_MS) {
      skipped += 1;
      continue;
    }
    try {
      const eligibility = await gitWorktreeEligibility(task.worktreePath!, task.worktreeBranch!);
      if (!eligibility.removable) {
        skipped += 1;
        continue;
      }
      await gitWorktreeRemove(task.worktreePath!, task.worktreeBranch!, false, false);
      useAppStore.getState().updateTaskWorktreeInfo(task.id, null);
      removed += 1;
      console.info(`[worktree] 已清理闲置工作树（分支保留）: ${task.worktreeBranch}`);
    } catch (err) {
      skipped += 1;
      console.warn(
        `[worktree] 清理扫描异常（${task.worktreeBranch}）:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { removed, skipped };
}

export function createWorktreeCleanupService() {
  const interval = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void worktreeCleanupSweep()
      .catch((err) => console.warn("[worktree] 清理 sweep 失败:", err instanceof Error ? err.message : err))
      .finally(() => {
        inFlight = false;
      });
  }, SCAN_INTERVAL_MS);
  // 启动即扫一次（延迟 30s 等任务水合完成）
  const startup = setTimeout(() => {
    inFlight = true;
    void worktreeCleanupSweep()
      .catch(() => {})
      .finally(() => {
        inFlight = false;
      });
  }, 30_000);
  return {
    dispose: () => {
      clearInterval(interval);
      clearTimeout(startup);
    },
  };
}
