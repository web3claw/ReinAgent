//! git_pr 真实链路测试（Real Usage，交付三铁律第 2 条）：
//! 在本仓库（需本机 gh 已登录、origin 可推送）真实创建一个 draft PR 并走完
//! ready → draft → close → reopen → merge(squash) 全动作链，最后清理分支。
//!
//! 依赖真实环境（gh 登录态 + 网络），不进常规套件：
//!   cargo test --lib git_pr_real -- --ignored --nocapture

use crate::git_pr::{git_pr_action, git_pr_create, git_pr_feedback, git_pr_status, GitPrActionArgs, GitPrCreateArgs};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn repo_root() -> String {
    // CARGO_MANIFEST_DIR = src-tauri；仓库根是其上级
    let manifest = env!("CARGO_MANIFEST_DIR");
    std::path::Path::new(manifest)
        .parent()
        .unwrap()
        .to_string_lossy()
        .to_string()
}

fn sh(args: &[&str]) {
    let out = Command::new("git").args(args).current_dir(repo_root()).output().expect("git spawn");
    assert!(
        out.status.success(),
        "git {:?} 失败：{}{}",
        args,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}

/// 无论断言成败都切回 main 并删测试分支（squash merge 已删远端分支）
fn cleanup(branch: &str) {
    sh(&["switch", "main"]);
    let _ = Command::new("git")
        .args(["branch", "-D", branch])
        .current_dir(repo_root())
        .output();
    let _ = Command::new("git")
        .args(["push", "origin", "--delete", branch])
        .current_dir(repo_root())
        .output();
}

/// panic unwind 时也执行清理（AssertUnwindSafe 不需要——Drop guard 天然覆盖）
struct CleanupGuard(String);
impl Drop for CleanupGuard {
    fn drop(&mut self) {
        cleanup(&self.0);
    }
}

#[tokio::test]
#[ignore = "真实环境依赖：gh 已登录 + origin 可推送（会真实创建/合并一个测试 PR）"]
async fn real_pr_lifecycle() {
    let cwd = repo_root();
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let branch = format!("test/pr-e2e-{ts}");
    let _guard = CleanupGuard(branch.clone());

    // 预检：gh 可用 + 干净基线
    let status = git_pr_status(cwd.clone()).await.expect("status 不应 Err");
    assert!(status.is_repo, "本仓库应是 git 仓库");
    assert!(status.tool_installed, "本机 gh 应已安装登录（tool={}）", status.tool);
    assert_eq!(status.tool, "gh");

    // 建分支 + 空提交 + 推送（PR 需要）
    sh(&["switch", "-c", &branch]);
    sh(&["commit", "--allow-empty", "-m", "test: PR 面板 e2e（squash 合并后自清理）"]);
    sh(&["push", "-u", "origin", &branch]);

    let outcome = async {
        // 1) 创建 draft PR
        let created = git_pr_create(GitPrCreateArgs {
            cwd: cwd.clone(),
            title: format!("test: PR 面板 e2e {ts}"),
            body: "真实链路验证（自动测试，squash 合并即自清理）".into(),
            base_branch: Some("main".into()),
            draft: true,
        })
        .await
        .expect("create 不应 Err");
        assert!(created.success, "创建失败：{}", created.output);
        let pr = created.status.pr.as_ref().expect("创建后应有当前分支 PR");
        assert!(pr.is_draft, "创建时勾选 draft 应为草稿");
        assert_eq!(pr.base_branch, "main");
        assert!(pr.number > 0);
        let number = pr.number;

        // 2) ready：草稿转正式
        let readied = git_pr_action(GitPrActionArgs { cwd: cwd.clone(), action: "ready".into(), merge_method: None, delete_branch: None }).await.expect("ready 不应 Err");
        assert!(readied.success, "ready 失败：{}", readied.output);
        assert!(!readied.status.pr.as_ref().unwrap().is_draft, "ready 后应非草稿");

        // 3) draft：转回草稿
        let drafted = git_pr_action(GitPrActionArgs { cwd: cwd.clone(), action: "draft".into(), merge_method: None, delete_branch: None }).await.expect("draft 不应 Err");
        assert!(drafted.success, "draft 失败：{}", drafted.output);
        assert!(drafted.status.pr.as_ref().unwrap().is_draft, "draft 后应为草稿");

        // 4) ready again（draft PR 不能直接 merge）
        let readied2 = git_pr_action(GitPrActionArgs { cwd: cwd.clone(), action: "ready".into(), merge_method: None, delete_branch: None }).await.expect("ready2 不应 Err");
        assert!(readied2.success, "ready2 失败：{}", readied2.output);

        // 5) close → reopen
        let closed = git_pr_action(GitPrActionArgs { cwd: cwd.clone(), action: "close".into(), merge_method: None, delete_branch: None }).await.expect("close 不应 Err");
        assert!(closed.success, "close 失败：{}", closed.output);
        assert_eq!(closed.status.pr.as_ref().unwrap().state.to_uppercase(), "CLOSED");
        let reopened = git_pr_action(GitPrActionArgs { cwd: cwd.clone(), action: "reopen".into(), merge_method: None, delete_branch: None }).await.expect("reopen 不应 Err");
        assert!(reopened.success, "reopen 失败：{}", reopened.output);
        assert_eq!(reopened.status.pr.as_ref().unwrap().state.to_uppercase(), "OPEN");

        // 6) feedback：无 CI 失败时 checks 应为空数组但 hasPr=true（CI 可能仍在跑 → 只断言不炸）
        let fb = git_pr_feedback(cwd.clone()).await.expect("feedback 不应 Err");
        assert!(fb.has_pr, "feedback 应识别当前 PR");
        assert_eq!(fb.number, number);

        // 7) squash merge + 删分支
        let merged = git_pr_action(GitPrActionArgs { cwd: cwd.clone(), action: "merge".into(), merge_method: Some("squash".into()), delete_branch: Some(true) }).await.expect("merge 不应 Err");
        assert!(merged.success, "merge 失败：{}", merged.output);

        Ok::<(), String>(())
    }
    .await;

    // 清理由 Drop guard 执行（squash merge + --delete-branch 后 switch main / branch -D 幂等）
    outcome.expect("PR 生命周期断言失败");
    println!("[real-pr-e2e] 全链路通过：create(draft) → ready → draft → ready → close → reopen → feedback → merge(squash+delete)");
}
