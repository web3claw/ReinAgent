/**
 * PR / MR 面板 API（ROADMAP ⑦）：封装 Rust git_pr 命令。
 * gh（GitHub）/ glab（GitLab）由 Rust 侧按 remote URL 自动选择。
 */

import { invoke } from "@tauri-apps/api/core";

export * from "./prLogic";
import type { GitPrCheck, GitPrComment } from "./prLogic";

export interface GitPrInfo {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  baseBranch: string;
  headBranch: string;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  checks: GitPrCheck[];
}

export interface GitPrStatus {
  isRepo: boolean;
  branch: string;
  remoteUrl: string;
  /** github | gitlab | "" */
  host: string;
  /** gh | glab | "" */
  tool: string;
  toolInstalled: boolean;
  installHint: string;
  /** no-remote / unsupported-host / CLI 错误首行（空 = 正常） */
  message: string;
  baseBranch: string;
  branchPushed: boolean;
  pr: GitPrInfo | null;
  openPrs: GitPrInfo[];
}

export interface GitPrFeedback {
  hasPr: boolean;
  number: number;
  title: string;
  url: string;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** 仅 fail / pending / cancel */
  checks: GitPrCheck[];
  comments: GitPrComment[];
  logExcerpt: string | null;
}

export interface GitPrCreateArgs {
  cwd: string;
  title: string;
  body: string;
  baseBranch?: string | null;
  draft: boolean;
}

export interface GitPrActionArgs {
  cwd: string;
  /** ready | draft | merge | close | reopen */
  action: string;
  /** merge | squash | rebase */
  mergeMethod?: string | null;
  deleteBranch?: boolean;
}

export interface GitPrCommandResult {
  success: boolean;
  output: string;
  status: GitPrStatus;
}

/** 一站式 PR 状态（环境缺失以结构化字段回传，不抛异常）。 */
export function gitPrStatus(cwd: string) {
  return invoke<GitPrStatus>("git_pr_status", { cwd });
}

export function gitPrCreate(args: GitPrCreateArgs) {
  return invoke<GitPrCommandResult>("git_pr_create", { args });
}

export function gitPrAction(args: GitPrActionArgs) {
  return invoke<GitPrCommandResult>("git_pr_action", { args });
}

export function gitPrFeedback(cwd: string) {
  return invoke<GitPrFeedback>("git_pr_feedback", { cwd });
}

