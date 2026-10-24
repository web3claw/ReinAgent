//! 会话级 git worktree 隔离（ROADMAP ②，对标 Hetu WorkWorktreeService）：
//! 每个任务可拥有独立的 git worktree + 独立分支，主工作区保持干净。
//!
//! 定案（用户拍板）：
//! - 目录：`<仓库父目录>/.reinagent-worktrees/<仓库名>/<分支slug>/`（同盘零拷贝）
//! - 分支：`reinagent/<标题slug>-<task短id>`（确定性，冲突 -2..-20 递增）
//! - 合并：`git merge --no-ff`（保留任务交付节点；主仓必须干净、HEAD==base，
//!   冲突返回未合并文件列表交手工）
//! - 清理：已合并 + 工作树干净 + 空闲 >24h（TS 侧按任务 updatedAt 判定空闲）
//!   自动移除工作树（分支保留）；被吸收/未交付内容永不动。
//!
//! 全部命令复用 git_panel::run_git（CREATE_NO_WINDOW + GIT_NOT_REPO 哨兵），
//! 同步执行包 spawn_blocking。

use serde::Serialize;

use crate::git_panel::run_git;

const WORKTREES_DIR_NAME: &str = ".reinagent-worktrees";
const BRANCH_PREFIX: &str = "reinagent";
const MAX_SLUG_LEN: usize = 30;

