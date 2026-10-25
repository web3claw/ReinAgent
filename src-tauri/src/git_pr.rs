//! PR / MR 面板命令（ROADMAP ⑦，Hetu WorkPrClient 移植）。
//!
//! 按 remote URL 自动选 gh（GitHub）/ glab（GitLab），覆盖：
//! - `git_pr_status`：一站式状态（仓库/分支/CLI 探测/当前分支 PR + CI/开放列表）
//! - `git_pr_create`：创建 PR / MR（gh 的 body 走 stdin 防转义；glab 走 --description）
//! - `git_pr_action`：ready / draft / merge / close / reopen
//! - `git_pr_feedback`：待处理反馈聚合（失败+进行中 CI、行内审查意见、失败日志摘录）
//!
//! 网络命令（gh/glab）120s 超时、本地 git 30s——tokio::process + timeout，
//! 超时回传可读文案而非挂死面板。CLI 未安装 / 无 remote / 非支持托管平台
//! 一律结构化如实上抛（no-fallback），前端据此显示安装引导。
//! 参数经 argv 直传不经 shell，无引号转义面。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tokio::process::Command;

/// gh / glab 网络命令超时（网络慢时给足，超时后提示手动去终端执行）
const NETWORK_TIMEOUT_SECS: u64 = 120;
/// 本地 git 查询超时
const LOCAL_GIT_TIMEOUT_SECS: u64 = 30;
/// 失败日志摘录上限：交给模型的内容不宜过长（Hetu 同值）
const LOG_EXCERPT_LIMIT: usize = 12_000;
/// 最多抓取几条失败检查的日志
const FAILED_RUN_LIMIT: usize = 2;
/// gh pr view 要回传的字段（状态 + 合并门禁 + 变更量，Hetu GitHubFields 同款）
const GH_PR_FIELDS: &str = "number,title,url,state,isDraft,baseRefName,headRefName,mergeable,mergeStateStatus,reviewDecision,additions,deletions,changedFiles";

