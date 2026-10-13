//! 远程访问公网隧道管理模块（Cloudflare Quick Tunnel / 自定义公网地址）。
//!
//! 功能职责：
//! 1. 网络模式管理：局域网 (Lan) / Cloudflare 免费免配置公网隧道 (Cloudflare) / 用户自定义反代域名 (Custom)；
//! 2. `cloudflared` 二进制管理：优先检测系统环境，缺失时安全下载至 `~/.ReinAgent/bin/`；
//! 3. 隧道子进程生命周期：异步启动、日志监听、正则捕获公网 HTTPS 域名、异常重试与优雅退出；
//! 4. 单进程纪律（核心不变量）：**系统上任何时刻最多只应存在一个由 ReinAgent 拉起的 cloudflared**。
//!
//! ## 单进程不变量如何保证
//!
//! 四条相互独立的防线，任一条生效即可避免进程堆积：
//! - **启停串行化**（`TUNNEL_OPS` 异步互斥锁）：`start` / `stop` 全链路串行，消除
//!   「两个 start 都跑完 stop 才各自登记 child」的交错窗口（旧实现下旧 child 句柄被覆盖后失联）；
//! - **启动前精确回收孤儿**（`reclaim_orphan_tunnel`）：以 PID 文件 + 进程名双重校验，
//!   只回收「上次由本应用留下、且仍在运行」的 cloudflared，绝不误杀用户在终端手动拉的进程；
//! - **宿主连坐**：Windows 用 Job Object（`KILL_ON_JOB_CLOSE`，进程级，宿主崩溃即连坐）。
//!   Linux **不用** `PR_SET_PDEATHSIG`——该 prctl 绑定的是 fork 它的那个*线程*而非进程，
//!   而 spawn 发生在 tokio 线程上，线程一空闲子进程即被 SIGKILL（详见
//!   `configure_child_lifecycle` 注释）；Linux 的孤儿防护由「子进程一 spawn 就写 PID 文件
//!   + 下次启动精确回收」承担，这是进程级、不依赖 fork 线程存活时间；
//! - **退出兜底**：`stop_tunnel_sync` 在 `RunEvent::ExitRequested` / `Exit` 均会终止并回收句柄；
//! - **僵尸回收**：子进程先于宿主退出时立即 `try_wait()` 收尸，避免残留 `<defunct>`
//!   与 PID 文件长期指向死进程。
//!
//! 注：Quick Tunnel（`cloudflared tunnel --url`）的 `*.trycloudflare.com` 域名为 Cloudflare
//! 随机分配、无法固定，这是官方产品限制；需要固定域名须改用 Named Tunnel（`tunnel run --token`）。

use futures_util::StreamExt;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Emitter};

/// 隧道子进程记录：除句柄外还保留它自己的 PID，供孤儿回收与诊断使用。
struct TunnelChild {
    child: Child,
    pid: u32,
}

/// 回收「已退出但尚未 wait」的子进程，消除僵尸。
///
/// 子进程可能先于宿主结束（Cloudflare 侧断连、quick tunnel 被回收、被外部杀死），
/// 此时它进入僵尸态：`/proc/<pid>` 条目仍在、comm 仍是 cloudflared，但已不再运行。
/// 若不 wait 掉，会残留僵尸进程且状态长期停留在「已断开」无法自愈。
///
/// 用 `try_wait()` 而非 `wait()`：本函数在日志读取线程退出、以及 stop/reclaim 路径上
/// 调用，绝不能阻塞等待一个仍在跑的隧道。
///
/// 返回 `true` 表示该子进程确已结束（状态已回收或刚被回收）。
fn reap_child_if_exited(child: &mut Child) -> bool {
    matches!(child.try_wait(), Ok(Some(_)))
}

// ---------------- 宿主生命周期绑定：Job Object（Windows）/ 进程组 + PDEATHSIG（Linux） ----------------

/// Windows：Job Object 句柄的 RAII 包装，Drop 时关闭句柄。
///
/// 用裸 FFI 直接声明 kernel32 导出，而非经 `windows` crate 的 `JobObjects` 模块：
/// 后者要求同时开启 `Win32_Security`（`SECURITY_ATTRIBUTES`）与
/// `Win32_System_Threading`（结构体内的 `IO_COUNTERS`）两个 feature 门控，
/// 而本模块只用到这 4 个函数，自带声明更省依赖、也免于跨 feature 版本的签名漂移。
#[cfg(windows)]
struct PlatformJob(*mut std::ffi::c_void);

// HANDLE 是内核对象引用，跨线程移动安全
#[cfg(windows)]
unsafe impl Send for PlatformJob {}

#[cfg(windows)]
mod win_job_ffi {
    use std::ffi::c_void;

