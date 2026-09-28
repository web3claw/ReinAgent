//! bg_process 单元测试（注册表生命周期；真实进程 spawn 在 Windows 环境也能跑）。
use super::*;
use crate::bg_process::{bg_output_sync, bg_spawn_sync, bg_stop_sync};

#[test]
fn spawn_output_stop_lifecycle() {
    let cmd = "echo bg-test-output";
    let spawned =
        bg_spawn_sync(cmd.into(), Some(std::env::temp_dir().display().to_string()))
            .expect("spawn");
    assert!(spawned.task_id.starts_with("bg-"));

    // 轮询等输出（最多 5s）
    let mut output = String::new();
    for _ in 0..50 {
        let r = bg_output_sync(spawned.task_id.clone(), Some(0)).expect("output");
        output.push_str(&r.new_output);
        if output.contains("bg-test-output") {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    assert!(output.contains("bg-test-output"), "应读到回显输出: {output}");

    // stop：已退出的任务也应幂等可停
    let _stopped = bg_stop_sync(spawned.task_id.clone()).expect("stop");
    // stop 后注册表已移除：再 output 应报任务不存在
    let err = bg_output_sync(spawned.task_id.clone(), None).unwrap_err();
    assert!(err.contains("任务不存在"));
}

#[test]
fn bg_output_unknown_task_errors() {
    let err = bg_output_sync("bg-nonexistent".into(), None).unwrap_err();
    assert!(err.contains("任务不存在"));
}

#[test]
fn bg_stop_unknown_task_is_idempotent() {
    let r = bg_stop_sync("bg-nonexistent".into()).expect("stop");
    assert!(!r.stopped, "不存在的任务 stopped=false（幂等）");
}

#[test]
fn long_running_process_can_be_stopped() {
    let cmd = if cfg!(target_os = "windows") {
        "ping -n 30 127.0.0.1"
    } else {
        "sleep 30"
    };
    let spawned = bg_spawn_sync(cmd.into(), Some(std::env::temp_dir().display().to_string()))
        .expect("spawn");
    // 确认在运行
    let out = bg_output_sync(spawned.task_id.clone(), None).expect("output");
    assert_eq!(out.status, "running");
    // 停止
    let stopped = bg_stop_sync(spawned.task_id.clone()).expect("stop");
    assert!(stopped.stopped);
    // 停止后注册表移除
    let err = bg_output_sync(spawned.task_id.clone(), None).unwrap_err();
    assert!(err.contains("任务不存在"));
}
