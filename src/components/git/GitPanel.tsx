/**
 * GitPanel —— Git 面板（P2-D，对齐 ZCode Git 面板群的核心形态）：
 * 分支切换器（当前分支下拉+切换）→ 工作区变更列表（点击打开文件预览）→
 * 提交历史（最近 50 条）。数据经 `src/lib/git/api.ts` 的 Rust 命令。
 * 非 git 仓库显示空态。
 * 自动刷新（P2 尾巴，对齐 ZCode useGitAutoRefresh 的意图）：ZCode 用文件监听
 * +60s 防抖，我们无监听服务，改为面板挂载期间 10s 轮询 + 窗口聚焦即刷；
 * 单飞护栏（上一轮未完成不叠加，避免 agent 批量写文件时的重复 git I/O）；
 * 自动刷新失败静默（保留上一次好数据），手动链路失败仍大字报错。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitBranch as GitBranchIcon, RefreshCw } from "lucide-react";
import { useTranslation } from "../../i18n";
import {
  gitBranchList,
  gitCheckout,
  gitInit,
  gitLog,
  gitStatus,
  type GitBranch,
  type GitCommit,
  type GitStatusEntry,
} from "../../lib/git/api";
import { GIT_LANE_COLOUR_COUNT, layoutGitGraph } from "../../lib/git/graphLayout";
import { CommitDialog } from "./CommitDialog";
import { toast } from "../lw/ui/toast";

/** 自动轮询间隔：与 ZCode「agent 批量写文件时避免密集 git I/O」的取向一致，取保守值。 */
const GIT_AUTO_REFRESH_INTERVAL_MS = 10_000;

