//! bg_process 单元测试（注册表生命周期；真实进程 spawn 在 Windows 环境也能跑）。
use super::*;
use crate::bg_process::{
    bg_output_sync, bg_spawn_sync, bg_stop_sync, bg_task_pid, process_group_alive,
};

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

    let pid = bg_task_pid(&spawned.task_id).expect("已注册任务应有 pid");

    // 停止必须「真终止」且「立即返回」——旧实现两种失败模式各在这里露馅：
    // ① kill 打空进程组（stopped 靠注册表存在即 true）→ 进程仍活着；
    // ② 阻塞式 child.wait() → 一直等子进程自然退出（sleep 30 就等 30s）。
    let started = std::time::Instant::now();
    let stopped = bg_stop_sync(spawned.task_id.clone()).expect("stop");
    let elapsed = started.elapsed();
    assert!(stopped.stopped, "应确认进程已终止（error={:?}）", stopped.error);
    assert!(
        elapsed < std::time::Duration::from_secs(3),
        "停止必须立即返回，不能阻塞等子进程自然退出（实测 {elapsed:?}）"
    );
    assert!(!process_group_alive(pid), "停止后进程组不应仍有存活成员");

    // 停止后注册表移除
    let err = bg_output_sync(spawned.task_id.clone(), None).unwrap_err();
    assert!(err.contains("任务不存在"));
}

/// 进程树：命令自带子进程，停止必须带走整组（含孙进程）。
#[test]
fn stop_terminates_whole_process_group() {
    let cmd = if cfg!(target_os = "windows") {
        // cmd /C 下 ping 另起子进程，覆盖 /T 杀树
        "ping -n 30 127.0.0.1"
    } else {
        // sh fork 出后台 sleep，自身再跑一个 sleep：组内至少两个进程
        "sleep 30 & sleep 30"
    };
    let spawned = bg_spawn_sync(cmd.into(), Some(std::env::temp_dir().display().to_string()))
        .expect("spawn");
    assert_eq!(
        bg_output_sync(spawned.task_id.clone(), None)
            .expect("output")
            .status,
        "running"
    );
    let pid = bg_task_pid(&spawned.task_id).expect("已注册任务应有 pid");

    let stopped = bg_stop_sync(spawned.task_id.clone()).expect("stop");
    assert!(stopped.stopped, "应确认整组已终止（error={:?}）", stopped.error);
    assert!(!process_group_alive(pid), "子/孙进程应随进程组一并终止");
}
