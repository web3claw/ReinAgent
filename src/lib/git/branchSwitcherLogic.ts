/**
 * 分支切换器纯逻辑（对齐 ZCode git-branch-switcher/display.ts）：
 * 触发器文案 / 搜索过滤 / issue → i18n key / 成功 toast 选择 / 路径截断 /
 * checkpoint 自动提交信息。与 UI 解耦，可直接 node --test。
 */

import type {
  GitBranchIssue,
  GitBranchMutationResponse,
  GitLocalBranch,
  GitNumStatFile,
} from "./api";

export interface BranchAssistFile {
  /** 仓库相对路径（用作 stage 路径） */
  path: string;
  added: number;
  removed: number;
}

/** 触发器文案：detached 优先，空分支名回退「分支」。 */
export function resolveBranchTriggerLabel(options: {
  headDetached: boolean;
  currentBranchName: string | null;
  detachedLabel: string;
  fallbackLabel: string;
}): string {
  if (options.headDetached) {
    return options.detachedLabel;
  }
  const normalized = options.currentBranchName?.trim() ?? "";
  return normalized.length > 0 ? normalized : options.fallbackLabel;
}

/** 大小写不敏感的 includes 过滤（对齐 matchesGitBranchSearch）。 */
export function matchesBranchSearch(branchName: string, searchText: string): boolean {
  const normalized = searchText.trim().toLocaleLowerCase();
  if (normalized.length === 0) {
    return true;
  }
  return branchName.trim().toLocaleLowerCase().includes(normalized);
}

export function getPrimaryIssue(issues: readonly GitBranchIssue[]): GitBranchIssue | null {
  return issues[0] ?? null;
}

/** overwrite 型阻塞走「切换助手」弹窗（先 checkpoint 提交再重试），其余直接 toast。 */
export function isCommitAssistIssue(code: string | undefined): boolean {
  return (
    code === "tracked-changes-would-be-overwritten" ||
    code === "untracked-changes-would-be-overwritten"
  );
}

/** issue → i18n key（返回我们扁平化的 key 名；未知码返回 null 走 detail 兜底）。 */
export function resolveIssueMessageKey(issue: GitBranchIssue | null): string | null {
  switch (issue?.code) {
    case "invalid-branch-name":
      return "gitBranchErrInvalidName";
    case "branch-already-exists":
      return "gitBranchErrAlreadyExists";
    case "target-branch-not-found":
      return "gitBranchErrNotFound";
    case "tracked-changes-would-be-overwritten":
      return "gitBranchErrTrackedOverwrite";
    case "untracked-changes-would-be-overwritten":
      return "gitBranchErrUntrackedOverwrite";
    case "conflicts-present":
      return "gitBranchErrConflicts";
    case "operation-in-progress":
      return "gitBranchErrOperationInProgress";
    case "branch-in-other-worktree":
      return "gitBranchErrOtherWorktree";
    default:
      return null;
  }
}

/** 成功 toast：no-op 不弹；创建弹「已创建」，切换弹「已切换」。 */
export function resolveSuccessMessageKey(
  result: Pick<GitBranchMutationResponse, "action" | "created" | "didChange">,
): string | null {
  if (!result.didChange) {
    return null;
  }
  if (result.action === "create-and-switch" || result.created) {
    return "gitBranchToastCreateSuccess";
  }
  return "gitBranchToastSwitchSuccess";
}

/** toast 里路径列表最多展示 2 个，剩余计数进「等 N 个文件」。 */
export function summarizeIssuePaths(paths: readonly string[] | undefined, limit = 2): {
  visiblePaths: string[];
  remainingCount: number;
} {
  const normalized = (paths ?? []).filter((p) => p.trim().length > 0);
  return {
    visiblePaths: normalized.slice(0, limit),
    remainingCount: Math.max(0, normalized.length - limit),
  };
}

/**
 * 阻塞弹窗受影响文件：issue paths 为主序，行数从 numstat 合并表取
 * （对齐 selectGitBranchAffectedFiles；不在表中的路径按 0/0 占位）。
 */
export function selectAffectedFiles(options: {
  files: readonly GitNumStatFile[];
  issuePaths: readonly string[] | undefined;
}): BranchAssistFile[] {
  const byPath = new Map(options.files.map((f) => [f.path, f] as const));
  const normalized = (options.issuePaths ?? []).filter((p) => p.trim().length > 0);
  return normalized.map((path) => {
    const found = byPath.get(path);
    return { path, added: found?.added ?? 0, removed: found?.removed ?? 0 };
  });
}

export function getCommitTotals(files: readonly BranchAssistFile[]): {
  fileCount: number;
  totalAdded: number;
  totalRemoved: number;
} {
  return files.reduce(
    (acc, file) => {
      acc.fileCount += 1;
      acc.totalAdded += file.added;
      acc.totalRemoved += file.removed;
      return acc;
    },
    { fileCount: 0, totalAdded: 0, totalRemoved: 0 },
  );
}

/** checkpoint 自动提交信息（对齐 buildGitBranchAutoCommitMessage）。 */
export function buildAutoCommitMessage(targetBranchName: string): string {
  const normalized = targetBranchName.trim();
  return normalized.length > 0
    ? `chore: checkpoint before switching to ${normalized}`
    : "chore: checkpoint before switching branches";
}

/** 提交身份缺失判断：读不到配置（null identity）时放行由 git 兜底报错。 */
export function hasCommitIdentity(identity: {
  userName: string | null;
  userEmail: string | null;
} | null): boolean {
  return identity === null || (Boolean(identity.userName) && Boolean(identity.userEmail));
}

/** 排序已在 Rust 完成；此处仅做当前分支查找便捷封装（测试用）。 */
export function findCurrentBranch(
  branches: readonly GitLocalBranch[],
): GitLocalBranch | null {
  return branches.find((b) => b.isCurrent) ?? null;
}
