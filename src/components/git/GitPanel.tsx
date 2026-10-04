/**
 * GitPanel —— Git 面板（P2-D，对齐 ZCode Git 面板群的核心形态）：
 * 分支切换器（当前分支下拉+切换）→ 工作区变更列表（ZCode GitPaneChangeCard 移植：
 * 文件图标+目录+N -N，手风琴点击懒加载内联单文件 diff）→ 提交历史（最近 50 条）。
 * 数据经 `src/lib/git/api.ts` 的 Rust 命令。非 git 仓库显示 init 空态。
 * 自动刷新（P2 尾巴，对齐 ZCode useGitAutoRefresh 的意图）：ZCode 用文件监听
 * +60s 防抖，我们无监听服务，改为面板挂载期间 10s 轮询 + 窗口聚焦即刷；
 * 单飞护栏（上一轮未完成不叠加，避免 agent 批量写文件时的重复 git I/O）；
 * 自动刷新失败静默（保留上一次好数据），手动链路失败仍大字报错。
 */

import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitBranch as GitBranchIcon, RefreshCw } from "lucide-react";
import { useTranslation } from "../../i18n";
import {
  gitBranchList,
  gitCheckout,
  gitDiffFile,
  gitInit,
  gitLog,
  gitNumstat,
  gitStatus,
  type GitBranch,
  type GitCommit,
  type GitNumStatFile,
  type GitStatusEntry,
} from "../../lib/git/api";
import { GIT_LANE_COLOUR_COUNT, layoutGitGraph } from "../../lib/git/graphLayout";
import { resolveFileDisplayDescriptor } from "../../preview/lib/fileDisplay";
import { HighlightedLightweightDiffPreview } from "../../preview/components/ui/highlighted-lightweight-diff-preview";
import { getPlainTextPatchFallbackLines } from "../../preview/lib/patchDiffPreview";
import { inferCodeLanguage } from "../../preview/lib/codeViewer";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "../../preview/lib/codePreviewSettings";
import { useAppStore } from "../../store/useAppStore";
import { CommitDialog } from "./CommitDialog";
import { toast } from "../lw/ui/toast";

/** 自动轮询间隔：与 ZCode「agent 批量写文件时避免密集 git I/O」的取向一致，取保守值。 */
const GIT_AUTO_REFRESH_INTERVAL_MS = 10_000;

type ChangeGroup = "staged" | "unstaged";

interface FileDiffState {
  patch: string | null;
  availability: string;
  loading?: boolean;
}

