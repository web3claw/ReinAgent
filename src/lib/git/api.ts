/**
 * Git 面板 API（P2-D）：封装 Rust git_panel 命令。
 */

import { invoke } from "@tauri-apps/api/core";

export interface GitStatusEntry {
  code: string;
  path: string;
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
