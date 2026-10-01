/**
 * systemInfo —— 系统 OS 信息（P2-G2 尾巴）。
 *
 * 数据源：Rust `system_info` 命令（os/版本/架构/登录默认 shell，模块级缓存）。
 * 消费方：终端 Shell 设置标签（Win 11 amd64 徽章）与提示词 Environment 段。
 */

export interface SystemOsInfo {
  /** windows | linux | macos */
  os: string;
  /** 展示用版本（Win 11 / Win 10 / Ubuntu 24.04.1 LTS / macOS 14.5 …） */
  version: string;
  /** amd64 | arm64（x86_64/aarch64 的展示别名） */
  arch: string;
  /** 登录默认 shell（$SHELL 绝对路径；windows 为空） */
  defaultShell: string;
}

let cache: SystemOsInfo | null = null;

export async function getOsInfo(): Promise<SystemOsInfo> {
  if (cache) return cache;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    cache = await invoke<SystemOsInfo>("system_info");
  } catch {
    cache = { os: "unknown", version: "", arch: "", defaultShell: "" };
  }
  return cache;
}

/** 同步读缓存（未预热返回 null）——展示拼接用；预热靠任意一次 getOsInfo()。 */
export function getCachedOsInfo(): SystemOsInfo | null {
  return cache;
}

/** 展示徽章：["Win 11", "amd64"] → "Win 11 amd64"；空信息返回空串。 */
export function formatOsBadge(info: SystemOsInfo): string {
  return [info.version, info.arch].filter(Boolean).join(" ");
}

/** shell 路径 → 简名（powershell.exe / pwsh.exe / cmd.exe / bash.exe …）。 */
export function shellSimpleName(shellPath: string): string {
  return (shellPath.split(/[\\/]/).pop() ?? "").toLowerCase();
}