export function GitPanel({ workspacePath }: { workspacePath?: string }) {
  const { t } = useTranslation();
  const cwd = workspacePath ?? "";
  const appTheme = useAppStore((s) => s.theme);
  // DiffViewer 主题：store 主题（light/dark/system）解析成 light/dark
  const themeType = appTheme === "dark" ? ("dark" as const) : ("light" as const);
  const [branch, setBranch] = useState<string>("");
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [entries, setEntries] = useState<GitStatusEntry[]>([]);
  const [numstats, setNumstats] = useState<{ staged: GitNumStatFile[]; unstaged: GitNumStatFile[] }>({ staged: [], unstaged: [] });
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [isRepo, setIsRepo] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [initing, setIniting] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  // 变更行手风琴（对齐 ZCode expandedPath：同时只展开一个）+ 单文件 diff 懒加载缓存
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [diffByKey, setDiffByKey] = useState<Record<string, FileDiffState>>({});
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
        const [status, branchList, log, numstat] = await Promise.all([
          gitStatus(cwd),
          gitBranchList(cwd),
          gitLog(cwd, 50),
          gitNumstat(cwd),
        ]);
        setBranch(status.branch);
        setEntries(status.entries);
        setBranches(branchList.branches);
        setNumstats({ staged: numstat.staged, unstaged: numstat.unstaged });
        setCommits(log.commits);
        setIsRepo(status.isGitRepo && branchList.isGitRepo);
        // 数据变了：单文件 diff 缓存整体失效（对齐 ZCode revision 清缓存）；展开态保留
        setDiffByKey({});
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

  /** 拉取单文件 diff 写入缓存（展开与 refresh 重建共用）。 */
  const loadDiff = useCallback(
    async (group: ChangeGroup, entry: GitStatusEntry, key: string) => {
      setDiffByKey((m) => ({ ...m, [key]: { patch: null, availability: "patch", loading: true } }));
      try {
        const res = await gitDiffFile(cwd, entry.path, group === "staged", entry.code === "??");
        setDiffByKey((m) => ({ ...m, [key]: { patch: res.patch, availability: res.availability } }));
      } catch (err) {
        console.warn("[git-panel] file diff failed:", err);
        setDiffByKey((m) => ({ ...m, [key]: { patch: null, availability: "unavailable" } }));
      }
    },
    [cwd],
  );

  /** 展开手风琴 + 懒加载单文件 diff（缓存 key = `组:路径`，对齐 ZCode loadDiffForChange）。 */
  const toggleChange = useCallback(
    async (group: ChangeGroup, entry: GitStatusEntry) => {
      const key = `${group}:${entry.path}`;
      if (expandedKey === key) {
        setExpandedKey(null);
        return;
      }
      setExpandedKey(key);
      if (diffByKey[key]) return;
      await loadDiff(group, entry, key);
    },
    [diffByKey, expandedKey, loadDiff],
  );

  // refresh 会整体清空 diff 缓存；展开中的行必须立即重建，否则永远卡「加载改动中」
  // （10s 轮询 + 手动刷新都会走到；对齐 ZCode revision 清缓存后重载展开 diff 的行为）
  useEffect(() => {
    if (!expandedKey || diffByKey[expandedKey]) return;
    const idx = expandedKey.indexOf(":");
    const group = expandedKey.slice(0, idx) as ChangeGroup;
    const path = expandedKey.slice(idx + 1);
    const entry = (group === "staged" ? stagedEntries : unstagedEntries).find(
      (e) => e.path === path,
    );
    if (entry) void loadDiff(group, entry, expandedKey);
  }, [diffByKey, expandedKey, loadDiff, stagedEntries, unstagedEntries]);

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
        <p className="text-sm text-[var(--text-dim)]">{t("gitInitHint")}</p>
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
          <h3 className="text-sm font-medium text-[var(--text-dim)]">
            {t("gitChanges")}（{entries.length}）
          </h3>
          {entries.length > 0 ? (
            <button
              type="button"
              onClick={() => setCommitOpen(true)}
              className="rounded-md border border-[var(--border)] px-2.5 py-1 text-[13px] text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            >
              {t("gitCommitOpen")}
            </button>
          ) : null}
        </div>
        {entries.length === 0 ? (
          <p className="text-sm text-[var(--text-dim)]">{t("gitNoChanges")}</p>
        ) : (
          <div className="space-y-2">
            {(
              [
                { id: "staged" as ChangeGroup, label: t("gitStagedSection"), list: stagedEntries },
                { id: "unstaged" as ChangeGroup, label: t("gitUnstagedSection"), list: unstagedEntries },
              ]
            ).map(
              (group) =>
                group.list.length > 0 ? (
                  <div key={group.id}>
                    <p className="px-2 pb-0.5 text-[13px] font-medium text-[var(--text-dim)]">
                      {group.label}（{group.list.length}）
                    </p>
                    <div className="space-y-0.5">
                      {group.list.map((entry) => {
                        const key = `${group.id}:${entry.path}`;
                        const isExpanded = expandedKey === key;
                        const diff = diffByKey[key];
                        const stat = numstats[group.id].find((f) => f.path === entry.path);
                        const descriptor = resolveFileDisplayDescriptor(entry.path);
                        return (
                          <div key={key}>
                            {/* 变更行（ZCode GitPaneChangeCard 同款布局）：
                                图标 | 文件名（截断优先）| 目录（暗色）| +/- | chevron，
                                点击 = 展开/收起内联 diff；无 porcelain 状态码前缀 */}
                            <button
                              type="button"
                              onClick={() => void toggleChange(group.id, entry)}
                              className={`flex min-w-0 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-hover)] ${
                                isExpanded ? "bg-[var(--surface-hover)]" : ""
                              }`}
                            >
                              <img
                                src={descriptor.fileIconSrc}
                                alt=""
                                width={16}
                                height={16}
                                className="h-4 w-4 shrink-0"
                                aria-hidden="true"
                              />
                              <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">
                                {descriptor.fileName}
                              </span>
                              {descriptor.filePath ? (
                                <span className="max-w-[45%] shrink truncate text-sm text-[var(--text-dim)]">
                                  {descriptor.filePath}
                                </span>
                              ) : null}
                              {stat ? (
                                <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs">
                                  <span className="text-emerald-500">+{stat.added}</span>
                                  <span className="text-red-500">-{stat.removed}</span>
                                </span>
                              ) : null}
                              <ChevronDown
                                className={`h-4 w-4 shrink-0 text-[var(--text-dim)] transition-transform ${isExpanded ? "rotate-180" : ""}`}
                              />
                            </button>
                            {/* 展开的单文件 diff（懒加载 + 缓存，ZCode loadDiffForChange 同款） */}
                            {isExpanded ? (
                              <div className="mb-1 ml-6 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-elev-2)]">
                                {!diff || diff.loading ? (
                                  <p className="p-3 text-sm text-[var(--text-dim)]">{t("gitDiffLoading")}</p>
                                ) : diff.availability === "patch" && diff.patch ? (
                                  <div className="max-h-96 overflow-auto text-left">
                                    {/* 与右侧 patch 预览同款轻量渲染（@pierre PatchDiff 对部分
                                        patch 会静默空白，面板统一走 HighlightedLightweightDiffPreview）；
                                        字号放大 14px；剥掉 `\ No newline at end of file` 行（用户要求不显示） */}
                                    <HighlightedLightweightDiffPreview
                                      className="w-full"
                                      codePreviewSettings={{
                                        ...DEFAULT_CODE_PREVIEW_SETTINGS,
                                        fontSizePx: 14,
                                      }}
                                      language={inferCodeLanguage(entry.path, diff.patch)}
                                      lines={(getPlainTextPatchFallbackLines(diff.patch) ?? diff.patch.split(/\r?\n/)).filter(
                                        (line) => !line.startsWith("\\ No newline"),
                                      )}
                                      path={entry.path}
                                      theme={themeType === "dark" ? DEFAULT_CODE_PREVIEW_SETTINGS.darkTheme : DEFAULT_CODE_PREVIEW_SETTINGS.lightTheme}
                                    />
                                  </div>
                                ) : (
                                  <p className="p-3 text-sm text-[var(--text-dim)]">
                                    {diff.availability === "binary"
                                      ? t("gitDiffBinary")
                                      : diff.availability === "truncated"
                                        ? t("gitDiffTruncated")
                                        : t("gitDiffUnavailable")}
                                  </p>
                                )}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null,
            )}
          </div>
        )}
      </section>

      {/* 提交历史（泳道图谱：连线层 + 节点层随行对齐，拓扑着色见 graphLayout） */}
      <section>
        <h3 className="mb-1.5 text-sm font-medium text-[var(--text-dim)]">
          {t("gitHistory")}
        </h3>
        {commits.length === 0 ? (
          <p className="text-sm text-[var(--text-dim)]">{t("gitNoCommits")}</p>
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
