/**
 * BranchSwitcher —— 顶栏分支切换器（ZCode GitBranchSwitcher 移植）。
 *
 * 交互对齐 ZCode：
 * - 选择即检出（工作区全局，不绑定任务字段）；同分支 no-op 不弹 toast。
 * - 下拉 = 搜索框 + 分支列表（当前分支置顶 ✓ + 未提交文件数提示，Rust 侧已按
 *   当前→提交时间倒序排序）+ 底部「创建并检出新分支…」「Git 图谱」。
 * - 切换被 git 拒绝时把 stderr 归一成结构化 issue：overwrite 类不直接 toast，
 *   而是转「切换助手」两步弹窗（受影响文件 → checkpoint 提交 → 自动重试切换），
 *   其余归因 toast 如实展示（detail 保留 git 原文，No-Fallback）。
 * - 非 git 仓库 / 无工作区不渲染；分支列表每次展开都重拉（避免旧快照「切了不变」）。
 */
import { Check, ChevronDown, CircleAlert, GitBranch, GitGraph, Loader2, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation, type TranslationKey } from "../../i18n";
import {
  gitBranchListV2,
  gitBranchSwitch,
  gitCommit,
  gitIdentity,
  gitInit,
  gitNumstat,
  gitStage,
  type GitBranchIssue,
  type GitBranchListV2Response,
  type GitBranchMutationResponse,
  type GitIdentityResponse,
} from "../../lib/git/api";
import {
  buildAutoCommitMessage,
  getCommitTotals,
  getPrimaryIssue,
  hasCommitIdentity,
  isCommitAssistIssue,
  matchesBranchSearch,
  resolveIssueMessageKey,
  resolveBranchTriggerLabel,
  resolveSuccessMessageKey,
  selectAffectedFiles,
  summarizeIssuePaths,
  type BranchAssistFile,
} from "../../lib/git/branchSwitcherLogic";
import { useAppStore } from "../../store/useAppStore";
import { Button } from "../lw/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../lw/ui/dialog";
import { Input } from "../lw/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../lw/ui/popover";
import { Textarea } from "../lw/ui/textarea";
import { toast } from "../lw/ui/toast";

/** 「切换助手」两步弹窗的共享状态（对齐 ZCode GitBranchSwitchAssistState）。 */
interface SwitchAssistState {
  targetBranchName: string;
  currentBranchName: string | null;
  issue: GitBranchIssue;
  affectedFiles: BranchAssistFile[];
  /** checkpoint 提交的 stage 集合 = 全部变更文件 + issue 受影响路径（对齐 ZCode） */
  stagePaths: string[];
  fileCount: number;
  totalAdded: number;
  totalRemoved: number;
  identity: GitIdentityResponse | null;
}

const fmt = (template: string, params: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? ""));

const shortError = (err: unknown): string =>
  String(err instanceof Error ? err.message : err).slice(0, 300);

