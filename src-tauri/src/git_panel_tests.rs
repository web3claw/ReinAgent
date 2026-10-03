//! git_panel 单测：porcelain 解析 / 分支列表解析 / log 解析 / 分支名校验。
//! 运行：cargo test --lib git_panel

use crate::git_panel::{git_checkout, GitCheckoutArgs};

#[test]
fn checkout_rejects_injection_and_empty() {
    // 分支名白名单字符校验：防注入（git CLI 无 shell，但引用路径仍收敛）
    fn check(branch: &str) -> Result<(), String> {
        let trimmed = branch.trim();
        if trimmed.is_empty()
            || trimmed.len() > 200
            || trimmed.chars().any(|c| !(c.is_ascii_alphanumeric() || "/-_.+".contains(c)))
        {
            return Err(format!("git_checkout: 非法分支名 {trimmed}"));
        }
        Ok(())
    }
    assert!(check("feature/x-1.2").is_ok());
    assert!(check("main").is_ok());
    assert!(check("").is_err());
    assert!(check("a; rm -rf /").is_err());
    assert!(check("$(calc)").is_err());
    assert!(check(&"x".repeat(201)).is_err());
    // 命令包装本身也做同样校验（传非法分支名直接 Err，不 spawn git）
    let result = git_checkout(GitCheckoutArgs {
        cwd: ".".into(),
        branch: "a;b".into(),
    });
    match tokio::runtime::Runtime::new().unwrap().block_on(result) {
        Err(msg) => assert!(msg.contains("非法分支名")),
        Ok(()) => panic!("非法分支名应被拒绝"),
    }
}

#[test]
fn checkout_validates_against_real_repo() {
    // 仅在源码目录真是 git 仓库时执行：/tmp 隔离构建区不含 .git（rsync 排除），
    // 此时 git 报"不是仓库"而非"分支不存在"，属环境差异而非功能回归，跳过。
    if !std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(".git")
        .exists()
    {
        eprintln!("跳过：当前构建目录不是 git 仓库（/tmp 隔离区）");
        return;
    }
    // 真仓库（本仓库源码）+ 合法但不存在的分支 → git 拒绝原文上抛
    let result = git_checkout(GitCheckoutArgs {
        cwd: env!("CARGO_MANIFEST_DIR").into(),
        branch: "no-such-branch-xyz".into(),
    });
    match tokio::runtime::Runtime::new().unwrap().block_on(result) {
        Err(msg) => assert!(msg.contains("checkout"), "git 拒绝原文应上抛: {msg}"),
        Ok(()) => panic!("不存在的分支应失败"),
    }
}

// ---------------------------------------------------------------------------
// 顶栏分支切换器（git_branch_switch 归因链）单测
// ---------------------------------------------------------------------------

use crate::git_panel::{
    extract_indented_paths, has_conflicted_entries, parse_branch_mutation_issues, parse_numstat,
    GitNumStatFile, GitStatusEntry,
};

#[test]
fn branch_issues_parse_tracked_overwrite_with_paths() {
    let stderr = "error: Your local changes to the following files would be overwritten by checkout:\n\
                  \tsrc/App.tsx\n\
                  \tsrc/lib/git/api.ts\n\
                  Please commit your changes or stash them before you switch branches.\n\
                  Aborting";
    let issues = parse_branch_mutation_issues(stderr, "");
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].code, "tracked-changes-would-be-overwritten");
    let paths = issues[0].paths.as_ref().unwrap();
    assert_eq!(paths, &vec!["src/App.tsx".to_string(), "src/lib/git/api.ts".to_string()]);
}

#[test]
fn branch_issues_parse_untracked_overwrite() {
    let stderr = "error: The following untracked working tree files would be overwritten by switch:\n\
                  \tnew.txt\n\
                  Please move or remove them before you switch branches.\n\
                  Aborting";
    let issues = parse_branch_mutation_issues(stderr, "");
    assert_eq!(issues[0].code, "untracked-changes-would-be-overwritten");
    assert_eq!(issues[0].paths.as_ref().unwrap(), &vec!["new.txt".to_string()]);
}

