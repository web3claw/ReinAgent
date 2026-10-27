//! SSH 真实链路测试（⑫ Real Usage，交付三铁律）：
//! 经代理连接真实测试机（root@47.82.144.54）跑远端文件操作全链。
//! 凭据全部经环境变量注入（严禁写入仓库）：
//!   REINAGENT_SSH_TEST_HOST / USER / PORT / PASSWORD / PROXY
//! 运行：REINAGENT_SSH_TEST_PASSWORD=... cargo test --lib ssh_real_tests -- --ignored --nocapture

use crate::ssh_remote::*;
use std::sync::atomic::{AtomicBool, Ordering};

static CLEANED: AtomicBool = AtomicBool::new(false);

fn test_target() -> SshTarget {
    let host = std::env::var("REINAGENT_SSH_TEST_HOST").unwrap_or_else(|_| "47.82.144.54".into());
    let user = std::env::var("REINAGENT_SSH_TEST_USER").unwrap_or_else(|_| "root".into());
    let port: u16 = std::env::var("REINAGENT_SSH_TEST_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(22);
    SshTarget { user: Some(user), host, port, root: "/~/reinagent-ssh-e2e".to_string() }
}

fn require_env() -> bool {
    let pw = std::env::var("REINAGENT_SSH_TEST_PASSWORD").unwrap_or_default();
    if pw.is_empty() {
        eprintln!("[ssh-real] 跳过：未设置 REINAGENT_SSH_TEST_PASSWORD");
        return false;
    }
    // runner 读 REINAGENT_SSH_PASSWORD——把测试凭据映射过去
    std::env::set_var("REINAGENT_SSH_PASSWORD", pw);
    true
}

/// 测试根目录准备：删旧建新（幂等）。⚠ bootstrap 用 root=/root（工作区目录
/// 尚不存在，ssh_run 的 cd root 会失败）；并断言 exit code（ssh_run 对非 0
/// 退出返回 Ok——exit code 是业务语义，调用方必须自查）。
async fn setup(target: &SshTarget) {
    let mut bootstrap = target.clone();
    bootstrap.root = "/root".to_string();
    let o = ssh_run(&bootstrap, "rm -rf /root/reinagent-ssh-e2e && mkdir -p /root/reinagent-ssh-e2e/src", None, 30, None).await.unwrap();
    assert_eq!(o.code, 0, "setup 清理建目录失败: {}", o.combined());
    let o2 = ssh_run(
        &bootstrap,
        "printf 'line one\nline two ERROR\nline three\n' > /root/reinagent-ssh-e2e/src/a.txt && printf 'hello wiki\n' > /root/reinagent-ssh-e2e/readme.md",
        None,
        30,
        None,
    )
    .await
    .unwrap();
    assert_eq!(o2.code, 0, "setup 种子文件失败: {}", o2.combined());
    CLEANED.store(false, Ordering::SeqCst);
}

async fn cleanup(target: &SshTarget) {
    if CLEANED.swap(true, Ordering::SeqCst) {
        return;
    }
    let mut bootstrap = target.clone();
    bootstrap.root = "/root".to_string();
    let _ = ssh_run(&bootstrap, "rm -rf /root/reinagent-ssh-e2e", None, 30, None).await;
}

#[tokio::test]
#[ignore = "真实环境依赖：env 注入凭据 + 代理可达测试机（会真实读写远端临时目录）"]
async fn real_full_chain_via_proxy() {
    if !require_env() {
        return;
    }
    let ws = target_to_workspace(&test_target());
    let mut target = parse_ssh_workspace(&ws).unwrap();
    // root 归一为远端家目录下的测试目录
    target.root = "/root/reinagent-ssh-e2e".to_string();
    setup(&target).await;

    // 1) 连通性：whoami = user
    let who = ssh_whoami(&target).await.unwrap();
    assert_eq!(who, target.user.as_deref().unwrap());

    // 2) list_dir：看到 src/ 与 readme.md
    let entries = ssh_list_dir_entries(&target, &target.root).await.unwrap();
    assert!(entries.iter().any(|e| e == "src"), "entries={entries:?}");
    assert!(entries.iter().any(|e| e == "readme.md"));

    // 3) read：readme.md 内容
    let slice = ssh_read_slice(&target, &format!("{}/readme.md", target.root), 0, 0).await.unwrap();
    assert!(!slice.is_binary);
    assert!(slice.content.contains("hello wiki"));

    // 4) write：新文件 + 读回
    ssh_write_file(&target, &format!("{}/src/new.rs", target.root), "fn main() {}\n").await.unwrap();
    let back = ssh_read_slice(&target, &format!("{}/src/new.rs", target.root), 0, 0).await.unwrap();
    assert!(back.content.contains("fn main()"));

    // 5) edit：精确替换（唯一性校验 + 写回）
    let (n, delta) = ssh_apply_edit(&target, &format!("{}/src/a.txt", target.root), "ERROR", "FIXED", false).await.unwrap();
    assert_eq!(n, 1);
    assert!(delta >= 0); // ERROR→FIXED 等长替换 delta=0 是合法语义
    let after = ssh_read_slice(&target, &format!("{}/src/a.txt", target.root), 0, 0).await.unwrap();
    assert!(after.content.contains("FIXED") && !after.content.contains("ERROR"));

    // 6) glob：*.md 命中 readme.md（远端 find + 正则）
    let matcher = regex::Regex::new("(^|/)readme\\.md$").unwrap();
    let g = ssh_glob(&target, &target.root, "readme.md", 100, &matcher, &["node_modules", ".git", "target", "dist"]).await.unwrap();
    assert_eq!(g.entries.len(), 1);
    assert_eq!(g.entries[0].path, "readme.md");

    // 7) grep：ERROR→FIXED 后 grep FIXED 命中 src/a.txt
    let gr = ssh_grep(&target, &target.root, "FIXED", None, true, 50, &["node_modules", ".git", "target", "dist"]).await.unwrap();
    assert_eq!(gr.hits.len(), 1);
    assert_eq!(gr.hits[0].path, "src/a.txt");
    assert_eq!(gr.hits[0].line, 2);

    // 8) 逃逸守卫：join 远端路径拒绝 ..
    assert!(join_remote(&target.root, "../etc/passwd").is_err());

    // 9) git 只读白名单：非仓库 → GIT_NOT_REPO；写命令被拒
    let git_out = ssh_git(&target, &["status"]).await;
    assert!(git_out.is_err());
    assert!(git_out.unwrap_err().contains("GIT_NOT_REPO"));
    let write_err = ssh_git(&target, &["push"]).await.unwrap_err();
    assert!(write_err.contains("只读"));

    // 10) 删除 + 目录确认
    ssh_delete_file(&target, &format!("{}/src/new.rs", target.root)).await.unwrap();
    let del_err = ssh_delete_file(&target, &format!("{}/src/new.rs", target.root)).await.unwrap_err();
    assert!(del_err.contains("不存在"));
    let dir_err = ssh_delete_file(&target, &format!("{}/src", target.root)).await.unwrap_err();
    assert!(dir_err.contains("只允许删除普通文件"));

    // 11) 断链场景：坏代理端口（顺序执行，避免污染前面步骤的连接环境）
    std::env::set_var("REINAGENT_SSH_PROXY", "127.0.0.1:1");
    let started = std::time::Instant::now();
    let dead = ssh_run(&target, "echo hi", None, 20, None).await;
    let elapsed = started.elapsed();
    std::env::remove_var("REINAGENT_SSH_PROXY");
    let elapsed_ok = elapsed.as_secs() < 30;
    assert!(elapsed_ok, "断链必须快速失败（实际 {:?}）", elapsed);
    match dead {
        Err(msg) => println!("[ssh-real] 断链 → Err（{:?}）：{}", elapsed, msg),
        Ok(out) => assert_ne!(out.code, 0, "断链不该成功执行远端命令"),
    }

    cleanup(&target).await;
    println!("[ssh-real] 全链路通过：whoami/list/read/write/edit/glob/grep/逃逸守卫/git 门禁/delete/断链");
}

// 断链场景（坏代理端口 → 快速失败或非 0 退出，绝不挂死）。
// ⚠ 必须与全链测试串行（改 REINAGENT_SSH_PROXY 会污染并行连接）——已并入全链测试末尾。
