/**
 * 导入文件系统抽象：解析器只依赖此接口（node --test 用内存实现；应用内用
 * Tauri fs 命令实现）。移植自 PI-Desktop 的 node:fs 直调，改成可注入。
 */

export interface ImportFs {
  /** 读整个文本文件；不存在/失败返回 null（外部工具数据缺失是常态）。 */
  readText(path: string): Promise<string | null>;
  /** 列目录（不含排序保证）；不存在/失败返回 []。 */
  listDir(path: string): Promise<string[]>;
  /** 采样读文件头/尾完整行（Codex 大归档）；失败返回 null。 */
  readEnds(
    path: string,
    headLen: number,
    tailLen: number,
  ): Promise<{ head: string; tail: string; totalBytes: number; mtimeMs: number | null } | null>;
  /** 按字节偏移读片段（≤256KB/次）；失败返回 null。 */
  readRange(path: string, offset: number, length: number): Promise<string | null>;
}

export function joinPath(...parts: string[]): string {
  const normalized = parts
    .filter((p) => p !== "" && p !== undefined && p !== null)
    .map((p, i) => (i === 0 ? p.replace(/\\/g, "/") : p.replace(/\\/g, "/").replace(/^\/+/, "")))
    .map((p) => p.replace(/\/+$/, ""));
  return normalized.join("/");
}

/** home 目录下的子路径（home 为空串时调用方先解析 path_home_dir）。 */
export function homeJoin(home: string, ...rel: string[]): string {
  return joinPath(home.replace(/\\/g, "/"), ...rel);
}