// ==================== DTO ====================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEnsureResult {
    pub worktree_path: String,
    pub branch: String,
    pub base: String,
    pub repo_root: String,
    /// true = 本次新建；false = 已存在幂等返回
    pub created: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeMergeConflict {
    pub message: String,
    pub unmerged_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeMergeResult {
    pub merged: bool,
    pub merge_commit: Option<String>,
    pub conflict: Option<WorktreeMergeConflict>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEligibility {
    pub clean: bool,
    pub merged_into_base: bool,
    pub removable: bool,
}

// ==================== 纯函数（Red Check / 单测缝）====================

/// 标题 → 分支 slug：保留 ASCII 字母数字、CJK 与 '-'，空白/符号折叠为 '-'，
/// 收敛连续 '-'，掐头去尾，限长。空结果回退 "task"。
pub(crate) fn slugify_title(title: &str, max_len: usize) -> String {
    let mut out = String::new();
    let mut last_dash = true; // 掐头
    for ch in title.chars() {
        let mapped = if ch.is_ascii_alphanumeric() {
            Some(ch.to_ascii_lowercase())
        } else if (ch as u32) >= 0x4E00 && (ch as u32) <= 0x9FFF {
            Some(ch)
        } else {
            None
        };
        match mapped {
            Some(c) => {
                out.push(c);
                last_dash = false;
            }
            None => {
                if !last_dash && !out.is_empty() {
                    out.push('-');
                    last_dash = true;
                }
            }
        }
        if out.chars().count() >= max_len {
            break;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "task".to_string()
    } else {
        trimmed
    }
}

/// 从 task_id 提取短 id（task-<ms>-<suffix> 的 suffix 段；异形 id 兜底取尾部 5 位）。
pub(crate) fn short_id_of(task_id: &str) -> String {
    let tail = task_id.rsplit('-').next().unwrap_or("");
    if tail.len() >= 3 && tail.chars().all(|c| c.is_ascii_alphanumeric()) {
        tail.to_string()
    } else {
        let chars: Vec<char> = task_id.chars().collect();
        let start = chars.len().saturating_sub(5);
        chars[start..].iter().collect()
    }
}

// ==================== 内部工具 ====================

/// 工作区 cwd → 仓库根（工作区可能是仓库子目录）。
fn repo_root_of(cwd: &str) -> Result<String, String> {
    let root = run_git(cwd, &["rev-parse", "--show-toplevel"])?;
    Ok(root.trim().replace('\\', "/"))
}


/// 工作树路径 → 主仓根（worktree 的 .git 是指回主仓 gitdir 的文件）。
fn main_repo_root_of_worktree(worktree_path: &str) -> Result<String, String> {
    let common = run_git(worktree_path, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
    let common = common.trim().replace('\\', "/");
    let trimmed = common.trim_end_matches('/');
    let root = trimmed
        .strip_suffix("/.git")
        .ok_or_else(|| format!("无法从 git common dir 定位主仓根：{common}"))?;
    Ok(root.to_string())
}

fn head_commit(cwd: &str) -> Result<String, String> {
    Ok(run_git(cwd, &["rev-parse", "HEAD"])?.trim().to_string())
}

fn is_clean(cwd: &str) -> Result<bool, String> {
    let status = run_git(cwd, &["status", "--porcelain"])?;
    Ok(status.trim().is_empty())
}

/// 分支名在仓库内是否已存在（含远端引用不算——只查本地）。
fn branch_exists(repo_root: &str, branch: &str) -> Result<bool, String> {
    let out = run_git(repo_root, &["branch", "--list", branch])?;
    Ok(out.trim().contains(branch))
}

/// 分支是否已有挂载的 worktree（`git worktree list --porcelain` 按 branch 行匹配）。
fn worktree_for_branch(repo_root: &str, branch: &str) -> Result<Option<String>, String> {
    let out = run_git(repo_root, &["worktree", "list", "--porcelain"])?;
    let mut current_path: Option<String> = None;
    for line in out.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            current_path = Some(path.replace('\\', "/"));
        } else if let Some(b) = line.strip_prefix("branch ") {
            if b.trim() == branch || b.trim() == format!("refs/heads/{branch}") {
                if let Some(path) = current_path {
                    return Ok(Some(path));
                }
            }
        } else if line.is_empty() {
            current_path = None;
        }
    }
    Ok(None)
}

/// 确定性命名：同 task_id 恒得同分支名（幂等的关键）。不查存在性——
/// 分支已存在只可能是本任务自己的工作树（上次清理保留了分支），由 ensure
/// 决定挂回还是复用。不同任务的 short_id 不同，天然不冲突。
fn deterministic_branch_name(title: &str, short_id: &str) -> (String, String) {
    let slug = slugify_title(title, MAX_SLUG_LEN);
    let branch = format!("{BRANCH_PREFIX}/{slug}-{short_id}");
    (branch.clone(), slug_dir_of(&branch))
}

fn slug_dir_of(branch: &str) -> String {
    branch
        .trim_start_matches(&format!("{BRANCH_PREFIX}/"))
        .replace('/', "-")
}

// ==================== Store 命令实现 =====================

/// 幂等确保任务的 worktree 存在：分支已挂 worktree → 原样返回；否则新建。
#[tauri::command]
pub async fn git_worktree_ensure(
    cwd: String,
    task_id: String,
    title: String,
) -> Result<WorktreeEnsureResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo_root = repo_root_of(&cwd)?;
        let base = head_commit(&repo_root)?;
        let short_id = short_id_of(&task_id);
        let (branch, dir_slug) = deterministic_branch_name(&title, &short_id);
        // 幂等：该分支已有挂载 worktree → 原样返回
        if let Some(existing) = worktree_for_branch(&repo_root, &branch)? {
            return Ok(WorktreeEnsureResult {
                worktree_path: existing,
                branch,
                base,
                repo_root,
                created: false,
            });
        }
        // 目录：<repoParent>/.reinagent-worktrees/<repoDirName>/<dirSlug>
        let repo_parent = std::path::Path::new(&repo_root)
            .parent()
            .ok_or_else(|| format!("无法定位仓库父目录：{repo_root}"))?;
        let repo_dir_name = repo_root
            .rsplit('/')
            .next()
            .unwrap_or("repo")
            .to_string();
        let worktree_path = repo_parent
            .join(WORKTREES_DIR_NAME)
            .join(&repo_dir_name)
            .join(&dir_slug);
        let worktree_str = worktree_path.to_string_lossy().replace('\\', "/");
        if worktree_path.exists() {
            return Err(format!(
                "worktree 目录已存在但未挂载分支：{}——请先手工清理",
                worktree_str
            ));
        }
        std::fs::create_dir_all(worktree_path.parent().unwrap()).map_err(|e| format!("创建 worktree 根目录失败：{e}"))?;
        let branch_exists = branch_exists(&repo_root, &branch)?;
        if branch_exists {
            // 清理时保留了分支 → 重挂同名分支（base 不变语义由分支自身携带）
            run_git(&repo_root, &["worktree", "add", &worktree_str, &branch])?;
            Ok(WorktreeEnsureResult {
                worktree_path: worktree_str,
                branch,
                base,
                repo_root,
                created: false,
            })
        } else {
            run_git(&repo_root, &["worktree", "add", &worktree_str, "-b", &branch, &base])?;
            Ok(WorktreeEnsureResult {
                worktree_path: worktree_str,
                branch,
                base,
                repo_root,
                created: true,
            })
        }
    })
    .await
    .map_err(|e| format!("git_worktree_ensure join 失败：{e}"))?
}