export function BranchSwitcher({ workspacePath }: { workspacePath: string | undefined }) {
  const { t } = useTranslation();
  const openCodeViewer = useAppStore((s) => s.openCodeViewer);

  /** null=探测中；false=非 git 仓库（显示「初始化 Git 仓库」按钮） */
  const [repoState, setRepoState] = useState<"checking" | "repo" | "nonRepo">("checking");
  const [initPending, setInitPending] = useState(false);
  const [branchesResult, setBranchesResult] = useState<GitBranchListV2Response | null>(null);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [open, setOpen] = useState(false);
  const [mutationPending, setMutationPending] = useState(false);
  const [dirtyCount, setDirtyCount] = useState(0);
  const [search, setSearch] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");

  const [assistStep, setAssistStep] = useState<"blocked" | "commit" | null>(null);
  const [assist, setAssist] = useState<SwitchAssistState | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [commitError, setCommitError] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);

  /** 分支列表 + 未提交数；每次展开都重拉（对齐 ZCode 防旧快照）。 */
  const loadBranches = useCallback(async () => {
    if (!workspacePath) return;
    setLoadingBranches(true);
    try {
      const res = await gitBranchListV2(workspacePath);
      setBranchesResult(res);
      setRepoState(res.isGitRepo ? "repo" : "nonRepo");
      if (res.isGitRepo) {
        const stats = await gitNumstat(workspacePath);
        setDirtyCount(stats.staged.length + stats.unstaged.length);
      }
    } catch (err) {
      // 后台探测失败（git 缺失/目录失效）：按非仓库处理，点击初始化会给出真实错误
      console.warn("[branch-switcher] load branches failed:", err);
      setRepoState("nonRepo");
    } finally {
      setLoadingBranches(false);
    }
  }, [workspacePath]);

  /** 非 git 仓库时的一键初始化（git init -b main），成功后原位变回分支切换器。 */
  const handleInit = useCallback(async () => {
    if (!workspacePath || initPending) return;
    setInitPending(true);
    try {
      await gitInit(workspacePath);
      toast.success(t("gitBranchInitSuccess"));
      window.dispatchEvent(new CustomEvent("reinagent-git-refresh"));
      await loadBranches();
    } catch (err) {
      toast.error(String(err instanceof Error ? err.message : err).slice(0, 300));
    } finally {
      setInitPending(false);
    }
  }, [initPending, loadBranches, t, workspacePath]);

  // 工作区切换：重置全部本地态再探测
  useEffect(() => {
    setOpen(false);
    setCreateOpen(false);
    setCreateName("");
    setSearch("");
    setBranchesResult(null);
    setRepoState(workspacePath ? "checking" : "nonRepo");
    setAssistStep(null);
    setAssist(null);
    setCommitError(null);
    setCommitMessage("");
    void loadBranches();
  }, [loadBranches]);

  // 每次展开重拉；窗口聚焦/其他入口切过分支时同步触发器标签
  useEffect(() => {
    if (open) {
      void loadBranches();
    }
  }, [loadBranches, open]);
  useEffect(() => {
    if (!workspacePath) return;
    const onRefresh = () => void loadBranches();
    window.addEventListener("reinagent-git-refresh", onRefresh);
    // 窗口聚焦/回前台时重探（仓库被外部 init/删除后 chip 及时出现/消失，与 GitPanel 同款模式）
    const onFocus = () => {
      if (document.visibilityState !== "visible") return;
      void loadBranches();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("reinagent-git-refresh", onRefresh);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [loadBranches, workspacePath]);

  // 展开时滚动到当前分支（对齐 ZCode scrollIntoView）
  useEffect(() => {
    if (!open || !branchesResult?.branches.length) return;
    const frameId = window.requestAnimationFrame(() => {
      listRef.current
        ?.querySelector<HTMLElement>('[data-branch-current="true"]')
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [branchesResult, open]);

  const resetAssist = useCallback(() => {
    setAssistStep(null);
    setAssist(null);
    setCommitMessage("");
    setCommitError(null);
  }, []);

  const notifyFailure = useCallback(
    (issue: GitBranchIssue | null, res: GitBranchMutationResponse) => {
      if (!issue) {
        toast.error(t("gitBranchErrRequestFailed"));
        return;
      }
      const key = resolveIssueMessageKey(issue);
      if (key) {
        const { visiblePaths, remainingCount } = summarizeIssuePaths(issue.paths);
        const paths =
          visiblePaths.join(", ") +
          (remainingCount > 0 ? fmt(t("gitBranchErrMoreFiles"), { count: remainingCount }) : "");
        toast.error(fmt(t(key as TranslationKey), { paths, branchName: issue.detail ?? res.branchName ?? "" }));
        return;
      }
      const fallback = issue.detail?.trim() || issue.message.trim();
      toast.error(fallback.slice(0, 300) || t("gitBranchErrRequestFailed"));
    },
    [t],
  );

  /** overwrite 类阻塞 →「切换助手」：读取受影响文件与提交身份后开 blocked 弹窗。 */
  const prepareSwitchAssist = useCallback(
    async (res: GitBranchMutationResponse): Promise<boolean> => {
      const issue = getPrimaryIssue(res.issues);
      if (!issue || !isCommitAssistIssue(issue.code) || !res.branchName || !workspacePath) {
        return false;
      }
      try {
        const [stats, identity] = await Promise.all([
          gitNumstat(workspacePath),
          gitIdentity(workspacePath).catch(() => null),
        ]);
        const allChanges = [...stats.unstaged, ...stats.staged];
        const affectedFiles = selectAffectedFiles({ files: allChanges, issuePaths: issue.paths });
        const totals = getCommitTotals(affectedFiles);
        setCommitError(null);
        setCommitMessage("");
        setAssist({
          targetBranchName: res.branchName,
          currentBranchName: res.currentBranchName,
          issue,
          affectedFiles,
          stagePaths: Array.from(
            new Set([...allChanges.map((f) => f.path), ...(issue.paths ?? [])]),
          ),
          fileCount: totals.fileCount,
          totalAdded: totals.totalAdded,
          totalRemoved: totals.totalRemoved,
          identity,
        });
        setAssistStep("blocked");
        return true;
      } catch (err) {
        toast.error(shortError(err));
        return false;
      }
    },
    [workspacePath],
  );

  const handleMutationResult = useCallback(
    async (res: GitBranchMutationResponse) => {
      if (!res.ok) {
        if (await prepareSwitchAssist(res)) return;
        notifyFailure(getPrimaryIssue(res.issues), res);
        return;
      }
      const key = resolveSuccessMessageKey(res);
      if (key && res.branchName) {
        toast.success(fmt(t(key as TranslationKey), { branchName: res.branchName }));
      }
      setOpen(false);
      setCreateOpen(false);
      setCreateName("");
      resetAssist();
      setBranchesResult((cur) =>
        cur
          ? {
              ...cur,
              currentBranchName: res.currentBranchName,
              headDetached: res.currentBranchName === null,
              branches: cur.branches.map((b) => ({
                ...b,
                isCurrent: b.name === res.currentBranchName,
              })),
            }
          : cur,
      );
      // 只在真正变更时广播刷新（Git 面板监听此事件同步）；no-op 不打扰
      if (res.didChange || res.created) {
        window.dispatchEvent(new CustomEvent("reinagent-git-refresh"));
        void loadBranches();
      }
    },
    [loadBranches, notifyFailure, prepareSwitchAssist, resetAssist, t],
  );

  const runMutation = useCallback(
    async (branchName: string, create: boolean) => {
      if (!workspacePath) return;
      setOpen(false);
      setMutationPending(true);
      try {
        const res = await gitBranchSwitch(workspacePath, branchName, create);
        await handleMutationResult(res);
      } catch (err) {
        toast.error(fmt(t("gitBranchErrRequestFailed"), { error: shortError(err) }));
      } finally {
        setMutationPending(false);
      }
    },
    [handleMutationResult, t, workspacePath],
  );

  /** checkpoint 提交 → 自动重试切换（对齐 ZCode commitAndSwitchBranch）。 */
  const commitAndSwitch = useCallback(async () => {
    if (!assist || !workspacePath) return;
    if (!hasCommitIdentity(assist.identity)) {
      setCommitError(t("gitBranchCommitIdentityMissing"));
      return;
    }
    const message = commitMessage.trim() || buildAutoCommitMessage(assist.targetBranchName);
    setCommitError(null);
    setMutationPending(true);
    try {
      if (assist.stagePaths.length > 0) {
        await gitStage(workspacePath, assist.stagePaths);
      }
      await gitCommit(workspacePath, message);
      window.dispatchEvent(new CustomEvent("reinagent-git-refresh"));
      const res = await gitBranchSwitch(workspacePath, assist.targetBranchName, false);
      await handleMutationResult(res);
    } catch (err) {
      setCommitError(fmt(t("gitBranchCommitErrRequestFailed"), { error: shortError(err) }));
    } finally {
      setMutationPending(false);
    }
  }, [assist, commitMessage, handleMutationResult, t, workspacePath]);

  if (!workspacePath) {
    return null;
  }

  // 非 git 仓库：原位显示「初始化 Git 仓库」按钮（git init -b main，成功后变回切换器）
  if (repoState === "nonRepo") {
    return (
      <button
        type="button"
        onClick={() => void handleInit()}
        disabled={initPending}
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] transition-colors select-none disabled:opacity-50"
        title={t("gitBranchInitTitle")}
      >
        {initPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <GitBranch className="h-3.5 w-3.5" />
        )}
        <span className="max-w-[160px] truncate">{t("gitBranchInitAction")}</span>
      </button>
    );
  }

  if (repoState !== "repo") {
    return null;
  }

  const displayedCurrent = branchesResult?.currentBranchName ?? null;
  const triggerLabel = resolveBranchTriggerLabel({
    headDetached: branchesResult?.headDetached ?? false,
    currentBranchName: displayedCurrent,
    detachedLabel: t("gitBranchDetached"),
    fallbackLabel: t("gitBranchSwitcherLabel"),
  });
  const filtered = (branchesResult?.branches ?? []).filter((b) =>
    matchesBranchSearch(b.name, search),
  );

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    listRef.current
      ?.querySelector<HTMLElement>('[data-branch-item]:not([data-disabled="true"])')
      ?.click();
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={mutationPending}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] transition-colors select-none disabled:opacity-50"
            title={t("gitBranchTriggerTitle")}
          >
            <GitBranch className="h-3.5 w-3.5" />
            <span className="max-w-[140px] truncate">{triggerLabel}</span>
            {loadingBranches || mutationPending ? (
              <Loader2 className="h-3 w-3 animate-spin opacity-60" />
            ) : (
              <ChevronDown className="h-3 w-3 opacity-60" />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="bottom"
          sideOffset={6}
          className="w-72 overflow-hidden p-0"
        >
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={t("gitBranchSearchPlaceholder")}
            className="h-8 w-full border-b border-[var(--border)] bg-transparent px-3 text-xs text-[var(--text)] placeholder-[var(--text-dim)] focus:outline-none"
          />
          <div ref={listRef} className="max-h-72 overflow-y-auto p-1">
            <p className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--text-dim)]">
              {t("gitBranchSectionBranches")}
            </p>
            {filtered.length === 0 ? (
              <p className="px-3 py-5 text-xs text-[var(--text-dim)]">
                {loadingBranches ? t("gitBranchLoading") : t("gitBranchEmpty")}
              </p>
            ) : (
              filtered.map((branch) => {
                const isCurrent = branch.name === displayedCurrent;
                return (
                  <button
                    key={branch.name}
                    type="button"
                    data-branch-item
                    data-branch-current={isCurrent ? "true" : undefined}
                    disabled={mutationPending}
                    onClick={() => void runMutation(branch.name, false)}
                    className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50 ${
                      isCurrent ? "bg-[var(--brand-dim)]" : ""
                    }`}
                  >
                    <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--text-dim)]" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-[var(--text)]">
                        {branch.name}
                      </span>
                      {isCurrent && dirtyCount > 0 ? (
                        <span className="block pt-0.5 text-[11px] text-[var(--text-dim)]">
                          {fmt(t("gitBranchCurrentDirty"), { count: dirtyCount })}
                        </span>
                      ) : null}
                    </span>
                    {isCurrent ? (
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--brand)]" />
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
          <div className="border-t border-[var(--border)] p-1">
            <button
              type="button"
              disabled={mutationPending}
              onClick={() => {
                setOpen(false);
                setCreateName("");
                setCreateOpen(true);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5 text-[var(--text-dim)]" />
              {t("gitBranchCreateAction")}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                openCodeViewer({ type: "git", title: workspacePath });
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)]"
            >
              <GitGraph className="h-3.5 w-3.5 text-[var(--text-dim)]" />
              {t("gitBranchGraphAction")}
            </button>
          </div>
        </PopoverContent>
      </Popover>

      {/* 创建并检出新分支 */}
      <Dialog
        open={createOpen}
        onOpenChange={(next) => {
          setCreateOpen(next);
          if (!next) setCreateName("");
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("gitBranchCreateTitle")}</DialogTitle>
            <DialogDescription>{t("gitBranchCreateDesc")}</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              if (createName.trim()) void runMutation(createName.trim(), true);
            }}
          >
            <DialogBody>
              <label className="mb-1.5 block text-xs font-medium text-[var(--text-dim)]">
                {t("gitBranchCreateNameLabel")}
              </label>
              <Input
                autoFocus
                value={createName}
                disabled={mutationPending}
                placeholder={t("gitBranchCreatePlaceholder")}
                onChange={(e) => setCreateName(e.target.value)}
              />
              <p className="mt-1.5 text-xs text-[var(--text-dim)]">
                {t("gitBranchCreateHelper")}
              </p>
            </DialogBody>
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setCreateOpen(false)}
                disabled={mutationPending}
              >
                {t("cancel")}
              </Button>
              <Button type="submit" size="sm" disabled={mutationPending || !createName.trim()}>
                {mutationPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                {t("gitBranchCreateConfirm")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 切换助手 · 第一步：受影响文件 */}
      <Dialog
        open={assistStep === "blocked" && !!assist}
        onOpenChange={(next) => {
          if (!next) resetAssist();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("gitBranchBlockedTitle")}</DialogTitle>
            <DialogDescription>
              {assist?.issue.code === "untracked-changes-would-be-overwritten"
                ? t("gitBranchBlockedDescUntracked")
                : t("gitBranchBlockedDescTracked")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div
              className="mb-3 flex items-start gap-2 rounded-lg border p-3 text-xs"
              style={{
                background: "var(--warn-bg)",
                borderColor: "var(--warn-border)",
                color: "var(--warn-text)",
              }}
            >
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <p>{t("gitBranchBlockedHelper")}</p>
            </div>
            <div className="rounded-lg border border-[var(--border)]">
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-xs font-medium text-[var(--text)]">
                  {t("gitBranchBlockedFiles")}
                </span>
                <span className="text-xs text-[var(--text-dim)]">
                  {fmt(t("gitBranchChangesCount"), { count: assist?.fileCount ?? 0 })}
                </span>
              </div>
              <div className="max-h-56 space-y-1 overflow-y-auto p-1">
                {(assist?.affectedFiles ?? []).map((file) => (
                  <div
                    key={file.path}
                    className="flex h-9 items-center justify-between gap-3 rounded-md bg-[var(--bg-elev-2)] px-2.5"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--text)]">
                      {file.path}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px]">
                      <span className="text-emerald-500">+{file.added}</span>
                      <span className="text-red-500">-{file.removed}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" size="sm" onClick={resetAssist} disabled={mutationPending}>
              {t("cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setCommitError(null);
                setAssistStep("commit");
              }}
              disabled={mutationPending}
            >
              {t("gitBranchBlockedSubmit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 切换助手 · 第二步：checkpoint 提交 */}
      <Dialog
        open={assistStep === "commit" && !!assist}
        onOpenChange={(next) => {
          if (!next) resetAssist();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("gitBranchCommitTitle")}</DialogTitle>
            <DialogDescription>
              {fmt(t("gitBranchCommitDesc"), { branchName: assist?.targetBranchName ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              void commitAndSwitch();
            }}
          >
            <DialogBody>
              <div className="rounded-lg border border-[var(--border)]">
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-xs font-medium text-[var(--text)]">
                    {t("gitBranchCommitCurrentBranch")}
                  </span>
                  <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--text)]">
                    <GitBranch className="h-3.5 w-3.5 text-[var(--text-dim)]" />
                    {assist?.currentBranchName ?? t("gitBranchSwitcherLabel")}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-[var(--border)] px-3 py-2 text-xs">
                  <span className="font-medium text-[var(--text)]">
                    {t("gitBranchCommitChanges")}
                  </span>
                  <span className="flex gap-2">
                    <span className="text-[var(--text-dim)]">
                      {fmt(t("gitBranchChangesCount"), { count: assist?.fileCount ?? 0 })}
                    </span>
                    <span className="font-mono text-emerald-500">
                      +{assist?.totalAdded ?? 0}
                    </span>
                    <span className="font-mono text-red-500">
                      -{assist?.totalRemoved ?? 0}
                    </span>
                  </span>
                </div>
              </div>

              {assist && !hasCommitIdentity(assist.identity) ? (
                <div
                  className="mt-3 flex items-start gap-2 rounded-lg border p-3 text-xs"
                  style={{
                    background: "var(--warn-bg)",
                    borderColor: "var(--warn-border)",
                    color: "var(--warn-text)",
                  }}
                >
                  <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <p>{t("gitBranchCommitIdentityMissing")}</p>
                </div>
              ) : null}

              <label className="mb-1.5 mt-3 block text-xs font-medium text-[var(--text-dim)]">
                {t("gitBranchCommitMsgLabel")}
              </label>
              <Textarea
                value={commitMessage}
                disabled={mutationPending}
                placeholder={buildAutoCommitMessage(assist?.targetBranchName ?? "")}
                onChange={(e) => setCommitMessage(e.target.value)}
                className="min-h-24"
              />
              <p className="mt-1.5 text-xs text-[var(--text-dim)]">
                {t("gitBranchCommitMsgHelper")}
              </p>

              {commitError ? (
                <p className="mt-2 text-xs" style={{ color: "var(--danger)" }}>
                  {commitError}
                </p>
              ) : null}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="secondary" size="sm" onClick={resetAssist} disabled={mutationPending}>
                {t("cancel")}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={mutationPending || (assist ? !hasCommitIdentity(assist.identity) && assist.identity !== null : false)}
              >
                {mutationPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                {t("gitBranchCommitConfirm")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
