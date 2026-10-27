//! ssh_remote 单测：scheme 解析、逃逸守卫、引号规则、路径拼接/归一、
//! glob 正则、grep 行号锚定解析、代理 no_proxy 匹配。
//! 运行：cargo test --lib ssh_remote_tests
//! 真实链路（经代理连测试机）见 ssh_real_tests（#[ignore] + env 凭据）。

use crate::ssh_remote::*;

#[test]
fn parse_workspace_variants() {
    let t = parse_ssh_workspace("ssh://root@47.82.144.54:22/~/projects/wakefx").unwrap();
    assert_eq!(t.user.as_deref(), Some("root"));
    assert_eq!(t.host, "47.82.144.54");
    assert_eq!(t.port, 22);
    assert_eq!(t.root, "/~/projects/wakefx");

    let t2 = parse_ssh_workspace("ssh://host.example.com/srv/app").unwrap();
    assert_eq!(t2.user, None);
    assert_eq!(t2.port, 22);
    assert_eq!(t2.root, "/srv/app");

    let t3 = parse_ssh_workspace("ssh://deploy@host:2222/~").unwrap();
    assert_eq!(t3.port, 2222);
    assert_eq!(t3.root, "/~");

    assert!(parse_ssh_workspace("ssh://host").is_err(), "缺路径");
    assert!(parse_ssh_workspace("ssh://host:/").is_err(), "空路径");
    assert!(parse_ssh_workspace("ssh://@host/p").is_err(), "空用户");
    assert!(parse_ssh_workspace("ssh://host:abc/p").is_err(), "端口非法");
    assert!(parse_ssh_workspace("/local/path").is_err());

    // 反向
    assert_eq!(target_to_workspace(&t), "ssh://root@47.82.144.54/~/projects/wakefx");
    assert_eq!(target_to_workspace(&t3), "ssh://deploy@host:2222/~");
}

#[test]
fn escape_guard_and_join() {
    assert!(rel_escapes("a/../b"));
    assert!(rel_escapes(".."));
    assert!(!rel_escapes("a/b..c/d"));
    assert!(!rel_escapes(".../a"));
    assert!(join_remote("/srv/app", "../etc/passwd").is_err());
    assert_eq!(join_remote("/srv/app", "src/main.rs").unwrap(), "/srv/app/src/main.rs");
    assert_eq!(join_remote("/srv/app", "").unwrap(), "/srv/app");
    // ~ root 保留展开
    assert_eq!(join_remote("~/projects/wakefx", "src").unwrap(), "$HOME/projects/wakefx/src");
    // 引用规则：$HOME 形态双引号保留展开；空格安全
    assert_eq!(quote_remote_path("$HOME/projects/wakefx/src"), "\"$HOME/projects/wakefx/src\"");
    assert_eq!(quote_remote_path("$HOME/my app"), "\"$HOME/my app\"");
    assert_eq!(quote_remote_path("/srv/plain"), "'/srv/plain'");
    assert_eq!(join_remote("~", "x").unwrap(), "$HOME/x");
}

#[test]
fn relative_to_root_handles_home_forms() {
    assert_eq!(relative_to_root("/srv/app", "/srv/app/src/a.rs").as_deref(), Some("src/a.rs"));
    assert_eq!(relative_to_root("~/w", "$HOME/w/src/a.rs").as_deref(), Some("src/a.rs"));
    assert_eq!(relative_to_root("~/w", "/other/a.rs"), None);
    assert_eq!(relative_to_root("/srv/app", "/srv/other"), None);
}

#[test]
fn quoting_rules() {
    assert_eq!(shell_quote("it's"), "'it'\\''s'");
    assert_eq!(quote_root(""), "\"$HOME\"");
    assert_eq!(quote_root("~"), "\"$HOME\"");
    assert_eq!(quote_root("~/projects"), "\"$HOME/projects\"");
    // Windows 反斜杠习惯归一
    assert_eq!(quote_root("\\~/projects"), "\"$HOME/projects\"");
    assert_eq!(quote_root("/srv/app"), "'/srv/app'");
    assert_eq!(quote_root("/srv/my app"), "'/srv/my app'");
}

