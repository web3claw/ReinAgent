/**
 * workspace.ts —— ReinAgent 工作区目录决议与路径策略（对齐 ZCode 设计规范）。
 * ============================================================================
 * 1. 任务指定了项目 -> 使用项目指定的文件夹路径；
 * 2. 未指定项目 -> 使用用户主目录下的 `~/.ReinAgent/DefaultProject` 作为工作区文件夹；
 * 3. 相对路径决议 -> 统一通过 `resolveWorkspacePath` 解析为工作区下的绝对路径，
 *    彻底杜绝相对路径直接落入后端 `src-tauri` 目录的问题。
 */

/**
 * 获取系统默认工作区路径：~/.ReinAgent/DefaultProject
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

  // 3. 通用 Unix 默认回退
  return "/home/web3claw/.ReinAgent/DefaultProject";
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
      const defaultRoot = getDefaultWorkspaceRoot();
      const userHome = defaultRoot.replace(/\/\.ReinAgent\/DefaultProject$/, "");
      return normalizePath(trimmed.replace(/^~/, userHome));
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
    const defaultRoot = getDefaultWorkspaceRoot();
    const userHome = defaultRoot.replace(/\/\.ReinAgent\/DefaultProject$/, "");
    return normalizePath(trimmed.replace(/^~/, userHome));
  }

  // 相对路径：基于 workspaceRoot 拼接
  const root = normalizePath(workspaceRoot).replace(/\/+$/, "");
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