/// 合并回主分支：工作树干净 + 主仓干净 + 主仓 HEAD == base → merge --no-ff。
/// 冲突返回未合并文件列表（不自动解决）。
#[tauri::command]
pub async fn git_worktree_merge(
    worktree_path: String,
    base_commit: String,
) -> Result<WorktreeMergeResult, String> {
    tauri::async_runtime::spawn_blocking(move || merge_core(&worktree_path, &base_commit))
        .await
        .map_err(|e| format!("git_worktree_merge join 失败：{e}"))?
}

/// 合并核心（同步，单测可直接调用）。
fn merge_core(worktree_path: &str, base_commit: &str) -> Result<WorktreeMergeResult, String> {
    let result: Result<WorktreeMergeResult, String> = (|| {
        // 1. 工作树必须干净
        if !is_clean(&worktree_path)? {
            return Ok(WorktreeMergeResult {
                merged: false,
                merge_commit: None,
                conflict: Some(WorktreeMergeConflict {
                    message: "工作树有未提交改动——先提交或暂存".to_string(),
                    unmerged_files: Vec::new(),
                }),
            });
        }
        // 2. 主仓定位 + 分支名
        let repo_root = main_repo_root_of_worktree(&worktree_path)?;
        let branch = run_git(&worktree_path, &["branch", "--show-current"])?
            .trim()
            .to_string();
        if branch.is_empty() {
            return Err("工作树处于 detached HEAD，无法合并".to_string());
        }
        // 3. 主仓必须干净（RED-CHECK 缝：移除此校验会让未提交改动被卷入合并提交）
        if !is_clean(&repo_root)? {
            return Ok(WorktreeMergeResult {
                merged: false,
                merge_commit: None,
                conflict: Some(WorktreeMergeConflict {
                    message: "主工作区有未提交改动——先提交或暂存再合并".to_string(),
                    unmerged_files: Vec::new(),
                }),
            });
        }
        // 4. 主仓 HEAD 必须仍在 base（任务基于的提交）；主仓前进了 → 提示先同步
        let main_head = head_commit(&repo_root)?;
        if main_head != base_commit {
            return Ok(WorktreeMergeResult {
                merged: false,
                merge_commit: None,
                conflict: Some(WorktreeMergeConflict {
                    message: format!(
                        "主工作区 HEAD 已偏离任务基点（base {}）——请先在主工作区同步后再合并",
                        &base_commit[..base_commit.len().min(8)]
                    ),
                    unmerged_files: Vec::new(),
                }),
            });
        }
        // 5. --no-ff 合并
        let merge_message = format!("Merge task branch: {branch}");
        let merge_result = run_git(&repo_root, &["merge", "--no-ff", &branch, "-m", &merge_message]);
        if let Err(err) = merge_result {
            // 冲突：收集未合并文件列表
            let unmerged = run_git(&repo_root, &["diff", "--name-only", "--diff-filter=U"])
                .unwrap_or_default()
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect();
            // 回滚冲突现场（merge --abort），保持主仓干净——由用户手工决定后续
            let _ = run_git(&repo_root, &["merge", "--abort"]);
            return Ok(WorktreeMergeResult {
                merged: false,
                merge_commit: None,
                conflict: Some(WorktreeMergeConflict {
                    message: format!("合并冲突（已自动回滚，可手工合并）：{err}"),
                    unmerged_files: unmerged,
                }),
            });
        }
        let merge_commit = head_commit(&repo_root)?;
        Ok(WorktreeMergeResult {
            merged: true,
            merge_commit: Some(merge_commit),
            conflict: None,
        })
    })();
    result
}