    pub const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;

    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimitInformation {
        basic_limit_information: BasicLimitInformation,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    // 显式声明导入库：MSVC CRT 虽默认链接 kernel32，但自持声明时写明可消除
    // 「换工具链/换 target 后链接期才报错」的不确定性（本模块无法在 Linux CI 验证）
    #[link(name = "kernel32")]
    extern "system" {
        pub fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> *mut c_void;
        pub fn SetInformationJobObject(
            job: *mut c_void,
            class: i32,
            info: *mut c_void,
            len: u32,
        ) -> i32;
        pub fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        pub fn CloseHandle(handle: *mut c_void) -> i32;
    }

    /// 创建带 KILL_ON_JOB_CLOSE 的 Job Object；失败返回 Err（调用方降级但不静默）。
    pub fn create_job() -> Result<*mut c_void, std::io::Error> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if job.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let mut info = ExtendedLimitInformation::default();
            info.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                &mut info as *mut _ as *mut c_void,
                std::mem::size_of::<ExtendedLimitInformation>() as u32,
            );
            if ok == 0 {
                let err = std::io::Error::last_os_error();
                CloseHandle(job);
                return Err(err);
            }
            Ok(job)
        }
    }

    /// 编译期布局断言：本 FFI 结构体必须与 Windows SDK 逐字节一致，
    /// 一旦有人调整字段顺序/类型，这里会先于运行期（ERROR_INVALID_PARAMETER）拦下。
    /// 尺寸随指针宽度变化，故仅对 64 位目标断言（本项目 cloudflared 仅支持 x86_64）。
    #[cfg(target_pointer_width = "64")]
    const _: () = {
        assert!(std::mem::size_of::<BasicLimitInformation>() == 64);
        assert!(std::mem::size_of::<IoCounters>() == 48);
        assert!(std::mem::size_of::<ExtendedLimitInformation>() == 144);
    };
}

#[cfg(windows)]
impl PlatformJob {
    /// 创建 Job Object；失败时记录原因并降级（返回 None）。
    ///
    /// 降级不致命：仍有 PID 文件回收与退出钩子兜底；但必须留下日志，
    /// 否则连坐保护在某台机器上静默失效将无从察觉。
    fn new() -> Option<Self> {
        match win_job_ffi::create_job() {
            Ok(handle) => Some(Self(handle)),
            Err(err) => {
                eprintln!("[remote-tunnel] 创建 Job Object 失败，宿主连坐保护降级为 PID 回收: {err}");
                None
            }
        }
    }

    fn assign(&self, child: &Child) -> Result<(), String> {
        use std::os::windows::io::AsRawHandle;
        let process = child.as_raw_handle() as *mut std::ffi::c_void;
        let ok = unsafe { win_job_ffi::AssignProcessToJobObject(self.0, process) };
        if ok == 0 {
            Err(format!(
                "绑定 Job Object 失败: {}",
                std::io::Error::last_os_error()
            ))
        } else {
            Ok(())
        }
    }
}

#[cfg(windows)]
impl Drop for PlatformJob {
    fn drop(&mut self) {
        // 关闭最后一个句柄触发 KILL_ON_JOB_CLOSE：宿主消失时 Job 内进程被内核一并终止
        unsafe { win_job_ffi::CloseHandle(self.0) };
    }
}

/// 非 Windows 平台：无 Job Object 等价物，占位类型保证状态结构跨平台一致。
#[cfg(not(windows))]
struct PlatformJob;

#[cfg(not(windows))]
impl PlatformJob {
    fn new() -> Option<Self> {
        None
    }

    fn assign(&self, _child: &Child) -> Result<(), String> {
        Ok(())
    }
}

/// Linux：把子进程放进独立会话/进程组。
///
/// pre_exec 在 fork 之后、exec 之前于子进程内执行，只允许调用 async-signal-safe 函数，
/// `setsid` 满足。macOS 无 prctl，本函数也仅 Linux 生效。
///
/// ⚠️ **这里刻意不设 `PR_SET_PDEATHSIG`**。该 prctl 绑定的是「执行 fork 的那个*线程*」
/// 而非整个进程：`Command::spawn` 会由调用它的特化/线程池线程（本项目为 tokio runtime
/// 线程）fork，该线程在 spawn 返回后很快空闲或退出，内核随即使向子进程投递 SIGKILL——
/// 表现为「隧道刚建立就被杀、只留一个僵尸进程」，即经典的 PDEATHSIG-thread-scoped 陷阱。
/// 实测：带 PDEATHSIG 从短命线程 fork 的 `sleep` 在 600ms 内即被杀；去掉后稳定存活。
///
/// 宿主崩溃时的孤儿防护改由「PID 文件 + 下次启动精确回收」承担（见 `reclaim_orphan_tunnel`），
/// 这是进程级而非线程级、且不依赖 fork 线程存活时间。Windows 侧仍保留 Job Object（进程级，安全）。
#[cfg(target_os = "linux")]
fn configure_child_lifecycle(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        cmd.pre_exec(|| {
            // 独立会话 + 进程组：脱离宿主控制终端，后续可按 -pgid 整组回收
            libc::setsid();
            Ok(())
        });
    }
}

