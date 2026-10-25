//! git_pr 单测：remote host/slug 解析、gh/glab JSON 解析、动作参数映射、标签映射。
//! 运行：cargo test --lib git_pr

use crate::git_pr::{
    build_action_args, install_hint, merge_state_label, parse_checks, parse_comments,
    parse_pr_element, parse_pr_list, parse_remote_host, parse_repo_slug, review_label,
};

#[test]
fn remote_host_ssh_and_https() {
    assert_eq!(parse_remote_host("git@github.com:web3claw/ReinAgent.git").as_deref(), Some("github.com"));
    assert_eq!(parse_remote_host("https://github.com/web3claw/ReinAgent.git").as_deref(), Some("github.com"));
    assert_eq!(parse_remote_host("git@gitlab.com:group/sub/repo.git").as_deref(), Some("gitlab.com"));
    assert_eq!(parse_remote_host("ssh://git@gitlab.example.com:2222/g/r.git").as_deref(), Some("gitlab.example.com"));
    // 无端口 ssh 形态：@ 后无冒号只有斜杠——只认冒号的实现会解析失败
    assert_eq!(parse_remote_host("ssh://git@gitlab.example.com/g/r.git").as_deref(), Some("gitlab.example.com"));
    assert_eq!(parse_remote_host(""), None);
}

#[test]
fn repo_slug_variants() {
    assert_eq!(parse_repo_slug("git@github.com:web3claw/ReinAgent.git").as_deref(), Some("web3claw/ReinAgent"));
    assert_eq!(parse_repo_slug("https://github.com/web3claw/ReinAgent.git").as_deref(), Some("web3claw/ReinAgent"));
    assert_eq!(parse_repo_slug("https://gitlab.com/group/sub/repo").as_deref(), Some("group/sub"));
    assert_eq!(parse_repo_slug("git@github.com:only-owner"), None);
}

#[test]
fn parse_github_pr_object() {
    let json = r#"{
        "number": 12, "title": "feat: x", "url": "https://github.com/o/r/pull/12",
        "state": "OPEN", "isDraft": true, "baseRefName": "main", "headRefName": "dev",
        "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "reviewDecision": "",
        "additions": 10, "deletions": 4, "changedFiles": 3
    }"#;
    let doc: serde_json::Value = serde_json::from_str(json).unwrap();
    let pr = parse_pr_element("github", &doc).unwrap();
    assert_eq!(pr.number, 12);
    assert!(pr.is_draft);
    assert_eq!(pr.base_branch, "main");
    // gh 无审查结论回传空串 → 统一 None（调用方只判空）
    assert_eq!(pr.review_decision, None);
    assert_eq!(pr.additions, 10);
}

#[test]
fn parse_gitlab_mr_object_with_pipeline() {
    let json = r#"{
        "iid": 7, "title": "mr", "web_url": "https://gitlab.com/g/r/-/merge_requests/7",
        "state": "opened", "draft": true, "target_branch": "main", "source_branch": "dev",
        "merge_status": "can_be_merged", "detailed_merge_status": "ci_still_running",
        "approved": true,
        "head_pipeline": { "status": "failed", "web_url": "https://gitlab.com/g/r/-/pipelines/9" }
    }"#;
    let doc: serde_json::Value = serde_json::from_str(json).unwrap();
    let pr = parse_pr_element("gitlab", &doc).unwrap();
    assert_eq!(pr.number, 7);
    assert!(pr.is_draft);
    assert_eq!(pr.review_decision.as_deref(), Some("APPROVED"));
    assert_eq!(pr.merge_state_status, "ci_still_running");
    // head_pipeline 映射成一条 fail 检查
    assert_eq!(pr.checks.len(), 1);
    assert_eq!(pr.checks[0].bucket, "fail");
    assert_eq!(pr.checks[0].name, "pipeline");
}

