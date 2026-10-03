/**
 * Git 面板 API（P2-D）：封装 Rust git_panel 命令。
 */

import { invoke } from "@tauri-apps/api/core";

export interface GitStatusEntry {
  code: string;
  path: string;
  /** index 位（X）：' '=无暂存变更；untracked 为 '?' */
  indexCode: string;
  /** worktree 位（Y）：' '=无工作区变更；untracked 为 '?' */
  worktreeCode: string;
}

export interface GitStatusResponse {
  entries: GitStatusEntry[];
  branch: string;
  isGitRepo: boolean;
}

export interface GitBranch {
  name: string;
  current: boolean;
}

export interface GitBranchListResponse {
  branches: GitBranch[];
  isGitRepo: boolean;
}

export interface GitCommit {
  hash: string;
  author: string;
  timestamp: number;
  subject: string;
  /** 父提交 hash（图谱泳道分配依赖拓扑；根提交为空数组） */
  parents: string[];
}

export interface GitLogResponse {
  commits: GitCommit[];
  isGitRepo: boolean;
}

export function gitStatus(cwd: string) {
  return invoke<GitStatusResponse>("git_status", { cwd });
}

export function gitBranchList(cwd: string) {
  return invoke<GitBranchListResponse>("git_branch_list", { cwd });
}

export function gitCheckout(cwd: string, branch: string) {
  return invoke<void>("git_checkout", { args: { cwd, branch } });
}

export function gitLog(cwd: string, limit?: number) {
  return invoke<GitLogResponse>("git_log", { args: { cwd, limit: limit ?? 50 } });
}

// ---------------------------------------------------------------------------
// 顶栏分支切换器（对齐 ZCode GitBranchSwitcher 数据面）
// ---------------------------------------------------------------------------

export interface GitLocalBranch {
  name: string;
  isCurrent: boolean;
  upstreamName: string | null;
  commitHash: string | null;
  commitTimestampMs: number | null;
}

export interface GitBranchListV2Response {
  branches: GitLocalBranch[];
  /** 当前分支名；null = detached HEAD（或非 git 仓库） */
  currentBranchName: string | null;
  headDetached: boolean;
  isGitRepo: boolean;
}

/** 稳定归因码（对齐 ZCode GitBranchMutationIssueCode） */
export type GitBranchIssueCode =
  | "tracked-changes-would-be-overwritten"
  | "untracked-changes-would-be-overwritten"
  | "branch-already-exists"
  | "target-branch-not-found"
  | "branch-in-other-worktree"
  | "conflicts-present"
  | "operation-in-progress"
  | "invalid-branch-name"
  | "unknown";

export interface GitBranchIssue {
  code: GitBranchIssueCode | string;
  message: string;
  /** 受影响文件路径（overwrite 类 issue 携带） */
  paths?: string[];
  /** git 原始输出（如实保留） */
  detail?: string;
}

export interface GitBranchMutationResponse {
  ok: boolean;
  action: "switch" | "create-and-switch";
  branchName: string | null;
  didChange: boolean;
  created: boolean;
  /** 操作后（或失败时当前）分支名；null = detached */
  currentBranchName: string | null;
  issues: GitBranchIssue[];
}

export interface GitNumStatFile {
  path: string;
  added: number;
  removed: number;
}

export interface GitNumStatResponse {
  /** 已暂存（index vs HEAD）逐文件 +/- 行数 */
  staged: GitNumStatFile[];
  /** 未暂存（worktree vs index）逐文件 +/- 行数 */
  unstaged: GitNumStatFile[];
  isGitRepo: boolean;
}

export interface GitIdentityResponse {
  userName: string | null;
  userEmail: string | null;
}

export function gitBranchListV2(cwd: string) {
  return invoke<GitBranchListV2Response>("git_branch_list_v2", { cwd });
}

/** 切换/创建并切换分支；失败不抛异常，返回 ok=false + 结构化 issues。 */
export function gitBranchSwitch(cwd: string, branchName: string, create = false) {
  return invoke<GitBranchMutationResponse>("git_branch_switch", {
    args: { cwd, branchName, create },
  });
}

/** 工作区 + 暂存合并的逐文件 +/- 行数。 */
export function gitNumstat(cwd: string) {
  return invoke<GitNumStatResponse>("git_numstat", { cwd });
}

export function gitIdentity(cwd: string) {
  return invoke<GitIdentityResponse>("git_identity", { cwd });
}

export interface GitStageResponse {
  /** 传入但 stage 时已不存在（被其它工具删除/改名）而跳过的路径 */
  skipped: string[];
}

/** 批量 stage；消失的路径跳过并在返回值中如实列出（不静默）。 */
export function gitStage(cwd: string, paths: string[]) {
  return invoke<GitStageResponse>("git_stage", { args: { cwd, paths } });
}

export function gitCommit(cwd: string, message: string) {
  return invoke<void>("git_commit", { args: { cwd, message } });
}

/** 初始化 git 仓库（git init -b main）。已是有仓库时 git 原生报错如实上抛。 */
export function gitInit(cwd: string) {
  return invoke<void>("git_init", { cwd });
}

export interface GitPushResponse {
  ok: boolean;
  branchName: string | null;
  /** 是否本次设置了 upstream（首次推送新分支） */
  setUpstream: boolean;
  /** git 原始输出（失败时为 stderr 原文） */
  detail: string | null;
}

/** 推送当前分支；失败不抛异常，返回 ok=false + git 原文。 */
export function gitPush(cwd: string) {
  return invoke<GitPushResponse>("git_push", { cwd });
}

/** 整仓 diff 原文（✨AI 提交信息输入；调用方截断）。 */
export function gitDiffPatch(cwd: string, staged: boolean) {
  return invoke<string>("git_diff_patch", { args: { cwd, staged } });
}