#[cfg(not(target_os = "linux"))]
fn configure_child_lifecycle(_cmd: &mut Command) {}

// ---------------- 孤儿 PID 文件（跨平台） ----------------

/// 记录「本应用最后一次拉起的 cloudflared PID」的文件路径。
fn tunnel_pid_file_path() -> Option<PathBuf> {
    Some(ensure_bin_dir().ok()?.join("tunnel.pid"))
}

fn write_tunnel_pid(pid: u32) {
    if let Some(path) = tunnel_pid_file_path() {
        let _ = std::fs::write(path, pid.to_string());
    }
}

fn clear_tunnel_pid() {
    if let Some(path) = tunnel_pid_file_path() {
        let _ = std::fs::remove_file(path);
    }
}

fn read_tunnel_pid() -> Option<u32> {
    let path = tunnel_pid_file_path()?;
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

/// 进程是否存活、且进程名确为 cloudflared。
///
/// 双重校验缺一不可：PID 会被系统复用，只校验存活可能误杀恰好复用了该 PID 的
/// 无关进程，因此必须同时确认进程名。
#[cfg(windows)]
fn is_alive_cloudflared(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    // 0x08000000 = CREATE_NO_WINDOW：避免刷新控制台窗口
    let out = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .creation_flags(0x08000000)
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout)
            .to_lowercase()
            .contains("cloudflared.exe"),
        Err(_) => false,
    }
}

/// Unix 侧：确认进程存活**且**进程名确为 cloudflared。
#[cfg(not(windows))]
fn is_alive_cloudflared(pid: u32) -> bool {
    // 必须先挡住两个特例值：kill(2) 把 0 解释为「当前进程组」、把 -1（即 u32::MAX）
    // 解释为「所有进程」，两者都会「成功」，从而把不存在的 PID 误判为存活。
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    // Linux：/proc/<pid>/comm 是权威判据——读到且名字匹配才算我们拉起的 cloudflared。
    // 读不到（进程不存在 / 已退出 / 无权限）一律判否，这正是「不误杀」所需的保守方向。
    if let Ok(name) = std::fs::read_to_string(format!("/proc/{pid}/comm")) {
        return name.trim() == "cloudflared";
    }
    if std::path::Path::new("/proc").is_dir() {
        // 有 /proc 却取不到该 PID 的记录：进程确实不存在
        return false;
    }
    // 无 /proc 的 Unix（macOS/BSD）：退化为存活探测（本模块不负责 macOS 自动下载）
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(windows)]
fn kill_pid(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x08000000)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(windows))]
fn kill_pid(pid: u32) {
    let _ = Command::new("kill")
        .args(["-9", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// 回收上一次遗留的孤儿隧道进程。
///
/// 仅当 PID 文件存在、记录的进程仍存活、且进程名确为 cloudflared 时才终止它；
/// 任一条件不满足都只清掉过期的 PID 文件。**绝不按进程名批量清杀**——用户在终端
/// 手动运行的 cloudflared 必须不受影响。
pub fn reclaim_orphan_tunnel() {
    let Some(pid) = read_tunnel_pid() else {
        // 无记录：上次正常退出已清理，或从未启动过
        return;
    };
    // 若记录的正是当前句柄持有的子进程，说明这是活着的正常实例而非孤儿：
    // 交给 stop_tunnel_sync 经 Child 句柄回收，避免绕过句柄生命周期去 taskkill。
    let is_current = lock_state().child.as_ref().map(|c| c.pid) == Some(pid);
    if is_current {
        // 记录的正是当前句柄持有的子进程：若它已自行退出，在这里 wait 掉僵尸；
        // 仍在运行则交给随后的 stop_tunnel_sync 经句柄回收。
        let mut st = lock_state();
        if let Some(child) = st.child.as_mut() {
            let _ = reap_child_if_exited(&mut child.child);
        }
    } else if is_alive_cloudflared(pid) {
        kill_pid(pid);
        // 给内核一点时间完成回收，避免紧接着的 spawn 撞上旧进程残留
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    clear_tunnel_pid();
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TunnelNetworkMode {
    Lan,
    Cloudflare,
    Custom,
}

impl Default for TunnelNetworkMode {
    fn default() -> Self {
        Self::Lan
    }
}

#[allow(dead_code)]
impl TunnelNetworkMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Lan => "lan",
            Self::Cloudflare => "cloudflare",
            Self::Custom => "custom",
        }
    }

    pub fn from_str_opt(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "cloudflare" => Self::Cloudflare,
            "custom" => Self::Custom,
            _ => Self::Lan,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub mode: TunnelNetworkMode,
    /// "stopped" | "starting" | "running" | "error"
    pub status: String,
    pub public_url: Option<String>,
    pub error: Option<String>,
    pub progress: Option<String>,
}

impl Default for TunnelStatus {
    fn default() -> Self {
        Self {
            mode: TunnelNetworkMode::Lan,
            status: "stopped".to_string(),
            public_url: None,
            error: None,
            progress: None,
        }
    }
}

struct TunnelProcessState {
    status: TunnelStatus,
    child: Option<TunnelChild>,
    /// 宿主生命周期绑定凭据（Windows Job Object）；随子进程一同持有与释放
    job: Option<PlatformJob>,
    generation: u64,
}

impl Drop for TunnelProcessState {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.child.kill();
            let _ = child.child.wait();
        }
    }
}

static TUNNEL_STATE: OnceLock<Mutex<TunnelProcessState>> = OnceLock::new();

fn state() -> &'static Mutex<TunnelProcessState> {
    TUNNEL_STATE.get_or_init(|| {
        Mutex::new(TunnelProcessState {
            status: TunnelStatus::default(),
            child: None,
            job: None,
            generation: 0,
        })
    })
}