/// 移除工作树（可选删分支）+ prune。
#[tauri::command]
pub async fn git_worktree_remove(
    worktree_path: String,
    branch: String,
    delete_branch: bool,
    force: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 先定位主仓（工作树移除后 .git 指针文件即消失，必须先读；且 remove 必须
        // 从主仓侧执行——在被删的工作树里跑 git，Windows 下 cwd 被删会让 git 异常退出）
        let repo_root = main_repo_root_of_worktree(&worktree_path)?;
        let mut remove_args = vec!["worktree", "remove"];
        if force {
            remove_args.push("--force");
        }
        remove_args.push(worktree_path.as_str());
        run_git(&repo_root, &remove_args)?;
        if delete_branch {
            run_git(&repo_root, &["branch", "-D", &branch])?;
        }
        run_git(&repo_root, &["worktree", "prune"])?;
        Ok(())
    })
    .await
    .map_err(|e| format!("git_worktree_remove join 失败：{e}"))?
}

/// 可移除性判定（idle 由 TS 按任务 updatedAt 计算并叠加）。
#[tauri::command]
pub async fn git_worktree_eligibility(
    worktree_path: String,
    branch: String,
) -> Result<WorktreeEligibility, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let clean = is_clean(&worktree_path)?;
        // 已合并判定必须在主仓做（worktree 的 HEAD 就是任务分支本身）：
        // HEAD..branch = 分支上有而主仓当前历史没有的提交数，0 = 已合并
        let repo_root = main_repo_root_of_worktree(&worktree_path)?;
        let count = run_git(
            &repo_root,
            &["rev-list", "--count", &format!("HEAD..{branch}")],
        )?;
        let merged_into_base = count.trim() == "0";
        Ok(WorktreeEligibility {
            clean,
            merged_into_base,
            removable: clean && merged_into_base,
        })
    })
    .await
    .map_err(|e| format!("git_worktree_eligibility join 失败：{e}"))?
}

// ==================== 测试 ====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_keeps_ascii_cjk_collapses_symbols() {
        assert_eq!(slugify_title("猫的名字、年龄与花色问！？", 30), "猫的名字-年龄与花色问");
        assert_eq!(slugify_title("Fix: the QrCode Bug (v2)!!", 30), "fix-the-qrcode-bug-v2");
        assert_eq!(slugify_title("   ---   ", 30), "task");
        assert_eq!(slugify_title("", 30), "task");
        // 限长
        assert_eq!(slugify_title("abcdefghij".repeat(5).as_str(), 30).chars().count(), 30);
    }

    #[test]
    fn short_id_extracts_suffix() {
        assert_eq!(short_id_of("task-1792837972598-4xnx0"), "4xnx0");
        assert_eq!(short_id_of("task-123-abc"), "abc");
        assert_eq!(short_id_of("weird-id"), "rd-id");
    }

    #[test]
    fn slug_dir_strips_prefix() {
        assert_eq!(slug_dir_of("reinagent/my-task-abc"), "my-task-abc");
    }
}

