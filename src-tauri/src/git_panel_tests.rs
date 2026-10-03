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