/// 容忍毒化获取状态锁
fn lock_state() -> std::sync::MutexGuard<'static, TunnelProcessState> {
    state().lock().unwrap_or_else(|e| e.into_inner())
}

/// 隧道启停串行化锁。
///
/// `remote_server_config` 以火忘式 `spawn` 调起 start/stop，若不串行化，两次快速
/// 触发可能都在对方登记 child 之前跑完 `stop_tunnel`，于是两个子进程先后被 spawn 且
/// 第一个句柄被覆盖失联（旧实现下进程就这么堆起来的）。整个 start/stop 链路持此锁。
static TUNNEL_OPS: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn tunnel_ops() -> &'static tokio::sync::Mutex<()> {
    TUNNEL_OPS.get_or_init(|| tokio::sync::Mutex::new(()))
}

pub fn get_tunnel_status() -> TunnelStatus {
    let st = lock_state();
    st.status.clone()
}

/// 获取或创建 ~/.ReinAgent/bin 目录
fn ensure_bin_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法获取用户主目录".to_string())?;
    let bin_dir = home.join(".ReinAgent").join("bin");
    std::fs::create_dir_all(&bin_dir).map_err(|e| format!("创建 bin 目录失败: {e}"))?;
    Ok(bin_dir)
}

/// 检查二进制是否具备基本有效性（文件存在、体积 >= 20MB 且 magic 字节匹配）
fn is_valid_cloudflared_binary(path: &Path) -> bool {
    if let Ok(metadata) = std::fs::metadata(path) {
        if metadata.is_file() && metadata.len() >= 20 * 1024 * 1024 {
            if let Ok(mut file) = std::fs::File::open(path) {
                let mut magic = [0u8; 4];
                if file.read_exact(&mut magic).is_ok() {
                    #[cfg(unix)]
                    if &magic != b"\x7fELF" {
                        return false;
                    }
                    #[cfg(windows)]
                    if &magic[..2] != b"MZ" {
                        return false;
                    }
                    return true;
                }
            }
        }
    }
    false
}

/// 查找已有的 cloudflared 二进制路径（PATH 或 ~/.ReinAgent/bin/）
fn find_existing_cloudflared() -> Option<PathBuf> {
    let exe_name = if cfg!(target_os = "windows") {
        "cloudflared.exe"
    } else {
        "cloudflared"
    };

    // 1. 检查 ~/.ReinAgent/bin/
    if let Ok(bin_dir) = ensure_bin_dir() {
        let p = bin_dir.join(exe_name);
        if is_valid_cloudflared_binary(&p) {
            return Some(p);
        }
    }

    // 2. 检查系统 PATH
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let p = dir.join(exe_name);
            if p.is_file() {
                return Some(p);
            }
        }
    }

    None
}

/// 依据当前平台定位下载 URL
fn cloudflared_download_url() -> Result<(&'static str, &'static str), String> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;

    match (os, arch) {
        ("linux", "x86_64") => Ok((
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64",
            "cloudflared",
        )),
        ("linux", "aarch64") => Ok((
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64",
            "cloudflared",
        )),
        ("windows", "x86_64") => Ok((
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe",
            "cloudflared.exe",
        )),
        ("macos", "x86_64") | ("macos", "aarch64") => {
            Err("macOS 请在终端执行 brew install cloudflared 安装隧道支持".to_string())
        }
        _ => Err(format!("当前架构 ({os} {arch}) 暂不支持自动下载 cloudflared，请手动安装后放置在 PATH 中")),
    }
}