#[test]
fn branch_issues_parse_known_failure_codes() {
    let cases = [
        ("fatal: a branch named 'x' already exists", "branch-already-exists"),
        ("fatal: invalid reference: nope", "target-branch-not-found"),
        ("fatal: 'dev' is already used by worktree at 'C:/other'", "branch-in-other-worktree"),
        ("fatal: You need to resolve your current index first", "conflicts-present"),
        ("fatal: cannot switch branch while rebasing", "operation-in-progress"),
        ("fatal: You have not concluded your merge (MERGE_HEAD exists)", "operation-in-progress"),
    ];
    for (stderr, code) in cases {
        let issues = parse_branch_mutation_issues(stderr, "");
        assert_eq!(issues[0].code, code, "stderr: {stderr}");
        assert!(issues[0].detail.is_some());
    }
}

#[test]
fn branch_issues_unknown_falls_back_with_detail() {
    let issues = parse_branch_mutation_issues("fatal: some totally new git error", "");
    assert_eq!(issues[0].code, "unknown");
    assert_eq!(issues[0].detail.as_deref(), Some("fatal: some totally new git error"));
}

#[test]
fn extract_paths_stops_at_non_indented_line() {
    let lines = [
        "error: Your local changes to the following files would be overwritten by checkout:",
        "\ta.ts",
        "    b.ts",
        "Please commit your changes or stash them before you switch branches.",
        "\tnot-a-path.ts",
    ];
    let paths = extract_indented_paths(&lines, "would be overwritten by");
    assert_eq!(paths, vec!["a.ts".to_string(), "b.ts".to_string()]);
}

#[test]
fn conflicted_codes_detection() {
    let mk = |code: &str| GitStatusEntry {
        code: code.to_string(),
        path: "p".to_string(),
        index_code: code.chars().next().unwrap_or(' ').to_string(),
        worktree_code: code.chars().nth(1).unwrap_or(' ').to_string(),
    };
    assert!(has_conflicted_entries(&[mk("UU")]));
    assert!(has_conflicted_entries(&[mk("AA")]));
    assert!(has_conflicted_entries(&[mk("DD")]));
    assert!(!has_conflicted_entries(&[mk("M"), mk("??")]));
}

#[test]
fn numstat_merges_staged_and_untracked_binary() {
    let mut files: Vec<GitNumStatFile> = Vec::new();
    // 工作区：a.ts +3/-1；binary 记 0；暂存：a.ts +2/-2（同文件求和）、b.ts 新增
    parse_numstat("3\t1\ta.ts\n-\t-\timg.png\n", &mut files);
    parse_numstat("2\t2\ta.ts\n0\t0\tb.ts\n", &mut files);
    assert_eq!(files.len(), 3);
    let a = files.iter().find(|f| f.path == "a.ts").unwrap();
    assert_eq!((a.added, a.removed), (5, 3));
    let img = files.iter().find(|f| f.path == "img.png").unwrap();
    assert_eq!((img.added, img.removed), (0, 0));
}

#[test]
fn stage_skips_vanished_paths_and_stages_rest() {
    use crate::git_panel::{git_stage, GitStageArgs, GitStageResponse};
    use std::fs;
    // 真临时仓库：init + 提交一个文件（-c 内联身份，避免依赖全局配置）
    let repo = std::env::temp_dir().join(format!("reinagent-stage-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&repo);
    fs::create_dir_all(&repo).unwrap();
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .current_dir(&repo)
            .output()
            .unwrap()
    };
    assert!(git(&["init", "-q", "-b", "main"]).status.success());
    fs::write(repo.join("a.txt"), "a").unwrap();
    fs::write(repo.join("b.txt"), "b").unwrap();
    assert!(git(&["-c", "user.name=t", "-c", "user.email=t@e", "add", "."]).status.success());
    assert!(
        git(&["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "init"]).status.success()
    );
    // a.txt 改动存在；c-missing.txt 从未存在（模拟 status 快照后文件消失）
    fs::write(repo.join("a.txt"), "a2").unwrap();

    let result: GitStageResponse = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(git_stage(GitStageArgs {
            cwd: repo.to_string_lossy().to_string(),
            paths: vec!["a.txt".into(), "c-missing.txt".into()],
        }))
        .unwrap();
    assert_eq!(result.skipped, vec!["c-missing.txt".to_string()]);
    // a.txt 确实进了暂存区
    let status = String::from_utf8(git(&["status", "--porcelain"]).stdout).unwrap();
    assert!(status.contains("M  a.txt"), "a.txt 应已暂存: {status}");
    let _ = fs::remove_dir_all(&repo);
}