#[cfg(test)]
mod git_worktree_tests {
    use super::*;
    use crate::git_panel::is_not_repo_error;
    use std::path::Path;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) -> String {
        run_git(dir.to_str().expect("utf8 path"), args).expect("git ok")
    }

    fn init_repo_with_commit(dir: &Path) {
        std::fs::create_dir_all(dir).expect("mkdir");
        git(dir, &["init", "-b", "main"]);
        git(dir, &["config", "user.email", "test@test.local"]);
        git(dir, &["config", "user.name", "test"]);
        std::fs::write(dir.join("a.txt"), "line1\nline2\n").expect("write");
        git(dir, &["add", "a.txt"]);
        git(dir, &["commit", "-m", "init"]);
    }

    fn ensure_on(dir: &Path, task_id: &str, title: &str) -> WorktreeEnsureResult {
        let repo_root = repo_root_of(dir.to_str().unwrap()).expect("repo root");
        let base = head_commit(&repo_root).expect("head");
        let short_id = short_id_of(task_id);
        let (branch, dir_slug) = deterministic_branch_name(title, &short_id);
        if let Some(existing) = worktree_for_branch(&repo_root, &branch).expect("lookup") {
            return WorktreeEnsureResult { worktree_path: existing, branch, base, repo_root, created: false };
        }
        let repo_parent = Path::new(&repo_root).parent().unwrap();
        let repo_dir_name = repo_root.rsplit('/').next().unwrap().to_string();
        let worktree_path = repo_parent.join(WORKTREES_DIR_NAME).join(&repo_dir_name).join(&dir_slug);
        let worktree_str = worktree_path.to_string_lossy().replace('\\', "/");
        std::fs::create_dir_all(worktree_path.parent().unwrap()).expect("mkdir parents");
        git(Path::new(&repo_root), &["worktree", "add", &worktree_str, "-b", &branch, &base]);
        WorktreeEnsureResult { worktree_path: worktree_str, branch, base, repo_root, created: true }
    }

    fn temp_repo(tag: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let temp = tempfile::tempdir().expect("tempdir");
        let repo = temp.path().join(tag);
        init_repo_with_commit(&repo);
        (temp, repo)
    }

    #[test]
    fn ensure_creates_idempotent_and_names_branch() {
        let (_t, repo) = temp_repo("wt-ensure");
        let first = ensure_on(&repo, "task-1792-abc1", "猫的名字、年龄与花色");
        assert!(first.created);
        assert!(first.branch.starts_with("reinagent/猫的名字-年龄与花色-abc1"), "branch={}", first.branch);
        assert!(Path::new(&first.worktree_path).exists(), "工作树目录应存在");
        assert!(first.worktree_path.contains(WORKTREES_DIR_NAME), "应在 .reinagent-worktrees 下");
        // worktree 内 a.txt 存在（检出成功）
        assert!(Path::new(&first.worktree_path).join("a.txt").exists());
        // 幂等：同 task 再 ensure → 同路径不新建
        let second = ensure_on(&repo, "task-1792-abc1", "猫的名字、年龄与花色");
        assert!(!second.created);
        assert_eq!(second.worktree_path, first.worktree_path);
        assert_eq!(second.branch, first.branch);
    }

    #[test]
    fn different_tasks_get_distinct_branches() {
        let (_t, repo) = temp_repo("wt-seq");
        let first = ensure_on(&repo, "task-1792-aaa1", "同标题任务");
        let second = ensure_on(&repo, "task-1792-bbb2", "同标题任务");
        assert_ne!(first.branch, second.branch, "不同 task_id 必然不同分支");
        assert!(Path::new(&first.worktree_path).exists());
        assert!(Path::new(&second.worktree_path).exists());
    }

    #[test]
    fn ensure_on_non_git_dir_errors() {
        let temp = tempfile::tempdir().expect("tempdir");
        let plain = temp.path().join("plain");
        std::fs::create_dir_all(&plain).expect("mkdir");
        let err = repo_root_of(plain.to_str().unwrap()).expect_err("non-git must fail");
        assert!(is_not_repo_error(&err) || err.contains("GIT_NOT_REPO"), "实际：{err}");
    }

    #[test]
    fn merge_no_ff_success_then_eligibility_and_remove() {
        let (_t, repo) = temp_repo("wt-merge");
        let wt = ensure_on(&repo, "task-1792-del1", "交付任务");
        // 任务分支里改文件并提交
        std::fs::write(Path::new(&wt.worktree_path).join("a.txt"), "line1\nchanged by task\n").expect("write");
        let wpath = Path::new(&wt.worktree_path);
        git(wpath, &["add", "a.txt"]);
        git(wpath, &["commit", "-m", "task change"]);
        // 主仓 HEAD 仍在 base → 可合并
        let result = std::thread::scope(|_| {
            let repo_root = wt.repo_root.clone();
            let base = wt.base.clone();
            // 同步调 merge 核心逻辑（不经 spawn_blocking 的 async 包装，直接内联）
            let clean = is_clean(&wt.worktree_path).expect("clean check");
            assert!(clean, "工作树应干净");
            let main_head = head_commit(&repo_root).expect("main head");
            assert_eq!(main_head, base, "主仓 HEAD 应等于 base");
            let merge = run_git(&repo_root, &["merge", "--no-ff", &wt.branch, "-m", &format!("Merge task branch: {}", wt.branch)]);
            merge.expect("merge should succeed");
        });
        let _ = result;
        // --no-ff 合并节点应有双亲
        let parents = git(Path::new(&wt.repo_root), &["rev-list", "--parents", "-1", "HEAD"]);
        assert_eq!(parents.trim().split(' ').count(), 3, "--no-ff 应产生双亲合并提交：{parents}");
        // 合并后主仓 a.txt 是任务版
        let content = std::fs::read_to_string(Path::new(&wt.repo_root).join("a.txt")).expect("read");
        assert!(content.contains("changed by task"));
        // eligibility：已合并判定在主仓（base..branch 无独有提交）+ 干净 → removable
        let clean = is_clean(&wt.worktree_path).expect("clean");
        let count = git(Path::new(&wt.repo_root), &["rev-list", "--count", &format!("HEAD..{}", wt.branch)]);
        let eligibility = WorktreeEligibility {
            clean,
            merged_into_base: count.trim() == "0",
            removable: clean && count.trim() == "0",
        };
        assert!(eligibility.removable, "合并后应可清理：{eligibility:?}");
        // remove（带删分支）
        let repo_root = main_repo_root_of_worktree(&wt.worktree_path).expect("main root");
        git(Path::new(&repo_root), &["worktree", "remove", &wt.worktree_path]);
        git(Path::new(&repo_root), &["branch", "-D", &wt.branch]);
        git(Path::new(&repo_root), &["worktree", "prune"]);
        assert!(!Path::new(&wt.worktree_path).exists(), "工作树目录应被移除");
        let branches = git(Path::new(&repo_root), &["branch", "--list", &wt.branch]);
        assert!(!branches.contains(&wt.branch), "分支应被删除");
    }

    #[test]
    fn merge_rejects_dirty_main_and_base_mismatch() {
        let (_t, repo) = temp_repo("wt-reject");
        let wt = ensure_on(&repo, "task-1792-rej1", "拒绝场景");
        // 场景 A：主仓脏 → 结构化拒绝
        std::fs::write(repo.join("dirty.txt"), "uncommitted").expect("write dirty");
        let main_dirty = is_clean(repo.to_str().unwrap()).expect("check");
        assert!(!main_dirty, "主仓应有未提交改动");
        // 场景 B：主仓前进（HEAD != base）→ 结构化拒绝（先清掉场景 A 的脏文件）
        std::fs::remove_file(repo.join("dirty.txt")).expect("remove dirty");
        std::fs::write(repo.join("b.txt"), "main advance\n").expect("write b");
        git(&repo, &["add", "b.txt"]);
        git(&repo, &["commit", "-m", "main advance"]);
        let main_head = head_commit(repo.to_str().unwrap()).expect("head");
        assert_ne!(main_head, wt.base, "主仓 HEAD 应已偏离 base");

        // 直调合并核心：base 偏离 → 结构化拒绝（Red Check 缝：移除 base 校验此处必红）
        let rejected = merge_core(&wt.worktree_path, &wt.base).expect("merge core");
        assert!(!rejected.merged, "base 偏离必须拒绝");
        assert!(rejected.conflict.as_ref().expect("conflict").message.contains("偏离"), "实际：{}", rejected.conflict.as_ref().unwrap().message);
    }

    #[test]
    fn merge_core_rejects_dirty_main() {
        let (_t, repo) = temp_repo("wt-dirty");
        let wt = ensure_on(&repo, "task-1792-dirty", "脏主仓场景");
        // 主仓弄脏（未提交）
        std::fs::write(repo.join("dirty.txt"), "uncommitted").expect("write");
        let rejected = merge_core(&wt.worktree_path, &wt.base).expect("merge core");
        assert!(!rejected.merged, "脏主仓必须拒绝");
        assert!(
            rejected
                .conflict
                .as_ref()
                .expect("conflict")
                .message
                .contains("主工作区有未提交改动"),
            "实际：{}",
            rejected.conflict.map(|c| c.message).unwrap_or_default()
        );
    }
}
