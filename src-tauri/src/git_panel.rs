//! Git 面板命令（P2-D，spawn git CLI——不引入 git2 依赖）。
//!
//! - `git_status`：工作区变更列表（porcelain v1 逐行解析）
//! - `git_branch_list`：本地分支 + 当前分支
//! - `git_checkout`：切换分支（失败如实上抛，含工作区脏时的 git 拒绝原文）
//! - `git_log`：提交历史（hash/author/date/subject）
//! - `git_branch_switch` / `git_branch_create`：顶栏分支切换器（对齐 ZCode
//!   GitBranchSwitcher：选择即检出、结构化 issue 归因而非裸 stderr）
//! - `git_numstat`：工作区+暂存变更的行数统计（切换助手弹窗受影响文件 +/-）
//! - `git_identity` / `git_stage` / `git_commit`：checkpoint 提交流程
//!
//! 全部 spawn_blocking；工作目录由调用方传入（当前任务工作区根）；
//! 非 git 仓库（exit 128 且输出含 "not a git repository"）→ 结构化 GitNotRepo
//! 错误字符串前缀，前端据此显示「非 git 仓库」空态。

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    /// porcelain 状态码（如 "M", "??", "A "）
    pub code: String,
    pub path: String,
    /// index 位（X）：' '=无暂存变更；untracked 为 '?'
    pub index_code: String,
    /// worktree 位（Y）：' '=无工作区变更；untracked 为 '?'
    pub worktree_code: String,
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
        // 大小写不敏感：仓库外 `git diff` 输出的是 "Not a git repository"（大写 N），
        // 与 status/log 的 "fatal: not a git repository" 大小写不同，漏判会把整屏
        // usage 帮助当错误抛给前端。
        if combined.to_lowercase().contains("not a git repository") {
            return Err("GIT_NOT_REPO".to_string());
        }
        return Err(format!("git {} 失败：{}", args.first().unwrap_or(&""), combined.trim()));
    }
    Ok(stdout)
}

pub fn is_not_repo_error(err: &str) -> bool {
    // 兜底再兜一层原始文案（防御绕过 run_git 的调用路径）
    err == "GIT_NOT_REPO" || err.to_lowercase().contains("not a git repository")
}