// ===== DTO =====

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitPrCheck {
    pub name: String,
    pub workflow: Option<String>,
    pub state: String,
    /// pass | fail | pending | cancel | skipping | ""
    pub bucket: String,
    pub link: Option<String>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitPrInfo {
    pub number: i64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub is_draft: bool,
    pub base_branch: String,
    pub head_branch: String,
    pub mergeable: String,
    pub merge_state_status: String,
    pub review_decision: Option<String>,
    pub additions: i64,
    pub deletions: i64,
    pub changed_files: i64,
    #[serde(default)]
    pub checks: Vec<GitPrCheck>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitPrComment {
    pub author: String,
    pub body: String,
    pub path: Option<String>,
    pub line: Option<i64>,
    /// review（行内意见）| review-summary（审查结论正文）
    pub kind: String,
    pub created_at: String,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitPrStatus {
    pub is_repo: bool,
    pub branch: String,
    pub remote_url: String,
    /// github | gitlab | ""（不支持）
    pub host: String,
    /// gh | glab | ""
    pub tool: String,
    pub tool_installed: bool,
    /// 当前平台安装命令（CLI 未装时前端展示）
    pub install_hint: String,
    /// 非 PR 状态原因：no-remote / unsupported-host / CLI 错误首行（空 = 一切正常）
    pub message: String,
    /// 默认目标分支（origin/HEAD → origin/main|master → 当前分支）
    pub base_branch: String,
    /// 当前分支是否已推送（未推送谈不上 PR）
    pub branch_pushed: bool,
    pub pr: Option<GitPrInfo>,
    pub open_prs: Vec<GitPrInfo>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitPrFeedback {
    pub has_pr: bool,
    pub number: i64,
    pub title: String,
    pub url: String,
    pub mergeable: String,
    pub merge_state_status: String,
    pub review_decision: Option<String>,
    pub additions: i64,
    pub deletions: i64,
    pub changed_files: i64,
    /// 仅保留 fail / pending / cancel
    pub checks: Vec<GitPrCheck>,
    pub comments: Vec<GitPrComment>,
    pub log_excerpt: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPrCreateArgs {
    pub cwd: String,
    pub title: String,
    pub body: String,
    /// 留空用集成分支
    pub base_branch: Option<String>,
    pub draft: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPrActionArgs {
    pub cwd: String,
    /// ready | draft | merge | close | reopen
    pub action: String,
    /// merge | squash | rebase（仅 merge 动作）
    pub merge_method: Option<String>,
    pub delete_branch: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPrCommandResult {
    pub success: bool,
    /// CLI 原始输出（失败时为错误原文）
    pub output: String,
    pub status: GitPrStatus,
}

// ===== 进程执行 =====

/// Windows GUI 进程 spawn 控制台程序会闪 cmd 窗（对齐 git_panel.rs 的 CREATE_NO_WINDOW）
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct RunOutcome {
    code: i32,
    combined: String,
}

/// 带超时执行命令（argv 直传不经 shell）。超时 kill 并回传可读文案。
async fn run_timed(mut cmd: Command, timeout_secs: u64, what: &str) -> Result<RunOutcome, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    // spawn+wait_with_output 不会像 output() 那样自动 pipe——不显式设置会继承父进程 stdio 拿不到输出
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    // wait_with_output 消费 child：超时取消 fut 后靠 drop 自动 kill
    cmd.kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("{what} 启动失败（未安装或不在 PATH）：{e}"))?;
    let fut = child.wait_with_output();
    match tokio::time::timeout(Duration::from_secs(timeout_secs), fut).await {
        Ok(Ok(output)) => {
            let mut combined = String::from_utf8_lossy(&output.stdout).to_string();
            combined.push_str(&String::from_utf8_lossy(&output.stderr));
            Ok(RunOutcome {
                code: output.status.code().unwrap_or(-1),
                combined,
            })
        }
        Ok(Err(e)) => Err(format!("{what} 执行失败：{e}")),
        Err(_) => Err(format!("{what} 命令超时（网络较慢时请在终端里手动执行）")),
    }
}

/// 本地 git 查询（30s），失败返回 Err（调用方决定语义）
async fn git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(cwd);
    let out = run_timed(cmd, LOCAL_GIT_TIMEOUT_SECS, "git").await?;
    if out.code != 0 {
        let combined = out.combined;
        if combined.to_lowercase().contains("not a git repository") {
            return Err("GIT_NOT_REPO".to_string());
        }
        return Err(format!("git {} 失败：{}", args.first().unwrap_or(&""), combined.trim()));
    }
    Ok(out.combined)
}

/// gh / glab 网络命令（120s）。不把非 0 退出当 Err——CLI 用退出码+输出表达业务状态
async fn tool(cwd: &str, tool: &str, args: &[&str], stdin: Option<&str>) -> Result<RunOutcome, String> {
    let mut cmd = Command::new(tool);
    cmd.args(args).current_dir(cwd);
    // 输出必须 piped（spawn 模式不自动）；stdin 仅 body-file - 场景需要
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    if stdin.is_some() {
        cmd.stdin(std::process::Stdio::piped());
    } else {
        cmd.stdin(std::process::Stdio::null());
    }
    // 同 run_timed：超时取消 fut 后靠 drop 自动 kill
    cmd.kill_on_drop(true);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("{tool} 启动失败（未安装或不在 PATH）：{e}"))?;
    let fut = async {
        if let Some(body) = stdin {
            use tokio::io::AsyncWriteExt;
            if let Some(mut sin) = child.stdin.take() {
                let _ = sin.write_all(body.as_bytes()).await;
                // drop 关闭 stdin，gh 读到 EOF 才继续
            }
        }
        child.wait_with_output().await
    };
    match tokio::time::timeout(Duration::from_secs(NETWORK_TIMEOUT_SECS), fut).await {
        Ok(Ok(output)) => {
            let mut combined = String::from_utf8_lossy(&output.stdout).to_string();
            combined.push_str(&String::from_utf8_lossy(&output.stderr));
            Ok(RunOutcome {
                code: output.status.code().unwrap_or(-1),
                combined,
            })
        }
        Ok(Err(e)) => Err(format!("{tool} 执行失败：{e}")),
        Err(_) => Err(format!("{tool} 命令超时（网络较慢时请在终端里手动执行）")),
    }
}

// ===== 纯函数：解析与映射（单测覆盖） =====

/// 远端地址解析主机名（https://host/... 与 git@host:owner/repo.git）
pub fn parse_remote_host(remote_url: &str) -> Option<String> {
    let url = remote_url.trim();
    if let Some(at) = url.find('@') {
        let rest = &url[at + 1..];
        let colon = rest.find(':');
        let slash = rest.find('/');
        let end = match (colon, slash) {
            (Some(c), Some(s)) => Some(c.min(s)),
            (Some(c), None) => Some(c),
            (None, Some(s)) => Some(s),
            (None, None) => None,
        };
        if let Some(end) = end {
            if end > 0 {
                return Some(rest[..end].to_string());
            }
        }
    }
    // 无 @ 的 https://host/owner/repo
    let path = url.split("://").nth(1).unwrap_or(url);
    path.split('/').next().filter(|s| !s.is_empty()).map(|s| s.to_string())
}

/// 远端地址解析 owner/repo（gh api 路径用）
pub fn parse_repo_slug(remote_url: &str) -> Option<String> {
    let mut path = remote_url.trim().to_string();
    if path.ends_with(".git") {
        path.truncate(path.len() - 4);
    }
    if let Some(pos) = path.find("://") {
        path = path[pos + 3..].to_string();
    }
    // git@host:owner/repo → 冒号后才是路径；https://host/owner/repo 只剩 host/owner/repo
    let colon = path.find(':');
    let slash = path.find('/');
    if let (Some(c), s) = (colon, slash) {
        if s.map_or(true, |s| c < s) {
            path = path[c + 1..].to_string();
        }
    }
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    match segments.len() {
        n if n >= 3 => Some(format!("{}/{}", segments[1], segments[2])),
        2 => Some(format!("{}/{}", segments[0], segments[1])),
        _ => None,
    }
}

fn json_str(root: &Value, key: &str) -> String {
    root.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

fn json_opt_str(root: &Value, key: &str) -> Option<String> {
    let s = json_str(root, key);
    if s.is_empty() { None } else { Some(s) }
}

fn json_i64(root: &Value, key: &str) -> i64 {
    root.get(key).and_then(|v| v.as_i64()).unwrap_or(0)
}

fn json_bool(root: &Value, key: &str) -> bool {
    root.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

/// 解析 gh / glab 的 PR JSON 对象为统一 DTO
pub fn parse_pr_element(host: &str, root: &Value) -> Option<GitPrInfo> {
    if !root.is_object() {
        return None;
    }
    if host == "gitlab" {
        let mut info = GitPrInfo {
            number: json_i64(root, "iid"),
            title: json_str(root, "title"),
            url: json_str(root, "web_url"),
            state: json_str(root, "state"),
            is_draft: json_bool(root, "draft") || json_bool(root, "work_in_progress"),
            base_branch: json_str(root, "target_branch"),
            head_branch: json_str(root, "source_branch"),
            mergeable: json_str(root, "merge_status"),
            merge_state_status: json_opt_str(root, "detailed_merge_status")
                .or_else(|| json_opt_str(root, "merge_status"))
                .unwrap_or_default(),
            review_decision: if json_bool(root, "approved") { Some("APPROVED".into()) } else { None },
            ..Default::default()
        };
        info.checks = parse_gitlab_pipeline(root);
        return Some(info);
    }
    // gh：reviewDecision 空串统一成 None（调用方只判空）
    Some(GitPrInfo {
        number: json_i64(root, "number"),
        title: json_str(root, "title"),
        url: json_str(root, "url"),
        state: json_str(root, "state"),
        is_draft: json_bool(root, "isDraft"),
        base_branch: json_str(root, "baseRefName"),
        head_branch: json_str(root, "headRefName"),
        mergeable: json_str(root, "mergeable"),
        merge_state_status: json_str(root, "mergeStateStatus"),
        review_decision: json_opt_str(root, "reviewDecision"),
        additions: json_i64(root, "additions"),
        deletions: json_i64(root, "deletions"),
        changed_files: json_i64(root, "changedFiles"),
        checks: Vec::new(),
    })
}

/// 解析 gh / glab 的 JSON 数组输出（开放 PR 列表）；解析失败当没有
pub fn parse_pr_list(host: &str, json_text: &str) -> Vec<GitPrInfo> {
    let Ok(doc) = serde_json::from_str::<Value>(json_text) else {
        return Vec::new();
    };
    let Value::Array(items) = doc else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| parse_pr_element(host, item))
        .filter(|pr| pr.number > 0)
        .collect()
}

/// 解析 gh pr checks 的 JSON 数组（上限 40 条）
pub fn parse_checks(json_text: &str) -> Vec<GitPrCheck> {
    let Ok(doc) = serde_json::from_str::<Value>(json_text) else {
        return Vec::new();
    };
    let Value::Array(items) = doc else {
        return Vec::new();
    };
    let mut list = Vec::new();
    for item in &items {
        if !item.is_object() {
            continue;
        }
        let name = json_str(item, "name");
        if name.is_empty() {
            continue;
        }
        list.push(GitPrCheck {
            name,
            workflow: json_opt_str(item, "workflow"),
            state: json_str(item, "state"),
            bucket: json_str(item, "bucket"),
            link: json_opt_str(item, "link"),
        });
        if list.len() >= 40 {
            break;
        }
    }
    list
}

/// GitLab MR 的 head_pipeline 映射成一条检查（调用方无需区分平台）
fn parse_gitlab_pipeline(root: &Value) -> Vec<GitPrCheck> {
    let Some(pipeline) = root.get("head_pipeline").filter(|p| p.is_object()) else {
        return Vec::new();
    };
    let state = json_str(pipeline, "status");
    if state.is_empty() {
        return Vec::new();
    }
    let bucket = match state.as_str() {
        "success" => "pass",
        "failed" => "fail",
        "canceled" => "cancel",
        "skipped" => "skipping",
        _ => "pending",
    };
    vec![GitPrCheck {
        name: "pipeline".into(),
        workflow: None,
        state,
        bucket: bucket.into(),
        link: json_opt_str(pipeline, "web_url"),
    }]
}

/// 解析 gh api 的评论 / 审查 JSON 数组；无正文记录跳过，正文截 2000
pub fn parse_comments(json_text: &str, kind: &str) -> Vec<GitPrComment> {
    let Ok(doc) = serde_json::from_str::<Value>(json_text) else {
        return Vec::new();
    };
    let Value::Array(items) = doc else {
        return Vec::new();
    };
    let mut list = Vec::new();
    for item in &items {
        let body = json_str(item, "body");
        if body.trim().is_empty() {
            continue;
        }
        let body = if body.len() > 2000 {
            format!("{}…", &body[..body.floor_char_boundary(2000)])
        } else {
            body
        };
        list.push(GitPrComment {
            author: item
                .get("user")
                .and_then(|u| u.get("login"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            body,
            path: json_opt_str(item, "path"),
            line: item
                .get("line")
                .and_then(|v| v.as_i64())
                .or_else(|| item.get("original_line").and_then(|v| v.as_i64())),
            kind: kind.into(),
            created_at: json_opt_str(item, "created_at")
                .or_else(|| json_opt_str(item, "submitted_at"))
                .unwrap_or_default(),
        });
    }
    list
}

/// 合并门禁可读标签（UI / prompt 用）
pub fn merge_state_label(merge_state_status: &str, mergeable: &str) -> &'static str {
    if mergeable.eq_ignore_ascii_case("CONFLICTING") {
        return "有冲突";
    }
    match merge_state_status.to_uppercase().as_str() {
        "CLEAN" => "可合并",
        "DIRTY" => "有冲突",
        "BLOCKED" => "被阻塞",
        "BEHIND" => "落后源分支",
        "UNSTABLE" => "检查未全绿",
        "HAS_HOOKS" => "待钩子检查",
        _ => "未知",
    }
}

/// 审查结论可读标签
pub fn review_label(decision: Option<&str>) -> &'static str {
    match decision.unwrap_or_default().to_uppercase().as_str() {
        "APPROVED" => "已通过审查",
        "CHANGES_REQUESTED" => "要求修改",
        "REVIEW_REQUIRED" => "需要审查",
        _ => "待审查",
    }
}

/// 当前系统的 CLI 安装命令（引导用户安装）
pub fn install_hint(tool: &str) -> String {
    if cfg!(target_os = "windows") {
        if tool == "gh" { "winget install --id GitHub.cli".into() } else { "scoop install glab".into() }
    } else if cfg!(target_os = "macos") {
        format!("brew install {tool}")
    } else {
        format!("sudo apt install {tool}")
    }
}

/// 动作 → gh / glab 子命令参数（不含 tool 前缀；未知动作返回 None）。
/// close/reopen 需显式目标（gh 2.103 不接受隐式当前分支），传当前分支名。
pub fn build_action_args(tool_name: &str, action: &str, merge_method: Option<&str>, delete_branch: bool, target_branch: &str) -> Option<Vec<String>> {
    let is_gitlab = tool_name == "glab";
    let args: Vec<String> = match action {
        "ready" => {
            let mut v = vec!["mr".into(), "update".into(), "--ready".into()];
            if !is_gitlab { v = vec!["pr".into(), "ready".into()]; }
            v
        }
        "draft" => {
            if is_gitlab { vec!["mr".into(), "update".into(), "--draft".into()] }
            else { vec!["pr".into(), "ready".into(), "--undo".into()] }
        }
        "merge" => {
            let method = merge_method.unwrap_or("").trim().to_lowercase();
            if is_gitlab {
                let mut v = vec!["mr".into(), "merge".into(), "--yes".into()];
                match method.as_str() {
                    "squash" => v.push("--squash".into()),
                    "rebase" => v.push("--rebase".into()),
                    _ => {}
                }
                if delete_branch { v.push("--remove-source-branch".into()); }
                v
            } else {
                let gh_method = if method == "squash" || method == "rebase" { method } else { "merge".into() };
                let mut v = vec!["pr".into(), "merge".into(), format!("--{gh_method}")];
                if delete_branch { v.push("--delete-branch".into()); }
                v
            }
        }
        "close" => {
            let target = target_branch.to_string();
            if is_gitlab { vec!["mr".into(), "close".into(), target] } else { vec!["pr".into(), "close".into(), target] }
        }
        "reopen" => {
            let target = target_branch.to_string();
            if is_gitlab { vec!["mr".into(), "reopen".into(), target] } else { vec!["pr".into(), "reopen".into(), target] }
        }
        _ => return None,
    };
    Some(args)
}

// ===== 命令实现 =====

/// 集成分支：origin/HEAD → origin/main|master；拿不到返回 None
async fn resolve_integration_ref(cwd: &str) -> Option<String> {
    if let Ok(head) = git(cwd, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).await {
        let t = head.trim();
        if !t.is_empty() {
            return Some(t.trim_start_matches("origin/").to_string());
        }
    }
    for candidate in ["origin/main", "origin/master"] {
        if git(cwd, &["rev-parse", "--verify", "--quiet", candidate]).await.is_ok() {
            return Some(candidate.trim_start_matches("origin/").to_string());
        }
    }
    None
}

/// 一站式 PR 状态。任何环境缺失都以结构化字段如实回传（不 Err——前端要展示引导）
#[tauri::command]
pub async fn git_pr_status(cwd: String) -> Result<GitPrStatus, String> {
    let mut status = GitPrStatus::default();

    let branch = match git(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).await {
        Ok(b) => b.trim().to_string(),
        Err(_) => return Ok(status), // 非 git 仓库：is_repo=false
    };
    status.is_repo = true;
    status.branch = branch;

    let remote = git(&cwd, &["remote", "get-url", "origin"]).await.unwrap_or_default();
    let remote = remote.trim();
    if remote.is_empty() {
        status.message = "no-remote".into();
        return Ok(status);
    }
    status.remote_url = remote.to_string();

    let host = parse_remote_host(remote);
    let is_github = host.as_deref().is_some_and(|h| h.to_lowercase().contains("github"));
    let is_gitlab = host.as_deref().is_some_and(|h| h.to_lowercase().contains("gitlab"));
    if !is_github && !is_gitlab {
        status.message = "unsupported-host".into();
        return Ok(status);
    }
    status.host = if is_gitlab { "gitlab" } else { "github" }.into();
    status.tool = if is_gitlab { "glab" } else { "gh" }.into();

    let (ver_code, _) = match tool(&cwd, &status.tool, &["--version"], None).await {
        Ok(o) => (o.code, o.combined),
        Err(_) => (1, String::new()),
    };
    status.tool_installed = ver_code == 0;
    if !status.tool_installed {
        status.install_hint = install_hint(&status.tool);
        return Ok(status);
    }

    status.base_branch = resolve_integration_ref(&cwd)
        .await
        .unwrap_or_else(|| status.branch.clone());

    // 分支是否已推送（未推送时远端无此分支）
    let upstream = git(&cwd, &["config", "--get", &format!("branch.{}.remote", status.branch)])
        .await
        .unwrap_or_default();
    status.branch_pushed = !upstream.trim().is_empty();

    let view_args: Vec<&str> = if is_gitlab {
        vec!["mr", "view", "--output", "json"]
    } else {
        vec!["pr", "view", "--json", GH_PR_FIELDS]
    };
    let view = tool(&cwd, &status.tool, &view_args, None).await?;
    if view.code != 0 {
        status.message = first_line(&view.combined).unwrap_or_default();
    } else if let Ok(doc) = serde_json::from_str::<Value>(&view.combined) {
        status.pr = parse_pr_element(&status.host, &doc);
        // CI 明细单独查：pr view 的 statusCheckRollup 结构与 pr checks 不同，后者直接给归并桶
        if let (Some(pr), false) = (status.pr.as_mut(), is_gitlab) {
            let checks_out = tool(&cwd, &status.tool, &["pr", "checks", "--json", "name,state,bucket,link,workflow"], None).await;
            if let Ok(out) = checks_out {
                let checks = parse_checks(&out.combined);
                if !checks.is_empty() {
                    pr.checks = checks;
                }
            }
        }
    }

    let list_args: Vec<&str> = if is_gitlab {
        vec!["mr", "list", "--opened", "--output", "json"]
    } else {
        vec!["pr", "list", "--state", "open", "--limit", "10", "--json", "number,title,url,state,isDraft,baseRefName,headRefName"]
    };
    if let Ok(list) = tool(&cwd, &status.tool, &list_args, None).await {
        if list.code == 0 {
            status.open_prs = parse_pr_list(&status.host, &list.combined);
        }
    }
    Ok(status)
}

/// 创建 PR / MR（成功后回传刷新状态）
#[tauri::command]
pub async fn git_pr_create(args: GitPrCreateArgs) -> Result<GitPrCommandResult, String> {
    let status = git_pr_status(args.cwd.clone()).await?;
    if !status.tool_installed || status.tool.is_empty() {
        return Ok(GitPrCommandResult { success: false, output: status.install_hint.clone(), status });
    }
    let base = args.base_branch.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or(&status.base_branch);
    let is_gitlab = status.tool == "glab";
    let (run_args, stdin): (Vec<String>, Option<&str>) = if is_gitlab {
        let mut v = vec![
            "mr".into(), "create".into(),
            "--title".into(), args.title.clone(),
            "--target-branch".into(), base.to_string(),
            "--description".into(), args.body.clone(),
            "--yes".into(),
        ];
        if args.draft { v.push("--draft".into()); }
        (v, None)
    } else {
        let mut v = vec![
            "pr".into(), "create".into(),
            "--title".into(), args.title.clone(),
            "--base".into(), base.to_string(),
            "--body-file".into(), "-".into(),
        ];
        if args.draft { v.push("--draft".into()); }
        (v, Some(args.body.as_str()))
    };
    let run_args: Vec<&str> = run_args.iter().map(String::as_str).collect();
    let out = match tool(&args.cwd, &status.tool, &run_args, stdin).await {
        Ok(o) => o,
        Err(e) => return Ok(GitPrCommandResult { success: false, output: e, status }),
    };
    let refreshed = git_pr_status(args.cwd.clone()).await?;
    Ok(GitPrCommandResult {
        success: out.code == 0,
        output: out.combined.trim().to_string(),
        status: refreshed,
    })
}

/// PR 动作：ready / draft / merge / close / reopen（作用于当前分支的 PR）
#[tauri::command]
pub async fn git_pr_action(args: GitPrActionArgs) -> Result<GitPrCommandResult, String> {
    let status = git_pr_status(args.cwd.clone()).await?;
    if !status.tool_installed || status.tool.is_empty() {
        return Ok(GitPrCommandResult { success: false, output: status.install_hint.clone(), status });
    }
    let action = args.action.trim().to_lowercase();
    let argv = build_action_args(
        &status.tool,
        &action,
        args.merge_method.as_deref(),
        args.delete_branch.unwrap_or(false),
        &status.branch,
    );
    let Some(argv) = argv else {
        return Ok(GitPrCommandResult {
            success: false,
            output: format!("不支持的 PR 操作：{}", args.action),
            status,
        });
    };
    let run_args: Vec<&str> = argv.iter().map(String::as_str).collect();
    let out = match tool(&args.cwd, &status.tool, &run_args, None).await {
        Ok(o) => o,
        Err(e) => return Ok(GitPrCommandResult { success: false, output: e, status }),
    };
    let refreshed = git_pr_status(args.cwd.clone()).await?;
    Ok(GitPrCommandResult {
        success: out.code == 0,
        output: out.combined.trim().to_string(),
        status: refreshed,
    })
}

/// 待处理反馈聚合（全只读；抓不到的部分留空）
#[tauri::command]
pub async fn git_pr_feedback(cwd: String) -> Result<GitPrFeedback, String> {
    let status = git_pr_status(cwd.clone()).await?;
    let mut feedback = GitPrFeedback::default();
    let Some(pr) = status.pr else {
        return Ok(feedback);
    };
    feedback.has_pr = true;
    feedback.number = pr.number;
    feedback.title = pr.title.clone();
    feedback.url = pr.url.clone();
    feedback.mergeable = pr.mergeable.clone();
    feedback.merge_state_status = pr.merge_state_status.clone();
    feedback.review_decision = pr.review_decision.clone();
    feedback.additions = pr.additions;
    feedback.deletions = pr.deletions;
    feedback.changed_files = pr.changed_files;
    feedback.checks = pr
        .checks
        .iter()
        .filter(|c| matches!(c.bucket.as_str(), "fail" | "pending" | "cancel"))
        .cloned()
        .collect();

    // 评论与运行日志目前只抓 GitHub（glab 侧流水线明细已进 checks）
    if status.host != "github" {
        return Ok(feedback);
    }
    let Some(slug) = parse_repo_slug(&status.remote_url) else {
        return Ok(feedback);
    };
    let num = pr.number.to_string();
    let comments_path = format!("repos/{slug}/pulls/{num}/comments?per_page=100");
    let review_args = vec!["api", comments_path.as_str()];
    if let Ok(out) = tool(&cwd, "gh", &review_args, None).await {
        if out.code == 0 {
            let mut comments = parse_comments(&out.combined, "review");
            let reviews_path = format!("repos/{slug}/pulls/{num}/reviews?per_page=100");
            let summary_args = vec!["api", reviews_path.as_str()];
            if let Ok(out2) = tool(&cwd, "gh", &summary_args, None).await {
                if out2.code == 0 {
                    comments.extend(parse_comments(&out2.combined, "review-summary"));
                }
            }
            comments.sort_by(|a, b| a.created_at.cmp(&b.created_at));
            comments.truncate(30);
            feedback.comments = comments;
        }
    }
    feedback.log_excerpt = fetch_failure_logs(&cwd, &pr.checks).await;
    Ok(feedback)
}

/// 按失败检查的 run 链接抓 --log-failed 摘录（≤2 条、总长 ≤12000）
async fn fetch_failure_logs(cwd: &str, checks: &[GitPrCheck]) -> Option<String> {
    let mut run_ids: Vec<String> = Vec::new();
    for check in checks {
        if check.bucket != "fail" {
            continue;
        }
        let Some(link) = check.link.as_deref() else { continue };
        let Some(id) = link.split("/runs/").nth(1) else { continue };
        let id = id.split('?').next().unwrap_or(id);
        if id.is_empty() { continue; }
        if !run_ids.iter().any(|x| x == id) {
            run_ids.push(id.to_string());
        }
        if run_ids.len() >= FAILED_RUN_LIMIT {
            break;
        }
    }
    if run_ids.is_empty() {
        return None;
    }
    let mut buffer = String::new();
    for id in run_ids {
        let Ok(out) = tool(cwd, "gh", &["run", "view", &id, "--log-failed"], None).await else {
            continue;
        };
        if out.code != 0 || out.combined.trim().is_empty() {
            continue;
        }
        buffer.push_str(out.combined.trim());
        buffer.push('\n');
        if buffer.len() >= LOG_EXCERPT_LIMIT {
            break;
        }
    }
    let text = buffer.trim().to_string();
    if text.is_empty() {
        return None;
    }
    if text.len() > LOG_EXCERPT_LIMIT {
        Some(format!("{}…", &text[..text.floor_char_boundary(LOG_EXCERPT_LIMIT)]))
    } else {
        Some(text)
    }
}

fn first_line(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.to_string())
}
