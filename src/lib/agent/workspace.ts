/**
 * workspace.ts —— ReinAgent 工作区目录决议与路径策略（对齐 ZCode 设计规范）。
 * ============================================================================
 * 1. 任务指定了项目 -> 使用项目指定的文件夹路径；
 * 2. 未指定项目 -> 使用用户主目录下的 `~/.ReinAgent/DefaultProject` 作为工作区文件夹；
 * 3. 相对路径决议 -> 统一通过 `resolveWorkspacePath` 解析为工作区下的绝对路径，
 *    彻底杜绝相对路径直接落入后端 `src-tauri` 目录的问题。
 * 4. No-Fallback 铁律 -> 用户主目录必须来自真实来源（Tauri `path_home_dir` IPC 缓存
 *    或 Node 环境变量），任何来源都拿不到时返回空串并要求 UI 明确告警，严禁编造路径。
 */

/**
 * 获取系统默认工作区路径：~/.ReinAgent/DefaultProject
 * 主目录未知时返回空串，调用方必须显式处理空值（UI 告警），不得当作可用路径使用。
 */
export function getDefaultWorkspaceRoot(): string {
  // 1. 浏览器环境/前端无法直接读环境变量时，从 localStorage 中读取缓存或回退
  if (typeof window !== "undefined") {
    const cached = localStorage.getItem("reinagent-user-home");
    if (cached && cached.trim().length > 0) {
      return normalizePath(`${cached.trim().replace(/\/+$/, "")}/.ReinAgent/DefaultProject`);
    }
  }

  // 2. Node / Bun 测试环境兜底
  if (typeof process !== "undefined" && process.env) {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) {
      return normalizePath(`${home.replace(/\/+$/, "")}/.ReinAgent/DefaultProject`);
    }
  }

  // 3. 所有真实来源均不可用：返回空串。严禁编造任何默认路径。
  return "";
}

/**
 * 从 Tauri 后端拉取真实用户主目录并写入 `reinagent-user-home` 缓存。
 * Web / 无头浏览器环境下后端不可达，返回 null（保留既有缓存，供桌面端使用过的场景）。
 */
export async function initUserHome(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const home = await invoke<string>("path_home_dir");
    if (home && typeof home === "string" && home.trim().length > 0) {
      localStorage.setItem("reinagent-user-home", home.trim());
      return home.trim();
    }
    console.warn("path_home_dir 返回了空主目录，工作区决议将标记为未知");
    return null;
  } catch (err) {
    console.warn("path_home_dir 不可用（Web 环境或后端异常），保留既有 home 缓存", err);
    return null;
  }
}

/**
 * 展开 `~` 开头的主目录简写。
 * 主目录未知时抛出真实错误，严禁编造展开结果。
 */
function expandTildeHome(trimmed: string): string {
  const userHome = getDefaultWorkspaceRoot().replace(/\/\.ReinAgent\/DefaultProject$/, "");
  if (!userHome) {
    throw new Error("无法展开 ~ 路径：用户主目录未知（未获取到真实 home）");
  }
  return normalizePath(trimmed.replace(/^~/, userHome));
}

/**
 * 解析有效的工作区根目录：
 * 若 project 存在且非空，返回 project；否则返回 DefaultProject。
 */
export function resolveWorkspaceRoot(project?: string | null): string {
  if (project && typeof project === "string" && project.trim().length > 0) {
    const trimmed = project.trim();
    // 支持 ~ 开头的主目录简写
    if (trimmed.startsWith("~/") || trimmed === "~") {
      return expandTildeHome(trimmed);
    }
    return normalizePath(trimmed);
  }
  return getDefaultWorkspaceRoot();
}

/**
 * 对齐 ZCode 的 resolveWorkspacePath 机制：
 * - 若 inputPath 是绝对路径，直接规范化返回；
 * - 若 inputPath 是相对路径，自动基于 workspaceRoot 拼接；
 * - 处理空路径防护。
 */
export function resolveWorkspacePath(inputPath: string, workspaceRoot: string): string {
  if (!inputPath || typeof inputPath !== "string" || inputPath.trim().length === 0) {
    return normalizePath(workspaceRoot);
  }

  const trimmed = inputPath.trim();

  // 绝对路径（POSIX / 开头 或 Windows 驱动器 C:\ 开头）
  if (isAbsolutePath(trimmed)) {
    return normalizePath(trimmed);
  }

  // ~ 开头主目录简写
  if (trimmed.startsWith("~/") || trimmed === "~") {
    return expandTildeHome(trimmed);
  }

  // 相对路径：基于 workspaceRoot 拼接
  const root = normalizePath(workspaceRoot).replace(/\/+$/, "");
  if (!root) {
    throw new Error("工作区根目录未知，无法解析相对路径");
  }
  const rel = trimmed.replace(/^\.\//, "");
  return normalizePath(`${root}/${rel}`);
}

/**
 * 判断是否为绝对路径（兼容 POSIX / 和 Windows 盘符 C:）
 */
export function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/");
}

/**
 * 规范化路径：统一转换为正斜杠并折叠多余斜杠和 . / ..
 */
export function normalizePath(p: string): string {
  if (!p) return "";
  const isWindowsDrive = /^[a-zA-Z]:[\\/]/.test(p);
  let prefix = "";
  let cleanPath = p;

  if (isWindowsDrive) {
    prefix = p.slice(0, 3).replace(/\\/g, "/");
    cleanPath = p.slice(3);
  } else if (p.startsWith("/")) {
    prefix = "/";
    cleanPath = p.slice(1);
  }

  const parts = cleanPath.split(/[\\/]+/).filter(Boolean);
  const stack: string[] = [];

  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") {
        stack.pop();
      } else if (!prefix) {
        stack.push("..");
      }
    } else {
      stack.push(part);
    }
  }

  const joined = stack.join("/");
  if (!prefix) return joined || ".";
  if (prefix === "/") return "/" + joined;
  return prefix + joined;
}
