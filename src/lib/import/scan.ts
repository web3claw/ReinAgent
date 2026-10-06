/**
 * Tauri IO 层：把 fs 命令包成 ImportFs、sqlite 命令包成 ImportDb，汇总全来源会话扫描。
 */

import { invoke } from "@tauri-apps/api/core";
import { getStoredUserHome } from "../storage/db";
import { createSessionImporters } from "./importers";
import { scanCodexSessionsResult } from "./importers";
import type { ImportDb, ImportFs, ImportSqliteResult } from "./fsApi";
import type { ExternalSessionSummary, ExternalSource, ImportedSession } from "./types";

export const CODEX_SCAN_MAX_FILES = 250;

/** 应用内实现：Tauri fs 命令（外部工具数据缺失 = 常态空，不报错）。 */
export const tauriImportFs: ImportFs = {
  async readText(path) {
    try {
      return await invoke<string>("fs_read_file", { path });
    } catch {
      return null;
    }
  },
  async listDir(path) {
    try {
      return await invoke<string[]>("fs_list_dir", { path });
    } catch {
      return [];
    }
  },
  async readEnds(path, headLen, tailLen) {
    try {
      const r = await invoke<{ head: string; tail: string; totalBytes: number; mtimeMs: number | null }>(
        "fs_read_file_ends",
        { path, headLen, tailLen },
      );
      return { head: r.head, tail: r.tail, totalBytes: r.totalBytes, mtimeMs: r.mtimeMs ?? null };
    } catch {
      return null;
    }
  },
  async readRange(path, offset, length) {
    try {
      const r = await invoke<{ content: string; bytesRead: number; isBinary: boolean }>(
        "fs_read_text_file",
        { path, offset, length },
      );
      return r.isBinary ? null : r.content;
    } catch {
      return null;
    }
  },
  async readTextAuto(path) {
    try {
      return await invoke<string>("import_read_text_auto", { path });
    } catch {
      return null;
    }
  },
};

/** 只读 SQLite 访问（SQLite 型来源用；失败如实返回 null，宽容语义同 fs）。 */
export const tauriImportDb: ImportDb = {
  async query(path, sql, params) {
    try {
      return await invoke<ImportSqliteResult>("import_sqlite_query", { path, sql, params: params ?? [] });
    } catch {
      return null;
    }
  },
};

export async function scanAllSessions(): Promise<{
  sessions: ExternalSessionSummary[];
  truncated: Partial<Record<ExternalSource, number>>;
}> {
  const home = getStoredUserHome() ?? "";
  const truncated: Partial<Record<ExternalSource, number>> = {};
  if (!home) return { sessions: [], truncated };
  const importers = createSessionImporters(tauriImportFs, home, tauriImportDb);
  const results = await Promise.all(
    importers.map(async (imp) => {
      try {
        if (imp.source === "codex") {
          { /* scanCodexSessionsResult 静态引入（同模块 ./importers） */ }
          const result = await scanCodexSessionsResult(tauriImportFs, home, CODEX_SCAN_MAX_FILES);
          if (result.truncated) truncated.codex = CODEX_SCAN_MAX_FILES;
          return result.sessions;
        }
        return await imp.scan();
      } catch {
        return [];
      }
    }),
  );
  // 引擎副本认领（Wake claimed_sessions 同款）：craft 会话存在期间，
  // 其 Claude/Pi 引擎在别家目录里落的转录副本不重复导入。
  const claimed = new Set<string>();
  for (const imp of importers) {
    for (const claim of imp.claimed?.() ?? []) {
      claimed.add(`${claim.source}:${claim.externalId}`);
    }
  }
  const sessions = results
    .flat()
    .filter((s) => !claimed.has(`${s.source}:${s.externalId}`))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  // 同源同 id 去重（opencode 目录版与 sqlite 版并存时可能重叠）：保留最新者。
  const dedup = new Map<string, ExternalSessionSummary>();
  for (const session of sessions) {
    const key = `${session.source}:${session.externalId}`;
    if (!dedup.has(key)) dedup.set(key, session);
  }
  return { sessions: [...dedup.values()], truncated };
}

export async function convertSession(summary: ExternalSessionSummary): Promise<ImportedSession> {
  const home = getStoredUserHome() ?? "";
  const importer = createSessionImporters(tauriImportFs, home, tauriImportDb).find(
    (imp) => imp.source === summary.source,
  );
  if (!importer) throw new Error(`unknown import source: ${summary.source}`);
  return importer.convert(summary);
}