#[test]
fn ssh_args_key_vs_password() {
    let t = parse_ssh_workspace("ssh://root@h/~/app").unwrap();
    // Key/Agent：BatchMode 开
    let key_args = build_ssh_args(&t, Some("~/.ssh/id_ed25519"), false, None);
    let joined = key_args.join(" ");
    assert!(joined.contains("-o BatchMode=yes"));
    assert!(joined.contains("-i ~/.ssh/id_ed25519"));
    assert!(joined.contains("root@h"));
    assert!(joined.contains("ServerAliveInterval=5"));
    assert!(joined.contains("ConnectTimeout=10"));
    assert!(joined.contains("StrictHostKeyChecking=accept-new"));
    // 密码：无 BatchMode（否则 askpass 被禁）+ NumberOfPasswordPrompts=1
    let pw_args = build_ssh_args(&t, None, true, None);
    assert!(!pw_args.join(" ").contains("BatchMode"));
    assert!(pw_args.join(" ").contains("NumberOfPasswordPrompts=1"));
    // 代理：ProxyCommand 走 nc HTTP CONNECT
    let proxied = build_ssh_args(&t, None, false, Some("127.0.0.1:7890"));
    assert!(proxied.join(" ").contains("ProxyCommand=nc -X connect -x '127.0.0.1:7890' %h %p"));
}

#[test]
fn proxy_no_proxy_matching() {
    std::env::remove_var("REINAGENT_SSH_PROXY");
    // 无 kv 环境（测试进程无 conversations.db kv 行）→ None
    // 这里的断言只测 no_proxy 规则逻辑：通过 env 显式开/关
    std::env::set_var("REINAGENT_SSH_PROXY", "127.0.0.1:7890");
    assert_eq!(proxy_for_ssh("47.82.144.54").as_deref(), Some("127.0.0.1:7890"));
    // env 置空 = 强制直连
    std::env::set_var("REINAGENT_SSH_PROXY", "");
    assert_eq!(proxy_for_ssh("47.82.144.54"), None);
    std::env::remove_var("REINAGENT_SSH_PROXY");
}

#[test]
fn grep_line_no_anchored_split() {
    // 路径含冒号也能锚定 `:数字:` 段
    assert_eq!(find_line_no_split("/root/a:b.rs:12: code").map(|i| i), Some("/root/a:b.rs".len()));
    assert_eq!(find_line_no_split("/root/plain.rs"), None);
}

#[test]
fn readonly_git_gate() {
    assert!(is_readonly_git_args(&["status"]));
    assert!(is_readonly_git_args(&["log", "--oneline", "-5"]));
    assert!(is_readonly_git_args(&["rev-parse", "HEAD"]));
    assert!(!is_readonly_git_args(&["commit", "-m", "x"]));
    assert!(!is_readonly_git_args(&["push"]));
    assert!(!is_readonly_git_args(&["checkout", "dev"]));
}

#[test]
fn auth_store_roundtrip_and_env_override() {
    let t = parse_ssh_workspace("ssh://u@auth-test-host:22/~/x").unwrap();
    // store 到独立 key 不影响其他键；本机 HOME 可写
    store_ssh_password(&t, "pw-1").unwrap();
    std::env::remove_var("REINAGENT_SSH_PASSWORD");
    assert_eq!(read_ssh_password(&t).as_deref(), Some("pw-1"));
    store_ssh_password(&t, "").unwrap(); // 清空
    std::env::set_var("REINAGENT_SSH_PASSWORD", "env-pw");
    assert_eq!(read_ssh_password(&t).as_deref(), Some("env-pw"), "env 覆盖优先");
    std::env::remove_var("REINAGENT_SSH_PASSWORD");
    assert_eq!(read_ssh_password(&t), None);
}
