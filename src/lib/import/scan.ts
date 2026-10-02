/**
 * Tauri IO 层：把 fs 命令包成 ImportFs，汇总四来源会话扫描。
 */

import { invoke } from "@tauri-apps/api/core";
import { getStoredUserHome } from "../storage/db";
import { createSessionImporters } from "./importers";
import type { ImportFs } from "./fsApi";
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
};

export async function scanAllSessions(): Promise<{
  sessions: ExternalSessionSummary[];
  truncated: Partial<Record<ExternalSource, number>>;
}> {
  const home = getStoredUserHome() ?? "";
  const truncated: Partial<Record<ExternalSource, number>> = {};
  if (!home) return { sessions: [], truncated };
  const importers = createSessionImporters(tauriImportFs, home);
  const results = await Promise.all(
    importers.map(async (imp) => {
      try {
        if (imp.source === "codex") {
          const { scanCodexSessionsResult } = await import("./importers");
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
  return {
    sessions: results.flat().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    truncated,
  };
}

export async function convertSession(summary: ExternalSessionSummary): Promise<ImportedSession> {
  const home = getStoredUserHome() ?? "";
  const importer = createSessionImporters(tauriImportFs, home).find((imp) => imp.source === summary.source);
  if (!importer) throw new Error(`unknown import source: ${summary.source}`);
  return importer.convert(summary);
}