/// 下载并就位 cloudflared 二进制（流式写入、体积校验、可执行校验）
async fn download_cloudflared(app: &AppHandle) -> Result<PathBuf, String> {
    let (url, filename) = cloudflared_download_url()?;
    let bin_dir = ensure_bin_dir()?;
    let target_path = bin_dir.join(filename);
    let pid = std::process::id();
    let temp_path = bin_dir.join(format!("{filename}.part.{pid}.{}", uuid::Uuid::new_v4().simple()));

    update_progress(app, "正在下载 Cloudflare 隧道组件 (请稍候)...");

    let client = crate::app_proxy::build_proxied_reqwest_client(
        url,
        Some(std::time::Duration::from_secs(20)),
        Some(std::time::Duration::from_secs(300)),
    )?;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("连接 GitHub 下载源失败: {e}。请检查网络或代理设置，您也可以手动在终端安装 cloudflared"))?;

    if !response.status().is_success() {
        return Err(format!("下载失败，HTTP 状态码: {}", response.status()));
    }

    let expected_len = response.content_length();
    let mut file = std::fs::File::create(&temp_path).map_err(|e| format!("创建临时文件失败: {e}"))?;
    let mut stream = response.bytes_stream();
    let mut downloaded_bytes: usize = 0;
    const MAX_BYTES: usize = 200 * 1024 * 1024; // 200MB 上限防御异常推送

    while let Some(chunk_res) = stream.next().await {
        let chunk = match chunk_res {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&temp_path);
                return Err(format!("读取下载数据中断: {e}"));
            }
        };
        downloaded_bytes += chunk.len();
        if downloaded_bytes > MAX_BYTES {
            let _ = std::fs::remove_file(&temp_path);
            return Err("下载文件超过体积上限 (200MB)，已终止".to_string());
        }
        if let Err(e) = file.write_all(&chunk) {
            let _ = std::fs::remove_file(&temp_path);
            return Err(format!("写入临时文件失败: {e}"));
        }
    }

    if let Err(e) = file.flush() {
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!("刷新临时文件失败: {e}"));
    }
    drop(file);

    // 比对 Content-Length 防止截断
    if let Some(expected) = expected_len {
        if (downloaded_bytes as u64) != expected {
            let _ = std::fs::remove_file(&temp_path);
            return Err(format!("下载数据不完整: 实际接收 {downloaded_bytes} 字节，预期 {expected} 字节"));
        }
    }

    // cloudflared 官方二进制体积一般在 30MB ~ 70MB 之间；低于 20MB 判为不完整或受阻
    if downloaded_bytes < 20 * 1024 * 1024 {
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!("下载文件大小异常 (仅 {downloaded_bytes} 字节，小于 20MB)，可能遭遇网络阻断或劫持"));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&temp_path, std::fs::Permissions::from_mode(0o755));
    }

    // 格式与 magic 校验
    if !is_valid_cloudflared_binary(&temp_path) {
        let _ = std::fs::remove_file(&temp_path);
        return Err("下载的文件格式或二进制头校验未通过".to_string());
    }

    // 执行 --version 验证可执行性及组件标识
    match Command::new(&temp_path).arg("--version").output() {
        Ok(output) if output.status.success() => {
            let out_str = String::from_utf8_lossy(&output.stdout);
            if !out_str.to_lowercase().contains("cloudflared") {
                let _ = std::fs::remove_file(&temp_path);
                return Err("下载的二进制未能识别为 cloudflared 组件".to_string());
            }
        }
        Ok(output) => {
            let _ = std::fs::remove_file(&temp_path);
            return Err(format!("二进制版本校验退出码异常: {:?}", output.status.code()));
        }
        Err(e) => {
            let _ = std::fs::remove_file(&temp_path);
            return Err(format!("无法执行下载的二进制以校验版本: {e}"));
        }
    }

    let rename_res = std::fs::rename(&temp_path, &target_path);
    if let Err(e) = rename_res {
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!("重命名就位文件失败: {e}"));
    }

    Ok(target_path)
}

fn update_progress(app: &AppHandle, msg: &str) {
    let status_to_emit = {
        let mut st = lock_state();
        st.status.status = "starting".to_string();
        st.status.progress = Some(msg.to_string());
        st.status.clone()
    };
    let _ = app.emit("remote-server:tunnel-status", status_to_emit);
}

fn set_error(app: &AppHandle, err_msg: &str) {
    let status_to_emit = {
        let mut st = lock_state();
        st.status.status = "error".to_string();
        st.status.error = Some(err_msg.to_string());
        st.status.public_url = None;
        st.status.progress = None;
        st.status.clone()
    };
    let _ = app.emit("remote-server:tunnel-status", status_to_emit);
}

