use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

pub struct TerminalSession {
    pub writer: Box<dyn Write + Send>,
    pub master: Box<dyn MasterPty + Send>,
}

#[derive(Default)]
pub struct TerminalState {
    pub sessions: Arc<Mutex<HashMap<u32, TerminalSession>>>,
    pub next_id: Mutex<u32>,
}

#[tauri::command]
pub fn terminal_create(
    app: AppHandle,
    state: tauri::State<TerminalState>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    shell: Option<String>,
) -> Result<u32, String> {
    let mut next_id = state.next_id.lock().map_err(|e| e.to_string())?;
    *next_id += 1;
    let id = *next_id;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let default_shell = if cfg!(target_os = "windows") {
        "powershell.exe".to_string()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    };
    // 用户配置的 shell（P2-G2 终端配置）优先；空串/空白回退平台默认
    let shell_command = shell
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or(default_shell);

    let mut cmd = CommandBuilder::new(&shell_command);
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }
    // 终端能力环境（2026-10-05 修复「fish 打开全空白、无提示符」）：
    // PTY 子进程默认继承启动它的父进程环境，而 GUI / tauri-dev 链路上 TERM 常为
    // "dumb"（或缺失）——starship / oh-my-* 等提示符框架遇到 dumb 终端会直接拒绝
    // 渲染（实测 starship 报 "Under a 'dumb' terminal (TERM=dumb)"，面板空白）。
    // 显式声明为一个真实终端：TERM=xterm-256color + COLORTERM=truecolor。
    // 仅在当前值为空/dumb/unknown 时才覆盖，保留用户/调用方自定义的终端能力。
    let term = std::env::var("TERM").unwrap_or_default();
    if term.is_empty() || term == "dumb" || term == "unknown" {
        cmd.env("TERM", "xterm-256color");
    }
    if std::env::var_os("COLORTERM").is_none() {
        cmd.env("COLORTERM", "truecolor");
    }
    // 代理环境注入（P2-G2 代理贯通）：PTY 终端子进程也走设置的代理，
    // 与 exec_command 的 env 注入同源（kv reinagent-web-proxy / no-proxy）。
    {
        let (proxy, no_proxy) = crate::app_proxy::read_proxy_settings();
        let proxy_trimmed = proxy.trim().to_string();
        if !proxy_trimmed.is_empty() {
            cmd.env("HTTP_PROXY", &proxy_trimmed);
            cmd.env("HTTPS_PROXY", &proxy_trimmed);
            cmd.env("ALL_PROXY", &proxy_trimmed);
            if !no_proxy.trim().is_empty() {
                cmd.env("NO_PROXY", no_proxy.trim());
            }
        }
    }

    let _child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let event_name = format!("terminal-data-{}", id);
    let app_clone = app.clone();

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let s = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_clone.emit(&event_name, s);
                }
                Err(_) => break,
            }
        }
    });

    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions.insert(
        id,
        TerminalSession {
            writer,
            master: pair.master,
        },
    );

    Ok(id)
}

#[tauri::command]
pub fn terminal_write(
    state: tauri::State<TerminalState>,
    id: u32,
    data: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(session) = sessions.get_mut(&id) {
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        session.writer.flush().map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err(format!("Terminal session {} not found", id))
    }
}

#[tauri::command]
pub fn terminal_resize(
    state: tauri::State<TerminalState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(session) = sessions.get(&id) {
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err(format!("Terminal session {} not found", id))
    }
}

#[tauri::command]
pub fn terminal_close(state: tauri::State<TerminalState>, id: u32) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions.remove(&id);
    Ok(())
}
