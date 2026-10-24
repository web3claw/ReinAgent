/**
 * 任务 worktree 徽标（ROADMAP ②）：任务栏标题旁显示 ⎇ 分支名；点击展开
 * 合并回主分支 / 删除工作树（分支保留/可选删）/ 在文件管理器打开。
 * 合并结果（含冲突文件列表）toast 如实呈现（No-Fallback）。
 */

import { useEffect, useRef, useState } from "react";
import { GitBranch, GitMerge, Trash2, FolderOpen, Check, X } from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import { gitWorktreeMerge, gitWorktreeRemove } from "../../lib/worktree/service";
import { toast } from "../lw/ui/toast";
import { invoke } from "@tauri-apps/api/core";

export function WorktreeBadge({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const task = useAppStore((s) => s.tasks.find((t) => t.id === taskId));
  const branch = task?.worktreeBranch;
  const path = task?.worktreePath;
  const base = task?.worktreeBase;

  useEffect(() => {
    if (!open) return;
    const onClickAway = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirmDelete(false);
      }
    };
    document.addEventListener("mousedown", onClickAway);
    return () => document.removeEventListener("mousedown", onClickAway);
  }, [open]);

  if (!branch || !path) return null;

  async function handleMerge() {
    if (!base || !branch || !path) return;
    setBusy(true);
    try {
      const result = await gitWorktreeMerge(path, base);
      if (result.merged) {
        toast.success(`已合并回主分支（--no-ff，提交 ${(result.mergeCommit ?? "").slice(0, 8)}）`);
        setOpen(false);
      } else {
        const files = result.conflict?.unmergedFiles ?? [];
        toast.warning(
          `合并未执行：${result.conflict?.message ?? "未知原因"}${files.length ? `｜未合并文件：${files.slice(0, 5).join(", ")}${files.length > 5 ? " 等" : ""}` : ""}`,
          { duration: 8000 },
        );
      }
    } catch (err) {
      toast.error(`合并失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    if (!branch || !path) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    try {
      await gitWorktreeRemove(path, branch, false, false);
      useAppStore.getState().updateTaskWorktreeInfo(taskId, null);
      toast.success(`工作树已删除（分支 ${branch} 保留）`);
      setOpen(false);
      setConfirmDelete(false);
    } catch (err) {
      toast.error(`删除工作树失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleOpenFolder() {
    if (!path) return;
    try {
      await invoke("open_in_file_manager", { path });
    } catch (err) {
      toast.error(`打开目录失败：${err instanceof Error ? err.message : err}`);
    }
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-xs text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer max-w-[220px]"
        title={`worktree 隔离：${branch}（点击管理）`}
      >
        <GitBranch className="w-3 h-3 shrink-0" />
        <span className="truncate">{branch.replace("reinagent/", "")}</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 w-60 rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl p-1.5 text-xs z-50 flex flex-col gap-0.5">
          <div className="px-2 py-1.5 text-[11px] text-[var(--text-dim)] break-all">
            {path}
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleMerge()}
            className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-[var(--surface-hover)] text-[var(--text-primary)] flex items-center gap-2 cursor-pointer disabled:opacity-40"
          >
            <GitMerge className="w-3.5 h-3.5 shrink-0" />
            合并回主分支（--no-ff）
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleOpenFolder()}
            className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-[var(--surface-hover)] text-[var(--text-primary)] flex items-center gap-2 cursor-pointer disabled:opacity-40"
          >
            <FolderOpen className="w-3.5 h-3.5 shrink-0" />
            在文件管理器打开
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleRemove()}
            className={`w-full text-left px-2.5 py-2 rounded-lg flex items-center gap-2 cursor-pointer disabled:opacity-40 ${
              confirmDelete
                ? "text-[var(--status-err,red)] hover:bg-[var(--surface-hover)]"
                : "hover:bg-[var(--surface-hover)] text-[var(--text-primary)]"
            }`}
          >
            {confirmDelete ? <Check className="w-3.5 h-3.5 shrink-0" /> : <Trash2 className="w-3.5 h-3.5 shrink-0" />}
            {confirmDelete ? `确认删除？（分支 ${branch.replace("reinagent/", "")} 保留）` : "删除工作树（保留分支）"}
          </button>
          {confirmDelete && (
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-[var(--surface-hover)] text-[var(--text-dim)] flex items-center gap-2 cursor-pointer"
            >
              <X className="w-3.5 h-3.5 shrink-0" />
              取消
            </button>
          )}
        </div>
      )}
    </div>
  );
}