#[test]
fn parse_pr_list_tolerates_garbage() {
    let list = parse_pr_list("github", r#"[{"number":1,"title":"a","url":"u","state":"OPEN"},{"number":2,"title":"b","url":"v","state":"OPEN"}]"#);
    assert_eq!(list.len(), 2);
    assert_eq!(parse_pr_list("github", "not json").len(), 0);
    assert_eq!(parse_pr_list("github", r#"{"object":1}"#).len(), 0);
}

#[test]
fn parse_checks_buckets_and_limit() {
    let json = r#"[
        {"name":"build","workflow":"CI","state":"FAILURE","bucket":"fail","link":"https://github.com/o/r/actions/runs/123/job/1"},
        {"name":"lint","state":"PENDING","bucket":"pending"},
        {"no-name":{"x":1}},
        {"name":"e","state":"SKIP","bucket":"skipping"}
    ]"#;
    let checks = parse_checks(json);
    assert_eq!(checks.len(), 3);
    assert_eq!(checks[0].bucket, "fail");
    assert_eq!(checks[0].workflow.as_deref(), Some("CI"));
    // 大量条目触发 40 上限
    let many: Vec<String> = (0..60).map(|i| format!(r#"{{"name":"c{i}","bucket":"pass"}}"#)).collect();
    assert_eq!(parse_checks(&format!("[{}]", many.join(","))).len(), 40);
}

#[test]
fn parse_comments_truncation_and_fields() {
    let long_body = "x".repeat(2500);
    let json = format!(
        r#"[{{"body":"{}","user":{{"login":"alice"}},"path":"src/a.rs","line":12,"created_at":"2026-10-01T00:00:00Z"}},{{"body":"  ","user":{{"login":"bob"}}}}]"#,
        long_body
    );
    let comments = parse_comments(&json, "review");
    // 无正文（纯空白）记录跳过
    assert_eq!(comments.len(), 1);
    assert_eq!(comments[0].author, "alice");
    assert_eq!(comments[0].path.as_deref(), Some("src/a.rs"));
    assert_eq!(comments[0].line, Some(12));
    // 正文截断到 2000 字符 + 省略号（… 为 3 字节 UTF-8，故按字符数断言）
    assert_eq!(comments[0].body.chars().count(), 2001);
    assert!(comments[0].body.ends_with('…'));
}

#[test]
fn state_labels() {
    assert_eq!(merge_state_label("CLEAN", "MERGEABLE"), "可合并");
    assert_eq!(merge_state_label("whatever", "CONFLICTING"), "有冲突");
    assert_eq!(merge_state_label("BEHIND", ""), "落后源分支");
    assert_eq!(merge_state_label("", ""), "未知");
    assert_eq!(review_label(Some("APPROVED")), "已通过审查");
    assert_eq!(review_label(Some("CHANGES_REQUESTED")), "要求修改");
    assert_eq!(review_label(None), "待审查");
}

#[test]
fn action_args_gh_vs_glab() {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<String>>();
    // gh ready / draft
    assert_eq!(build_action_args("gh", "ready", None, false, "dev").unwrap(), s(&["pr", "ready"]));
    assert_eq!(build_action_args("gh", "draft", None, false, "dev").unwrap(), s(&["pr", "ready", "--undo"]));
    // gh merge：未指定方法默认 --merge；squash/rebase 透传；delete-branch 附加
    assert_eq!(build_action_args("gh", "merge", None, true, "dev").unwrap(), s(&["pr", "merge", "--merge", "--delete-branch"]));
    assert_eq!(build_action_args("gh", "merge", Some("squash"), false, "dev").unwrap(), s(&["pr", "merge", "--squash"]));
    assert_eq!(build_action_args("gh", "merge", Some("rebase"), false, "dev").unwrap(), s(&["pr", "merge", "--rebase"]));
    // glab：ready/draft 走 mr update；merge 只认 squash/rebase，默认无 flag + --remove-source-branch
    assert_eq!(build_action_args("glab", "ready", None, false, "dev").unwrap(), s(&["mr", "update", "--ready"]));
    assert_eq!(build_action_args("glab", "merge", None, true, "dev").unwrap(), s(&["mr", "merge", "--yes", "--remove-source-branch"]));
    assert_eq!(build_action_args("glab", "merge", Some("squash"), false, "dev").unwrap(), s(&["mr", "merge", "--yes", "--squash"]));
    // 未知动作
    assert!(build_action_args("gh", "explode", None, false, "dev").is_none());
}

#[test]
fn install_hint_matches_platform() {
    // 本机是 Linux：apt 引导
    assert_eq!(install_hint("gh"), "sudo apt install gh");
    assert_eq!(install_hint("glab"), "sudo apt install glab");
}

#[test]
fn close_reopen_carry_explicit_target() {
    // gh 2.103 实测：pr close/reopen 不接受隐式当前分支（"number, url, or branch required"）
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<String>>();
    assert_eq!(build_action_args("gh", "close", None, false, "feat/x").unwrap(), s(&["pr", "close", "feat/x"]));
    assert_eq!(build_action_args("gh", "reopen", None, false, "feat/x").unwrap(), s(&["pr", "reopen", "feat/x"]));
    assert_eq!(build_action_args("glab", "close", None, false, "feat/x").unwrap(), s(&["mr", "close", "feat/x"]));
}