export function GitPanel({ workspacePath }: { workspacePath?: string }) {
  const { t } = useTranslation();
  const cwd = workspacePath ?? "";
  const [branch, setBranch] = useState<string>("");
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [entries, setEntries] = useState<GitStatusEntry[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [isRepo, setIsRepo] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [initing, setIniting] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  // 提交图谱布局：随提交列表变化重算（parents 拓扑 → 泳道/坐标）
  const graph = useMemo(
    () =>
      layoutGitGraph(
        commits.map((c) => ({ hash: c.hash, parents: c.parents ?? [] })),
        { rowHeight: 42, laneGap: 14, lanePadding: 16, topPadding: 21, bottomPadding: 6 },
      ),
    [commits],
  );
  const refreshingRef = useRef(false);
  const switchingRef = useRef(false);
  switchingRef.current = switching;

  const refresh = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!cwd) return;
      if (refreshingRef.current) return;
      refreshingRef.current = true;
      if (!options?.silent) setLoading(true);
      if (!options?.silent) setError(null);
      try {
        const [status, branchList, log] = await Promise.all([
          gitStatus(cwd),
          gitBranchList(cwd),
          gitLog(cwd, 50),
        ]);
        setBranch(status.branch);
        setEntries(status.entries);
        setBranches(branchList.branches);
        setCommits(log.commits);
        setIsRepo(status.isGitRepo && branchList.isGitRepo);
      } catch (err) {
        if (options?.silent) {
          // 自动刷新失败只降级为「保留上一次好数据」；下次 tick / 手动刷新自会重试
          console.warn("[git-panel] auto refresh failed:", err);
        } else {
          setError(String(err));
        }
      } finally {
        refreshingRef.current = false;
        if (!options?.silent) setLoading(false);
      }
    },
    [cwd],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 顶栏分支切换器/checkpoint 提交后的主动刷新广播（BranchSwitcher 派发）
  useEffect(() => {
    if (!cwd) return;
    const onRefresh = () => void refresh({ silent: true });
    window.addEventListener("reinagent-git-refresh", onRefresh);
    return () => window.removeEventListener("reinagent-git-refresh", onRefresh);
  }, [refresh]);

  // 自动轮询：面板挂载期间每 10s 静默刷新；切分支进行中、页面不可见、上轮未完成时跳过
	useEffect(() => {
		if (!cwd) return;
		const timer = window.setInterval(() => {
			if (switchingRef.current) return;
			if (document.visibilityState !== "visible") return;
			void refresh({ silent: true });
		}, GIT_AUTO_REFRESH_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && !switchingRef.current) {
        void refresh({ silent: true });
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [cwd, refresh]);

  const switchBranch = async (name: string) => {
    if (name === branch || switching) return;
    setSwitching(true);
    setError(null);
    try {
      await gitCheckout(cwd, name);
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setSwitching(false);
    }
  };

  /** 非 git 仓库空态的一键初始化（git init -b main），成功后面板自动刷新。 */
  const initRepo = async () => {
    if (!cwd || initing) return;
    setIniting(true);
    try {
      await gitInit(cwd);
      toast.success(t("gitBranchInitSuccess"));
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setIniting(false);
    }
  };

  // porcelain XY 拆组：untracked 只进未暂存；其余按 index/worktree 位各归各组（同文件可同时出现）
  const stagedEntries = entries.filter((e) => e.code !== "??" && e.indexCode !== " ");
  const unstagedEntries = entries.filter(
    (e) => e.code === "??" || (e.code !== "??" && e.worktreeCode !== " "),
  );

  if (!cwd) {
    return <p className="p-4 text-sm text-[var(--text-dim)]">{t("gitNoWorkspace")}</p>;
  }

  if (error) {
    return (
      <div className="p-4">
        <p className="mb-3 rounded-lg border border-[var(--danger)] bg-[var(--bg-elev)] p-3 text-xs text-[var(--danger)]">
          {error}
        </p>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-dim)] hover:text-[var(--text)]"
        >
          {t("gitRetry")}
        </button>
      </div>
    );
  }

  if (!isRepo) {
    return (
      <div className="flex flex-col items-start gap-3 p-4">
        <p className="text-sm text-[var(--text-dim)]">{t("gitNotRepo")}</p>
        <button
          type="button"
          onClick={() => void initRepo()}
          disabled={initing}
          className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-2 text-sm text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50"
        >
          <GitBranchIcon className="h-4 w-4 text-[var(--text-dim)]" />
          {initing ? t("gitInitInitializing") : t("gitInitAction")}
        </button>
        <p className="text-xs text-[var(--text-dim)]">{t("gitInitHint")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-3">
      {/* 分支切换器 */}
      <div className="flex items-center gap-2">
        <GitBranchIcon className="h-3.5 w-3.5 shrink-0 text-[var(--text-dim)]" />
        <select
          value={branch}
          disabled={switching || branches.length === 0}
          onChange={(e) => void switchBranch(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-2 py-1.5 text-sm text-[var(--text)] focus:outline-none"
        >
          {branches.length === 0 ? <option value={branch}>{branch || "—"}</option> : null}
          {branches.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void refresh()}
          aria-label={t("gitRefresh")}
          className="rounded p-1.5 text-[var(--text-dim)] hover:text-[var(--text)]"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* 工作区变更（已暂存/未暂存两组 + 提交入口） */}
      <section>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-dim)]">
            {t("gitChanges")}（{entries.length}）
          </h3>
          {entries.length > 0 ? (
            <button
              type="button"
              onClick={() => setCommitOpen(true)}
              className="rounded-md border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            >
              {t("gitCommitOpen")}
            </button>
          ) : null}
        </div>
        {entries.length === 0 ? (
          <p className="text-xs text-[var(--text-dim)]">{t("gitNoChanges")}</p>
        ) : (
          <div className="space-y-2">
            {(
              [
                { label: t("gitStagedSection"), list: stagedEntries },
                { label: t("gitUnstagedSection"), list: unstagedEntries },
              ] as const
            ).map(
              (group) =>
                group.list.length > 0 ? (
                  <div key={group.label}>
                    <p className="px-2 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--text-dim)]">
                      {group.label}（{group.list.length}）
                    </p>
                    <div className="space-y-0.5">
                      {group.list.map((entry, index) => (
                        <button
                          key={`${entry.path}-${index}`}
                          type="button"
                          onClick={() => {
                            // 变更文件点击 → 打开文件预览（App 层 codeViewer）
                            window.dispatchEvent(
                              new CustomEvent("git-open-file", { detail: { path: entry.path } }),
                            );
                          }}
                          className="flex min-w-0 w-full items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-[var(--surface-hover)]"
                        >
                          <span
                            className={`w-8 shrink-0 text-center font-mono text-[10px] font-semibold ${
                              entry.code === "??"
                                ? "text-emerald-500"
                                : entry.code.includes("D")
                                  ? "text-red-500"
                                  : "text-amber-500"
                            }`}
                          >
                            {entry.code}
                          </span>
                          <span className="min-w-0 truncate font-mono text-xs text-[var(--text)]">
                            {entry.path}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null,
            )}
          </div>
        )}
      </section>

      {/* 提交历史（泳道图谱：连线层 + 节点层随行对齐，拓扑着色见 graphLayout） */}
      <section>
        <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--text-dim)]">
          {t("gitHistory")}
        </h3>
        {commits.length === 0 ? (
          <p className="text-xs text-[var(--text-dim)]">{t("gitNoCommits")}</p>
        ) : (
          <div className="relative">
            <svg
              className="absolute left-0 top-0 overflow-visible"
              width={graph.width}
              height={graph.height}
              viewBox={`0 0 ${graph.width} ${graph.height}`}
              aria-hidden="true"
            >
              {graph.paths.map((path) => (
                <path
                  key={path.id}
                  d={path.path}
                  fill="none"
                  strokeWidth={2}
                  opacity={0.55}
                  stroke={`var(--git-lane-${path.laneIndex % GIT_LANE_COLOUR_COUNT})`}
                />
              ))}
              {graph.rows.map((row) => (
                <circle
                  key={row.hash}
                  cx={row.x}
                  cy={row.y}
                  r={4}
                  strokeWidth={2}
                  stroke="var(--bg)"
                  fill={`var(--git-lane-${row.laneIndex % GIT_LANE_COLOUR_COUNT})`}
                />
              ))}
            </svg>
            <div>
              {commits.map((commit) => (
                <div
                  key={commit.hash}
                  style={{ height: graph.rowHeight, paddingLeft: graph.width + 4 }}
                  className="flex flex-col justify-center rounded-lg pr-2 hover:bg-[var(--surface-hover)]"
                >
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 font-mono text-[10px] text-[var(--text-dim)]">
                      {commit.hash.slice(0, 7)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-[var(--text)]">
                      {commit.subject}
                    </span>
                  </div>
                  <div className="pl-9 text-[10px] text-[var(--text-dim)]">
                    {commit.author} ·{" "}
                    {new Date(commit.timestamp * 1000).toLocaleDateString()}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* 提交对话框（ZCode GitCommitDialog 移植：信息 + ✨AI 生成 + 提交/提交并推送） */}
      <CommitDialog
        open={commitOpen}
        workspacePath={cwd}
        branchName={branch}
        onOpenChange={setCommitOpen}
        onCommitted={() => void refresh()}
      />
    </div>
  );
}