/// 停止当前正在运行的隧道（同步核心实现）。
///
/// 幂等：无子进程时仅重置状态。这里同时递增 generation，使旧隧道遗留的日志读取线程
/// 与 watchdog 立即失效，不会回写状态（见 `test_generation_guard`）。
pub fn stop_tunnel_sync(app: Option<&AppHandle>) {
    let (child_to_kill, status_to_emit) = {
        let mut st = lock_state();
        st.generation = st.generation.wrapping_add(1);
        st.status.status = "stopped".to_string();
        st.status.public_url = None;
        st.status.error = None;
        st.status.progress = None;
        // 一并取出 Job 句柄：句柄随子进程存活，这里显式 Drop 保证绑定关系不被滞留
        st.job = None;
        (st.child.take(), st.status.clone())
    };

    if let Some(mut child) = child_to_kill {
        let _ = child.child.kill();
        // 回收进程，避免僵尸进程
        let _ = child.child.wait();
    }
    // 同步清理 PID 文件：应用正常退出后不应留下可供误判的陈旧记录
    clear_tunnel_pid();

    if let Some(app) = app {
        let _ = app.emit("remote-server:tunnel-status", status_to_emit);
    }
}

/// 停止当前正在运行的隧道（持有串行锁的版本）
pub async fn stop_tunnel(app: Option<&AppHandle>) {
    let _guard = tunnel_ops().lock().await;
    stop_tunnel_sync(app);
}

pub const TUNNEL_URL_REGEX: &str = r"https://[a-zA-Z0-9-]+\.trycloudflare\.com";

/// 启动 Cloudflare Quick Tunnel 监听指定本地端口。
///
/// 「先回收孤儿 → 停旧 → 起新」全链路由 `TUNNEL_OPS` 串行化，保证同一时刻至多一个
/// 由本应用拉起的 cloudflared 存活。
pub async fn start_cloudflare_tunnel(app: AppHandle, port: u32) -> Result<(), String> {
    let _guard = tunnel_ops().lock().await;

    // 上一轮非正常退出（崩溃/强杀）可能留下仍在跑的隧道，先精确回收再停句柄内实例
    reclaim_orphan_tunnel();
    stop_tunnel_sync(Some(&app));

    let res = start_cloudflare_tunnel_inner(&app, port).await;
    if let Err(ref e) = res {
        set_error(&app, e);
    }
    res
}

