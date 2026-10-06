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
  /**
   * 透明解压读文本（dsh 的 zstd 多帧日志；无后缀按普通文本）。
   * 可选能力：内存测试实现可不提供（dsh 的 .zstd 条目在这些测试里会被跳过）。
   */
  readTextAuto?(path: string): Promise<string | null>;
}

/**
 * 只读 SQLite 访问（SQLite 型来源：zcode/cursor/copilot/hermes/openclaw/devin）。
 * Rust 端 import_sqlite_query 照 Wake sqlite_ro 约定：READ_ONLY 直开 → copy 降级，
 * 仅放行 SELECT/PRAGMA/WITH。查询失败（库不存在/锁死/语句错）返回 null——外部
 * 工具数据缺失是常态，与 ImportFs 同一宽容语义。
 */
export interface ImportSqliteResult {
  columns: string[];
  /** 每行按 columns 顺序对齐的值数组。 */
  rows: unknown[][];
}

export interface ImportDb {
  query(path: string, sql: string, params?: unknown[]): Promise<ImportSqliteResult | null>;
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
