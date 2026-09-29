//! Git 面板命令（P2-D，spawn git CLI——不引入 git2 依赖）。
//!
//! - `git_status`：工作区变更列表（porcelain v1 逐行解析）
//! - `git_branch_list`：本地分支 + 当前分支
//! - `git_checkout`：切换分支（失败如实上抛，含工作区脏时的 git 拒绝原文）
//! - `git_log`：提交历史（hash/author/date/subject）
//!
//! 全部 spawn_blocking；工作目录由调用方传入（当前任务工作区根）；
//! 非 git 仓库（exit 128 且输出含 "not a git repository"）→ 结构化 GitNotRepo
//! 错误字符串前缀，前端据此显示「非 git 仓库」空态。

use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    /// porcelain 状态码（如 "M", "??", "A "）
    pub code: String,
    pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub author: String,
    /// Unix 秒
    pub timestamp: i64,
    pub subject: String,
    /// 父提交 hash（%P，空格分隔；根提交为空）——提交图谱泳道分配依赖拓扑
    #[serde(default)]
    pub parents: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusResponse {
    pub entries: Vec<GitStatusEntry>,
    pub branch: String,
    pub is_git_repo: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchListResponse {
    pub branches: Vec<GitBranch>,
    pub is_git_repo: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogResponse {
    pub commits: Vec<GitCommit>,
    pub is_git_repo: bool,
}

fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git 启动失败（未安装或不在 PATH）：{e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        let combined = format!("{stdout}{stderr}");
        if combined.contains("not a git repository") {
            return Err("GIT_NOT_REPO".to_string());
        }
        return Err(format!("git {} 失败：{}", args.first().unwrap_or(&""), combined.trim()));
    }
    Ok(stdout)
}

fn is_not_repo_error(err: &str) -> bool {
    err == "GIT_NOT_REPO"
}

#[tauri::command]
pub async fn git_status(cwd: String) -> Result<GitStatusResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let porcelain = match run_git(&cwd, &["status", "--porcelain=v1", "-b"]) {
            Ok(out) => out,
            Err(e) if is_not_repo_error(&e) => {
                return Ok(GitStatusResponse { entries: vec![], branch: String::new(), is_git_repo: false });
            }
            Err(e) => return Err(e),
        };
        let mut entries = Vec::new();
        let mut branch = String::new();
        for line in porcelain.lines() {
            if let Some(rest) = line.strip_prefix("## ") {
                // "## main...origin/main [ahead 1]" → main
                branch = rest
                    .split("...")
                    .next()
                    .unwrap_or(rest)
                    .trim()
                    .to_string();
                continue;
            }
            if line.len() < 4 {
                continue;
            }
            let code = line[..2].trim().to_string();
            let path = line[3..].trim().to_string();
            if code.is_empty() || path.is_empty() {
                continue;
            }
            entries.push(GitStatusEntry { code, path });
        }
        Ok(GitStatusResponse { entries, branch, is_git_repo: true })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_branch_list(cwd: String) -> Result<GitBranchListResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = match run_git(&cwd, &["branch", "--list"]) {
            Ok(out) => out,
            Err(e) if is_not_repo_error(&e) => {
                return Ok(GitBranchListResponse { branches: vec![], is_git_repo: false });
            }
            Err(e) => return Err(e),
        };
        let mut branches = Vec::new();
        for line in out.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let (current, name) = if let Some(name) = trimmed.strip_prefix("* ") {
                (true, name.trim().to_string())
            } else {
                (false, trimmed.to_string())
            };
            if name.is_empty() {
                continue;
            }
            branches.push(GitBranch { name, current });
        }
        Ok(GitBranchListResponse { branches, is_git_repo: true })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
pub struct GitCheckoutArgs {
    pub cwd: String,
    pub branch: String,
}

/// 切换分支：分支名做白名单字符校验（防注入——git CLI 无 shell，但引用路径仍收敛）。
#[tauri::command]
pub async fn git_checkout(args: GitCheckoutArgs) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let branch = args.branch.trim();
        if branch.is_empty()
            || branch.len() > 200
            || branch.chars().any(|c| {
                !(c.is_ascii_alphanumeric() || "/-_.+".contains(c))
            })
        {
            return Err(format!("git_checkout: 非法分支名 {branch}"));
        }
        run_git(&args.cwd, &["checkout", branch]).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
pub struct GitLogArgs {
    pub cwd: String,
    pub limit: Option<i64>,
}

#[tauri::command]
pub async fn git_log(args: GitLogArgs) -> Result<GitLogResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let limit = args.limit.unwrap_or(50).clamp(1, 200);
        let format = "%H%x1f%an%x1f%ct%x1f%s%x1f%P";
        let out = match run_git(
            &args.cwd,
            &["log", &format!("--pretty=format:{format}"), &format!("-{limit}")],
        ) {
            Ok(out) => out,
            Err(e) if is_not_repo_error(&e) => {
                return Ok(GitLogResponse { commits: vec![], is_git_repo: false });
            }
            Err(e) => return Err(e),
        };
        let mut commits = Vec::new();
        for line in out.lines() {
            let parts: Vec<&str> = line.split('\u{1f}').collect();
            if parts.len() < 4 {
                continue;
            }
            commits.push(GitCommit {
                hash: parts[0].to_string(),
                author: parts[1].to_string(),
                timestamp: parts[2].parse::<i64>().unwrap_or(0),
                subject: parts[3].to_string(),
                parents: parts
                    .get(4)
                    .map(|p| p.split_whitespace().map(str::to_string).collect())
                    .unwrap_or_default(),
            });
        }
        Ok(GitLogResponse { commits, is_git_repo: true })
    })
    .await
    .map_err(|e| e.to_string())?
}
