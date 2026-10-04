//! fs_cmd 单测：`.ReinAgent/.gitignore` 幂等补建（使 agent 一次性产物不进用户 git 仓库）。

use crate::fs_cmd::{ensure_gitignore_for_reinagent_path, ensure_reinagent_gitignore};
use std::fs;
use std::path::Path;

#[test]
fn reinagent_gitignore_created_once_and_not_overwritten() {
    let ws = std::env::temp_dir().join(format!("reinagent-gi-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&ws);
    let ra = ws.join(".ReinAgent");

    ensure_reinagent_gitignore(&ra);
    let gi = ra.join(".gitignore");
    assert!(gi.exists());
    let content = fs::read_to_string(&gi).unwrap();
    assert_eq!(content, ".temp/\n.gitignore\n");

    // 用户改过内容后，再次 ensure 不得覆盖
    fs::write(&gi, "# my own rules\n").unwrap();
    ensure_reinagent_gitignore(&ra);
    assert_eq!(fs::read_to_string(&gi).unwrap(), "# my own rules\n");
    let _ = fs::remove_dir_all(&ws);
}

#[test]
fn gitignore_ensured_for_writes_under_reinagent_any_depth() {
    let ws = std::env::temp_dir().join(format!("reinagent-gi-deep-{}", std::process::id()));
    let _ = fs::remove_dir_all(&ws);
    fs::create_dir_all(ws.join("project/nested")).unwrap();

    // 任意深度命中：project/nested/.ReinAgent/.temp/x.js → .gitignore 建在 .ReinAgent 下
    let target = ws.join("project/nested/.ReinAgent/.temp/x.js");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    ensure_gitignore_for_reinagent_path(&target);
    assert!(ws.join("project/nested/.ReinAgent/.gitignore").exists());

    // 相似名字不触发（.ReinAgentFoo）
    let other = ws.join("project/.ReinAgentFoo/bar.txt");
    ensure_gitignore_for_reinagent_path(&other);
    assert!(!ws.join("project/.ReinAgentFoo/.gitignore").exists());

    // 普通路径不触发
    let plain = ws.join("project/src/main.rs");
    ensure_gitignore_for_reinagent_path(&plain);
    assert!(!ws.join("project/.gitignore").exists());
    let _ = fs::remove_dir_all(&ws);
}