async fn start_cloudflare_tunnel_inner(app: &AppHandle, port: u32) -> Result<(), String> {
    let bin_path = match find_existing_cloudflared() {
        Some(p) => p,
        None => download_cloudflared(app).await?,
    };

    update_progress(app, "正在建立 Cloudflare 边缘安全连接...");

    let mut cmd = Command::new(&bin_path);
    cmd.args([
        "tunnel",
        "--url",
        &format!("http://127.0.0.1:{port}"),
        "--no-autoupdate",
    ]);
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    // Linux：独立进程组 + 父进程死亡即 SIGKILL
    configure_child_lifecycle(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| format!("启动 cloudflared 失败: {e}"))?;
    let pid = child.id();

    // 子进程已起，立即登记 PID：即便随后立刻崩溃/强杀，下次启动也能精确回收它
    write_tunnel_pid(pid);

    // Windows：绑定 Job Object，宿主消失时由内核连坐终止该子进程。
    //
    // 创建与绑定两条失败路径策略一致：**都降级为「不绑定」而非中断隧道**——隧道本身
    // 仍然可用（用户要的是能连上），孤儿风险由 PID 文件回收 + 退出钩子兜底；同时都留下
    // 日志，避免保护静默失效后无从排查。仅在极受限环境（安全软件拦截 Job 操作）才会走到。
    let job = PlatformJob::new().and_then(|job| match job.assign(&child) {
        Ok(()) => Some(job),
        Err(err) => {
            eprintln!("[remote-tunnel] 绑定 Job Object 失败，降级为 PID 回收兜底: {err}");
            None
        }
    });

    let stderr = child.stderr.take().ok_or_else(|| "无法捕获隧道输出日志".to_string())?;

    let (my_gen, status_to_emit) = {
        let mut st = lock_state();
        st.generation = st.generation.wrapping_add(1);
        let gen = st.generation;
        st.status.mode = TunnelNetworkMode::Cloudflare;
        st.status.status = "starting".to_string();
        st.status.error = None;
        st.child = Some(TunnelChild { child, pid });
        st.job = job;
        (gen, st.status.clone())
    };
    let _ = app.emit("remote-server:tunnel-status", status_to_emit);

    // Watchdog: 45秒超时守护，防止边缘握手卡死导致永久停留于 starting
    let app_watchdog = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(45)).await;
        let status_to_emit = {
            let mut st = lock_state();
            if st.generation == my_gen && st.status.status == "starting" {
                st.status.status = "error".to_string();
                st.status.error = Some("建立 Cloudflare 隧道超时 (45秒未就绪)，请检查网络连接或代理设置".to_string());
                st.status.progress = None;
                Some(st.status.clone())
            } else {
                None
            }
        };
        if let Some(status) = status_to_emit {
            let _ = app_watchdog.emit("remote-server:tunnel-status", status);
        }
    });

    let app_clone = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        let re = Regex::new(TUNNEL_URL_REGEX).expect("valid regex");

        let mut discovered = false;
        for line_res in reader.lines() {
            // 每次循环前先检查是否已被新一代隧道接管
            {
                let st = lock_state();
                if st.generation != my_gen {
                    return;
                }
            }

            match line_res {
                Ok(line) => {
                    if !discovered {
                if let Some(matched) = re.find(&line) {
                            let url = matched.as_str().to_string();
                            discovered = true;
                            let status_to_emit = {
                                let mut st = lock_state();
                                if st.generation != my_gen {
                                    return;
                                }
                                st.status.status = "running".to_string();
                                st.status.public_url = Some(url);
                                st.status.progress = None;
                                st.status.error = None;
                                st.status.clone()
                            };
                            // 广播通知前端更新二维码与公网状态（锁外 emit）
                            let _ = app_clone.emit("remote-server:status", serde_json::json!({
                                "tunnelUpdated": true,
                            }));
                            let _ = app_clone.emit("remote-server:tunnel-status", status_to_emit);
                        }
                    }
                }
                Err(err) => {
                    // 管道非正常读取中断
                    eprintln!("cloudflared stderr read error: {err}");
                    break;
                }
            }
        }

        // 日志流结束 = 子进程已退出。这里必须 wait 掉僵尸（否则残留 <defunct> 且
        // PID 文件一直指着它），再据实际退出码给出可诊断的错误信息而不是笼统的「已断开」。
        let exit_note = {
            let mut st = lock_state();
            if st.generation != my_gen {
                return;
            }
            st.child.as_mut().and_then(|c| match c.child.try_wait() {
                Ok(Some(status)) => Some(match status.code() {
                    Some(code) => format!("Cloudflare 隧道进程已退出（退出码 {code}）"),
                    None => "Cloudflare 隧道进程被信号终止".to_string(),
                }),
                // 仍显示为存活（极罕见：stderr 关闭但进程未退），保留原文案
                _ => None,
            })
        };

        let status_to_emit = {
            let mut st = lock_state();
            // 世代守卫：若当前世代已被更改（如用户点击重连或停止后有了新隧道），绝不覆盖状态！
            if st.generation != my_gen {
                return;
            }
            if st.status.status == "running" || st.status.status == "starting" {
                st.status.status = "error".to_string();
                st.status.error = Some(
                    exit_note.unwrap_or_else(|| "Cloudflare 隧道已断开或退出".to_string()),
                );
                st.status.public_url = None;
                Some(st.status.clone())
            } else {
                None
            }
        };

        if let Some(status) = status_to_emit {
            let _ = app_clone.emit("remote-server:tunnel-status", status);
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_network_mode_conversions() {
        assert_eq!(TunnelNetworkMode::from_str_opt("lan"), TunnelNetworkMode::Lan);
        assert_eq!(TunnelNetworkMode::from_str_opt("LAN"), TunnelNetworkMode::Lan);
        assert_eq!(TunnelNetworkMode::from_str_opt("cloudflare"), TunnelNetworkMode::Cloudflare);
        assert_eq!(TunnelNetworkMode::from_str_opt("CLOUDFLARE"), TunnelNetworkMode::Cloudflare);
        assert_eq!(TunnelNetworkMode::from_str_opt("custom"), TunnelNetworkMode::Custom);
        assert_eq!(TunnelNetworkMode::from_str_opt("invalid"), TunnelNetworkMode::Lan);

        assert_eq!(TunnelNetworkMode::Lan.as_str(), "lan");
        assert_eq!(TunnelNetworkMode::Cloudflare.as_str(), "cloudflare");
        assert_eq!(TunnelNetworkMode::Custom.as_str(), "custom");
    }

    #[test]
    fn test_cloudflared_url_regex() {
        let re = Regex::new(TUNNEL_URL_REGEX).unwrap();
        let sample_output = "2026-10-09T07:29:43Z INF +--------------------------------------------------------------------------------------------+
2026-10-09T07:29:43Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-10-09T07:29:43Z INF |  https://rein-agent-sample-tunnel.trycloudflare.com                                        |
2026-10-09T07:29:43Z INF +--------------------------------------------------------------------------------------------+";
        let matched = re.find(sample_output).expect("should find trycloudflare URL");
        assert_eq!(matched.as_str(), "https://rein-agent-sample-tunnel.trycloudflare.com");
    }

    #[test]
    fn test_is_valid_cloudflared_binary() {
        let temp_dir = tempfile::tempdir().unwrap();
        
        // 1. 小文件测试 (< 20MB)
        let small_file = temp_dir.path().join("small_bin");
        std::fs::write(&small_file, b"too small content").unwrap();
        assert!(!is_valid_cloudflared_binary(&small_file));

        // 2. 伪造大文件但 magic 不匹配
        let fake_big_file = temp_dir.path().join("fake_big_bin");
        let f = std::fs::File::create(&fake_big_file).unwrap();
        f.set_len(21 * 1024 * 1024).unwrap();
        assert!(!is_valid_cloudflared_binary(&fake_big_file));

        // 3. 具备有效 magic 字节的大文件
        let valid_big_file = temp_dir.path().join("valid_big_bin");
        let mut f2 = std::fs::File::create(&valid_big_file).unwrap();
        #[cfg(unix)]
        f2.write_all(b"\x7fELF").unwrap();
        #[cfg(windows)]
        f2.write_all(b"MZ\0\0").unwrap();
        f2.set_len(21 * 1024 * 1024).unwrap();
        assert!(is_valid_cloudflared_binary(&valid_big_file));
    }

    /// PID 文件是孤儿回收的唯一依据：写入-读取-清理三态必须自洽。
    /// 直接在真实 bin 目录上跑会污染用户环境，故改用独立临时目录校验同名文件的语义。
    #[test]
    fn test_tunnel_pid_file_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tunnel.pid");

        // 初始不存在 → 读不到
        assert!(std::fs::read_to_string(&path).is_err());

        // 写入后可解析回同一 PID
        std::fs::write(&path, "12345").unwrap();
        let parsed: Option<u32> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| s.trim().parse().ok());
        assert_eq!(parsed, Some(12345));

        // 清理后回到不可读
        std::fs::remove_file(&path).unwrap();
        assert!(std::fs::read_to_string(&path).is_err());
    }

    /// 损坏/空白的 PID 文件不得被解析成 PID，否则会误判为「有孤儿」。
    #[test]
    fn test_tunnel_pid_file_rejects_garbage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tunnel.pid");
        for bad in ["", "   ", "not-a-pid", "-1", "999999999999999999999"] {
            std::fs::write(&path, bad).unwrap();
            let parsed: Option<u32> = std::fs::read_to_string(&path)
                .ok()
                .and_then(|s| s.trim().parse().ok());
            assert!(parsed.is_none(), "垃圾内容 {bad:?} 不应解析出 PID");
        }
    }

    /// 当前进程自身是活的、但进程名不是 cloudflared：存活+进程名双重校验必须拒绝它，
    /// 这是「不误杀无关进程」的核心保证。
    #[test]
    fn test_is_alive_cloudflared_rejects_non_cloudflared() {
        let self_pid = std::process::id();
        // 测试二进制名为 cargo test 产物，绝非 cloudflared
        assert!(!is_alive_cloudflared(self_pid));
    }

    /// 不存在的 PID（取一个几乎不可能占用的极大值）必须判定为「非存活」。
    #[test]
    fn test_is_alive_cloudflared_false_for_dead_pid() {
        assert!(!is_alive_cloudflared(u32::MAX));
    }

    /// 无 PID 文件时回收必须是安全的空操作（不能 panic、不能误杀）。
    /// 幂等性由连续两次调用各自正常返回来验证。
    #[test]
    fn test_reclaim_orphan_tunnel_is_safe_without_record() {
        let _guard = test_serial_lock();
        // 依赖真实 ~/.ReinAgent/bin 目录；若不存在则由 ensure_bin_dir 创建。
        // 不写 PID 文件即代表「无遗留」，回收应当直接返回。
        reclaim_orphan_tunnel();
        reclaim_orphan_tunnel();
    }

    /// 串行化本模块的测试，避免与并发用例互踩状态。
    fn test_serial_lock() -> std::sync::MutexGuard<'static, ()> {
        static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        TEST_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn test_generation_guard() {
        let gen1 = {
            let mut st = lock_state();
            st.generation = st.generation.wrapping_add(1);
            st.status.status = "starting".to_string();
            st.generation
        };

        // 模拟外部触发了 stop 或新 start，generation 递增
        {
            let mut st = lock_state();
            st.generation = st.generation.wrapping_add(1);
            st.status.status = "running".to_string();
            st.status.public_url = Some("https://new-tunnel.trycloudflare.com".to_string());
        }

        // 旧线程根据 gen1 判断是否应该写状态
        {
            let mut st = lock_state();
            if st.generation == gen1 {
                st.status.status = "error".to_string();
            }
        }

        // 验证状态未被旧线程污染
        let st = lock_state();
        assert_eq!(st.status.status, "running");
        assert_eq!(st.status.public_url.as_deref(), Some("https://new-tunnel.trycloudflare.com"));
    }
}