#[tauri::command]
pub async fn git_status(cwd: String) -> Result<GitStatusResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // -uall：untracked 目录展开成具体文件（对齐 ZCode 变更列表逐文件展示，不折叠成目录行）
        let porcelain = match run_git(&cwd, &["status", "--porcelain=v1", "-b", "-uall"]) {
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
                // "## main...origin/main [ahead 1]" → main；无提交仓库为 "No commits yet on main" → main
                let head = rest
                    .strip_prefix("No commits yet on ")
                    .unwrap_or(rest);
                branch = head
                    .split("...")
                    .next()
                    .unwrap_or(head)
                    .trim()
                    .to_string();
                continue;
            }
            if line.len() < 4 {
                continue;
            }
            let xy = &line[..2];
            let code = xy.trim().to_string();
            let path = line[3..].trim().to_string();
            if code.is_empty() || path.is_empty() {
                continue;
            }
            entries.push(GitStatusEntry {
                code,
                path,
                index_code: xy[0..1].to_string(),
                worktree_code: xy[1..2].to_string(),
            });
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
            // 全新仓库（git init 后还没有任何提交）：空历史而非错误（对齐 ZCode getCommitGraph）
            Err(e)
                if e.contains("does not have any commits yet")
                    || e.contains("bad default revision")
                    || e.contains("ambiguous argument 'HEAD'") =>
            {
                return Ok(GitLogResponse { commits: vec![], is_git_repo: true });
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

// ---------------------------------------------------------------------------
// 顶栏分支切换器（对齐 ZCode GitBranchSwitcher + gitCliRepo）
// ---------------------------------------------------------------------------

/// 进行中的 merge/rebase/cherry-pick/revert/bisect 标记位（对齐 ZCode GIT_OPERATION_MARKERS）。
const GIT_OPERATION_MARKERS: [&str; 7] = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "REBASE_HEAD",
    "rebase-merge",
    "rebase-apply",
    "BISECT_LOG",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLocalBranch {
    pub name: String,
    pub is_current: bool,
    pub upstream_name: Option<String>,
    pub commit_hash: Option<String>,
    /// 毫秒时间戳（for-each-ref committerdate:unix × 1000；解析失败为 None）
    pub commit_timestamp_ms: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchListV2Response {
    pub branches: Vec<GitLocalBranch>,
    /// 当前分支名；None = detached HEAD（或非 git 仓库）
    pub current_branch_name: Option<String>,
    pub head_detached: bool,
    pub is_git_repo: bool,
}

/// 当前分支名（`git branch --show-current`；空输出 = detached HEAD）。
fn read_current_branch(cwd: &str) -> Result<Option<String>, String> {
    let out = run_git(cwd, &["branch", "--show-current"])?;
    let trimmed = out.trim();
    if trimmed.is_empty() {
        Ok(None)
    } else {
        Ok(Some(trimmed.to_string()))
    }
}

/// 进行中的 git 操作探测：`rev-parse --git-path <marker>` 逐行回路径，存在即为真。
fn has_operation_in_progress(cwd: &str) -> Result<bool, String> {
    let mut args: Vec<&str> = vec!["rev-parse"];
    for marker in GIT_OPERATION_MARKERS.iter() {
        args.push("--git-path");
        args.push(marker);
    }
    let out = run_git(cwd, &args)?;
    let base = Path::new(cwd);
    for line in out.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let p = Path::new(trimmed);
        let resolved = if p.is_absolute() { p.to_path_buf() } else { base.join(trimmed) };
        if resolved.exists() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// porcelain v1 未合并态（UU/AA/DD 等含 U 或双字母冲突码）。
pub fn has_conflicted_entries(entries: &[GitStatusEntry]) -> bool {
    entries.iter().any(|e| {
        matches!(e.code.as_str(), "UU" | "AA" | "DD" | "AU" | "UA" | "DU" | "UD" | "UX" | "XU")
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchIssue {
    /// 稳定归因码（对齐 ZCode GitBranchMutationIssueCode）：
    /// tracked/untracked-changes-would-be-overwritten | branch-already-exists |
    /// target-branch-not-found | branch-in-other-worktree | conflicts-present |
    /// operation-in-progress | invalid-branch-name | unknown
    pub code: String,
    pub message: String,
    /// 受影响文件路径（overwrite 类 issue 携带）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paths: Option<Vec<String>>,
    /// git 原始输出（如实保留，UI 兜底展示）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchMutationResponse {
    pub ok: bool,
    /// "switch" | "create-and-switch"
    pub action: String,
    pub branch_name: Option<String>,
    pub did_change: bool,
    pub created: bool,
    /// 操作后（或失败时当前）分支名；None = detached
    pub current_branch_name: Option<String>,
    pub issues: Vec<GitBranchIssue>,
}

fn invalid_branch_issue(detail: Option<String>) -> GitBranchIssue {
    GitBranchIssue {
        code: "invalid-branch-name".to_string(),
        message: "Branch name is invalid.".to_string(),
        paths: None,
        detail,
    }
}

/// git check-ref-format --branch 校验分支名（对齐 ZCode validateBranchName）。
fn validate_branch_name(cwd: &str, name: &str) -> Result<Option<GitBranchIssue>, String> {
    let output = Command::new("git")
        .args(["check-ref-format", "--branch", name])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git 启动失败（未安装或不在 PATH）：{e}"))?;
    if output.status.success() {
        return Ok(None);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Ok(Some(invalid_branch_issue(if stderr.is_empty() { None } else { Some(stderr) })))
}

/// 提取 stderr 中缩进列出的受影响文件路径（对齐 ZCode extractIndentedPaths）。
pub fn extract_indented_paths(lines: &[&str], header: &str) -> Vec<String> {
    let header_lower = header.to_lowercase();
    let header_index = match lines.iter().position(|line| line.to_lowercase().contains(&header_lower)) {
        Some(i) => i,
        None => return vec![],
    };
    let mut paths = Vec::new();
    for line in lines.iter().skip(header_index + 1) {
        if line.is_empty() {
            continue;
        }
        if !line.starts_with(' ') && !line.starts_with('\t') {
            break;
        }
        let value = line.trim();
        if !value.is_empty() {
            // Windows git 可能输出反斜杠路径，统一成正斜杠（对齐 normalizeGitPath）
            paths.push(value.replace('\\', "/"));
        }
    }
    paths
}

/// 把 git switch/checkout 的失败输出归一成稳定 issue code（对齐 ZCode parseGitBranchMutationIssues）。
pub fn parse_branch_mutation_issues(stderr: &str, stdout: &str) -> Vec<GitBranchIssue> {
    let detail = {
        let s = stderr.trim();
        if s.is_empty() { stdout.trim() } else { s }
    }
    .to_string();
    let normalized = detail.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.lines().collect();
    let lower = detail.to_lowercase();

    let tracked = extract_indented_paths(
        &lines,
        "your local changes to the following files would be overwritten by",
    );
    if !tracked.is_empty() {
        return vec![GitBranchIssue {
            code: "tracked-changes-would-be-overwritten".to_string(),
            message: "Tracked changes would be overwritten by switching branches.".to_string(),
            paths: Some(tracked),
            detail: Some(detail),
        }];
    }

    let untracked = extract_indented_paths(
        &lines,
        "the following untracked working tree files would be overwritten by",
    );
    if !untracked.is_empty() {
        return vec![GitBranchIssue {
            code: "untracked-changes-would-be-overwritten".to_string(),
            message: "Untracked files would be overwritten by switching branches.".to_string(),
            paths: Some(untracked),
            detail: Some(detail),
        }];
    }

    let code = if lower.contains("already exists") {
        "branch-already-exists"
    } else if lower.contains("invalid reference:") {
        "target-branch-not-found"
    } else if lower.contains("is already used by worktree at") {
        "branch-in-other-worktree"
    } else if lower.contains("resolve your current index first") {
        "conflicts-present"
    } else if lower.contains("cannot switch branch while merging")
        || lower.contains("cannot switch branch while rebasing")
        || lower.contains("cannot switch branch while cherry-picking")
        || lower.contains("cannot switch branch while reverting")
        || lower.contains("cannot switch branch while bisecting")
        || lower.contains("you have not concluded your merge")
        || lower.contains("rebase in progress")
    {
        "operation-in-progress"
    } else {
        "unknown"
    };

    vec![GitBranchIssue {
        code: code.to_string(),
        message: "Git could not complete the branch operation.".to_string(),
        paths: None,
        detail: Some(detail),
    }]
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchSwitchArgs {
    pub cwd: String,
    /// 目标分支名；create=true 时为新建分支名
    pub branch_name: String,
    /// true = `git switch --no-guess -c <name>`（基于当前 HEAD 创建并检出）
    #[serde(default)]
    pub create: bool,
}

/// 切换/创建并切换分支（对齐 ZCode switchBranch / createBranchAndSwitch 的完整前置检查链）。
/// 失败不抛异常：返回 ok=false + 结构化 issues，前端据此弹切换助手或 toast。
#[tauri::command]
pub async fn git_branch_switch(args: GitBranchSwitchArgs) -> Result<GitBranchMutationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = args.cwd.as_str();
        let action = if args.create { "create-and-switch" } else { "switch" };
        let name = args.branch_name.trim().to_string();
        let fail = |issues: Vec<GitBranchIssue>, current: Option<String>| {
            Ok(GitBranchMutationResponse {
                ok: false,
                action: action.to_string(),
                branch_name: if name.is_empty() { None } else { Some(name.clone()) },
                did_change: false,
                created: false,
                current_branch_name: current,
                issues,
            })
        };

        // 非 git 仓库直接报错（结构化前缀，前端 toast 展示）
        let current = read_current_branch(cwd)?;
        if has_conflicted_entries(&git_status_entries(cwd)?) {
            return fail(
                vec![GitBranchIssue {
                    code: "conflicts-present".to_string(),
                    message: "Repository still has unresolved conflicts.".to_string(),
                    paths: None,
                    detail: None,
                }],
                current,
            );
        }
        if has_operation_in_progress(cwd)? {
            return fail(
                vec![GitBranchIssue {
                    code: "operation-in-progress".to_string(),
                    message: "Another Git operation is still in progress.".to_string(),
                    paths: None,
                    detail: None,
                }],
                current,
            );
        }
        if let Some(issue) = validate_branch_name(cwd, &name)? {
            return fail(vec![issue], current);
        }
        // 同分支 no-op（仅切换；create 恒视为变更）
        if !args.create && current.as_deref() == Some(name.as_str()) {
            return Ok(GitBranchMutationResponse {
                ok: true,
                action: "switch".to_string(),
                branch_name: Some(name),
                did_change: false,
                created: false,
                current_branch_name: current,
                issues: vec![],
            });
        }

        let switch_args: Vec<&str> = if args.create {
            vec!["switch", "--no-guess", "-c", &name]
        } else {
            vec!["switch", "--no-guess", &name]
        };
        if let Err(err) = run_git(cwd, &switch_args) {
            if is_not_repo_error(&err) {
                return Err(err);
            }
            // run_git 的错误串带「git switch 失败：」前缀，剥离出真实 git 输出做归因
            let raw = err.splitn(2, '：').nth(1).unwrap_or(&err).to_string();
            return fail(parse_branch_mutation_issues(&raw, ""), current);
        }

        let next_current = read_current_branch(cwd)?;
        Ok(GitBranchMutationResponse {
            ok: true,
            action: action.to_string(),
            branch_name: Some(name),
            did_change: true,
            created: args.create,
            current_branch_name: next_current,
            issues: vec![],
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// porcelain v1 条目（内部辅助：供冲突检测复用 git_status 的解析）。
fn git_status_entries(cwd: &str) -> Result<Vec<GitStatusEntry>, String> {
    let porcelain = run_git(cwd, &["status", "--porcelain=v1", "-b"])?;
    let mut entries = Vec::new();
    for line in porcelain.lines() {
        if line.starts_with("## ") || line.len() < 4 {
            continue;
        }
        let xy = &line[..2];
        let code = xy.trim().to_string();
        let path = line[3..].trim().to_string();
        if code.is_empty() || path.is_empty() {
            continue;
        }
        entries.push(GitStatusEntry {
            code,
            path,
            index_code: xy[0..1].to_string(),
            worktree_code: xy[1..2].to_string(),
        });
    }
    Ok(entries)
}

#[tauri::command]
pub async fn git_branch_list_v2(cwd: String) -> Result<GitBranchListV2Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let current = match read_current_branch(&cwd) {
            Ok(current) => current,
            Err(e) if is_not_repo_error(&e) => {
                return Ok(GitBranchListV2Response {
                    branches: vec![],
                    current_branch_name: None,
                    head_detached: false,
                    is_git_repo: false,
                });
            }
            Err(e) => return Err(e),
        };
        let out = run_git(
            &cwd,
            &[
                "for-each-ref",
                "refs/heads",
                "--format=%(refname:short)%00%(upstream:short)%00%(objectname)%00%(committerdate:unix)",
            ],
        )?;
        let mut branches: Vec<GitLocalBranch> = Vec::new();
        for record in out.split('\n') {
            if record.is_empty() {
                continue;
            }
            let parts: Vec<&str> = record.split('\u{0}').collect();
            if parts.is_empty() || parts[0].is_empty() {
                continue;
            }
            let name = parts[0].to_string();
            let upstream = parts.get(1).filter(|s| !s.is_empty()).map(|s| s.to_string());
            let hash = parts.get(2).filter(|s| !s.is_empty()).map(|s| s.to_string());
            let ts = parts
                .get(3)
                .and_then(|s| s.parse::<i64>().ok())
                .map(|secs| secs * 1000);
            branches.push(GitLocalBranch {
                is_current: current.as_deref() == Some(name.as_str()),
                name,
                upstream_name: upstream,
                commit_hash: hash,
                commit_timestamp_ms: ts,
            });
        }
        // 对齐 ZCode parseBranchRefRecords：当前分支置顶 → 最近提交倒序 → 名称序
        branches.sort_by(|left, right| {
            if left.is_current != right.is_current {
                return if left.is_current { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
            }
            let lt = left.commit_timestamp_ms.unwrap_or(i64::MIN);
            let rt = right.commit_timestamp_ms.unwrap_or(i64::MIN);
            if lt != rt {
                return rt.cmp(&lt);
            }
            left.name.cmp(&right.name)
        });
        let head_detached = current.is_none();
        Ok(GitBranchListV2Response {
            branches,
            current_branch_name: current,
            head_detached,
            is_git_repo: true,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitNumStatFile {
    pub path: String,
    pub added: i64,
    pub removed: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitNumStatResponse {
    /// 已暂存（index vs HEAD）逐文件 +/- 行数
    pub staged: Vec<GitNumStatFile>,
    /// 未暂存（worktree vs index）逐文件 +/- 行数
    pub unstaged: Vec<GitNumStatFile>,
    pub is_git_repo: bool,
}

pub fn parse_numstat(out: &str, files: &mut Vec<GitNumStatFile>) {
    for line in out.lines() {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(3, '\t');
        let added = parts.next().unwrap_or("-").parse::<i64>().unwrap_or(0);
        let removed = parts.next().unwrap_or("-").parse::<i64>().unwrap_or(0);
        let path = match parts.next() {
            Some(p) if !p.is_empty() => p.replace('\\', "/"),
            _ => continue,
        };
        if let Some(existing) = files.iter_mut().find(|f| f.path == path) {
            existing.added += added;
            existing.removed += removed;
        } else {
            files.push(GitNumStatFile { path, added, removed });
        }
    }
}

/// 已暂存/未暂存分开的逐文件 +/- 行数（binary 记 0）。供提交对话框分组与切换助手展示。
#[tauri::command]
pub async fn git_numstat(cwd: String) -> Result<GitNumStatResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let unstaged = match run_git(&cwd, &["diff", "--numstat"]) {
            Ok(out) => out,
            Err(e) if is_not_repo_error(&e) => {
                return Ok(GitNumStatResponse { staged: vec![], unstaged: vec![], is_git_repo: false });
            }
            Err(e) => return Err(e),
        };
        let staged = match run_git(&cwd, &["diff", "--cached", "--numstat"]) {
            Ok(out) => out,
            Err(e) if is_not_repo_error(&e) => {
                return Ok(GitNumStatResponse { staged: vec![], unstaged: vec![], is_git_repo: false });
            }
            Err(e) => return Err(e),
        };
        let mut staged_files = Vec::new();
        parse_numstat(&staged, &mut staged_files);
        let mut unstaged_files = Vec::new();
        parse_numstat(&unstaged, &mut unstaged_files);
        append_untracked_stats(&cwd, &mut unstaged_files);
        staged_files.sort_by(|a, b| a.path.cmp(&b.path));
        unstaged_files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(GitNumStatResponse { staged: staged_files, unstaged: unstaged_files, is_git_repo: true })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// untracked 文件计入未暂存行数（对齐 ZCode buildUntrackedStats：读文件数行，
/// 二进制记 0、单文件超 1MB 记 0；最多统计 200 个防巨仓拖慢，其余保持 0/0）。
fn append_untracked_stats(cwd: &str, files: &mut Vec<GitNumStatFile>) {
    use std::io::Read;
    const MAX_FILES: usize = 200;
    const MAX_BYTES: usize = 1024 * 1024;
    let out = match run_git(cwd, &["ls-files", "--others", "--exclude-standard"]) {
        Ok(out) => out,
        Err(_) => return,
    };
    let base = std::path::Path::new(cwd);
    let mut counted = 0usize;
    for line in out.lines() {
        if line.is_empty() || counted >= MAX_FILES {
            continue;
        }
        let rel = line.replace('\\', "/");
        if files.iter().any(|f| f.path == rel) {
            continue;
        }
        let mut file = match std::fs::File::open(base.join(line.trim())) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let mut buf: Vec<u8> = Vec::new();
        if file.read_to_end(&mut buf).is_err() || buf.len() > MAX_BYTES || buf.contains(&0) {
            continue;
        }
        let mut added = buf.iter().filter(|b| **b == b'\n').count() as i64;
        if let Some(last) = buf.last() {
            if *last != b'\n' {
                added += 1;
            }
        }
        files.push(GitNumStatFile { path: rel, added, removed: 0 });
        counted += 1;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentityResponse {
    pub user_name: Option<String>,
    pub user_email: Option<String>,
}

/// 提交身份（git config user.name / user.email；exit 1 = 未配置 → None）。
#[tauri::command]
pub async fn git_identity(cwd: String) -> Result<GitIdentityResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let read = |key: &str| -> Result<Option<String>, String> {
            let output = Command::new("git")
                .args(["config", "--get", key])
                .current_dir(&cwd)
                .output()
                .map_err(|e| format!("git 启动失败（未安装或不在 PATH）：{e}"))?;
            if output.status.success() {
                let v = String::from_utf8_lossy(&output.stdout).trim().to_string();
                Ok(if v.is_empty() { None } else { Some(v) })
            } else if output.status.code() == Some(1) {
                Ok(None)
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                Err(format!("git config --get {key} 失败：{stderr}"))
            }
        };
        Ok(GitIdentityResponse { user_name: read("user.name")?, user_email: read("user.email")? })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStageArgs {
    pub cwd: String,
    pub paths: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStageResponse {
    /// 传入但在 stage 时已不存在（pathspec 无匹配）而被跳过的路径——如实告知前端，不静默
    pub skipped: Vec<String>,
}

/// 批量 stage（`git add -- <paths>`；`--` 终止选项解析，防路径以 - 开头）。
/// 路径锚定 `:(top,literal)`：status 输出恒为仓库根相对路径，工作区 cwd 可能是仓库
/// 子目录；literal 关闭 glob 防文件名里的 `[]*?` 被当通配符。
/// 快照竞态兜底：status 到 add 之间文件被其它工具删掉时，整批会报
/// "did not match any files"——此时逐个重试并跳过消失的路径（其余照常 stage）。
#[tauri::command]
pub async fn git_stage(args: GitStageArgs) -> Result<GitStageResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if args.paths.is_empty() {
            return Ok(GitStageResponse { skipped: vec![] });
        }
        let anchored: Vec<String> = args
            .paths
            .iter()
            .map(|p| format!(":(top,literal){}", p.replace('\\', "/")))
            .collect();
        let mut cmd_args: Vec<&str> = vec!["add", "--"];
        for p in &anchored {
            cmd_args.push(p);
        }
        match run_git(&args.cwd, &cmd_args) {
            Ok(_) => Ok(GitStageResponse { skipped: vec![] }),
            Err(e) if e.contains("did not match any files") || e.contains("pathspec") => {
                let mut skipped = Vec::new();
                for (index, path) in anchored.iter().enumerate() {
                    let one = ["add", "--", path.as_str()];
                    if run_git(&args.cwd, &one).is_err() {
                        skipped.push(args.paths[index].clone());
                    }
                }
                Ok(GitStageResponse { skipped })
            }
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitArgs {
    pub cwd: String,
    pub message: String,
}

/// 提交已暂存更改（`git commit -m <message>`；空信息直接拒绝）。
#[tauri::command]
pub async fn git_commit(args: GitCommitArgs) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let message = args.message.trim();
        if message.is_empty() {
            return Err("git_commit: 提交信息不能为空".to_string());
        }
        run_git(&args.cwd, &["commit", "-m", message]).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 初始化 git 仓库（`git init -b main`，用户拍板固定 main；目录已是有仓库时 git 原生报错如实上抛）。
#[tauri::command]
pub async fn git_init(cwd: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_git(&cwd, &["init", "-b", "main"]).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushResponse {
    pub ok: bool,
    pub branch_name: Option<String>,
    /// 是否本次设置了 upstream（首次推送新分支）
    pub set_upstream: bool,
    /// git 原始输出（失败时为 stderr 原文，如实展示）
    pub detail: Option<String>,
}

/// 推送当前分支（对齐 ZCode push：有 upstream 直接 `git push`，否则 `git push
/// --set-upstream origin <branch>`；detached HEAD 拒绝）。失败返回 ok=false + git 原文。
#[tauri::command]
pub async fn git_push(cwd: String) -> Result<GitPushResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let branch = read_current_branch(&cwd)?;
        let branch = match branch {
            Some(b) => b,
            None => {
                return Ok(GitPushResponse {
                    ok: false,
                    branch_name: None,
                    set_upstream: false,
                    detail: Some("detached HEAD：当前不处于任何分支，无法推送".to_string()),
                });
            }
        };
        // upstream 探测：@{u} 可解析 → 直接 push；否则 --set-upstream origin <branch>
        let has_upstream = run_git(&cwd, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).is_ok();
        let (args, set_upstream): (Vec<&str>, bool) = if has_upstream {
            (vec!["push"], false)
        } else {
            (vec!["push", "--set-upstream", "origin", &branch], true)
        };
        match run_git(&cwd, &args) {
            Ok(_) => Ok(GitPushResponse {
                ok: true,
                branch_name: Some(branch),
                set_upstream,
                detail: None,
            }),
            Err(e) if is_not_repo_error(&e) => Err(e),
            Err(e) => {
                let raw = e.splitn(2, '：').nth(1).unwrap_or(&e).to_string();
                Ok(GitPushResponse {
                    ok: false,
                    branch_name: Some(branch),
                    set_upstream: false,
                    detail: Some(raw),
                })
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffPatchArgs {
    pub cwd: String,
    /// true = 已暂存 diff（HEAD vs index），false = 未暂存（index vs worktree）
    #[serde(default)]
    pub staged: bool,
}

/// 整仓 diff 原文（✨AI 生成提交信息的输入；调用方自行截断防超长）。
#[tauri::command]
pub async fn git_diff_patch(args: GitDiffPatchArgs) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cmd: Vec<&str> = if args.staged {
            vec!["diff", "--cached"]
        } else {
            vec!["diff"]
        };
        run_git(&args.cwd, &cmd)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiffResponse {
    /// unified patch 原文；availability != "patch" 时为 None
    pub patch: Option<String>,
    /// patch | binary | truncated（untracked 超过 1MB）
    pub availability: String,
}

const UNTRACKED_DIFF_MAX_BYTES: u64 = 1024 * 1024;

/// 未跟踪文件合成最小 unified patch（对齐 ZCode buildUntrackedTextDiffResult：
/// `--- /dev/null` + `+++ b/<path>` + `@@ -0,0 +1,N @@` + 全 `+` 行；无尾换行补
/// `\ No newline at end of file`）。二进制（含 0 字节）与超 1MB 文件不生成 patch。
pub fn synthesize_untracked_patch(cwd: &str, path: &str) -> Result<GitFileDiffResponse, String> {
    use std::io::Read;
    let full = std::path::Path::new(cwd).join(path);
    let mut file = match std::fs::File::open(&full) {
        Ok(f) => f,
        Err(_) => {
            return Ok(GitFileDiffResponse { patch: None, availability: "unavailable".to_string() });
        }
    };
    let mut buf: Vec<u8> = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return Ok(GitFileDiffResponse { patch: None, availability: "unavailable".to_string() });
    }
    if buf.len() as u64 > UNTRACKED_DIFF_MAX_BYTES {
        return Ok(GitFileDiffResponse { patch: None, availability: "truncated".to_string() });
    }
    if buf.contains(&0) {
        return Ok(GitFileDiffResponse { patch: None, availability: "binary".to_string() });
    }
    let content = String::from_utf8_lossy(&buf);
    let has_trailing_newline = content.ends_with('\n');
    let normalized = content.replace("\r\n", "\n");
    let mut lines: Vec<&str> = normalized.split('\n').collect();
    if has_trailing_newline {
        lines.pop();
    }
    let mut patch_lines: Vec<String> = vec![
        "--- /dev/null".to_string(),
        format!("+++ b/{}", path.replace('\\', "/")),
    ];
    if !lines.is_empty() {
        patch_lines.push(format!("@@ -0,0 +1,{} @@", lines.len()));
        patch_lines.extend(lines.iter().map(|l| format!("+{l}")));
    }
    if !has_trailing_newline && !lines.is_empty() {
        patch_lines.push("\\ No newline at end of file".to_string());
    }
    Ok(GitFileDiffResponse {
        patch: Some(format!("{}\n", patch_lines.join("\n"))),
        availability: "patch".to_string(),
    })
}

/// 单文件 diff（对齐 ZCode getDiff 的单文件路径：未暂存=`git diff -- <path>`、
/// 已暂存=`git diff --cached -- <path>`；untracked 文件不在 diff 里，合成最小 patch）。
#[tauri::command]
pub async fn git_diff_file(args: GitDiffFileArgs) -> Result<GitFileDiffResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if args.untracked {
            return synthesize_untracked_patch(&args.cwd, &args.path);
        }
        let cmd: Vec<&str> = if args.staged {
            vec!["diff", "--cached", "--no-ext-diff", "--no-color", "--binary", "--", &args.path]
        } else {
            vec!["diff", "--no-ext-diff", "--no-color", "--binary", "--", &args.path]
        };
        match run_git(&args.cwd, &cmd) {
            Ok(out) => {
                if out.is_empty() {
                    return Ok(GitFileDiffResponse { patch: None, availability: "unavailable".to_string() });
                }
                if out.contains("GIT binary patch") || out.contains("Binary files ") {
                    return Ok(GitFileDiffResponse { patch: None, availability: "binary".to_string() });
                }
                Ok(GitFileDiffResponse { patch: Some(out), availability: "patch".to_string() })
            }
            Err(e) if is_not_repo_error(&e) => Err(e),
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffFileArgs {
    pub cwd: String,
    pub path: String,
    /// true = 已暂存 diff（HEAD vs index）
    #[serde(default)]
    pub staged: bool,
    /// true = 未跟踪文件（合成最小 patch，git diff 不含它们）
    #[serde(default)]
    pub untracked: bool,
}
