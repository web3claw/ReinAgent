/**
 * promptHistory 存储（P2，对齐 ZCode promptHistoryStorage）：
 * per-workspace localStorage（键 `reinagent-chat-prompt-history:<workspace>`），
 * 重启后历史保留、不同项目不串。JSON 数组落盘，读时消毒。
 *
 * 我们的无 window 环境走 kv（与草稿同通道）；浏览器环境走 localStorage。
 */

import { kvGet, kvSet } from "../storage/db";

export const MAX_PROMPT_HISTORY = 30;

const STORAGE_KEY_PREFIX = "reinagent-chat-prompt-history:";

export function getPromptHistoryStorageKey(workspacePath: string): string {
  return `${STORAGE_KEY_PREFIX}${workspacePath}`;
}

function normalizeEntries(entries: readonly unknown[]): string[] {
  return entries
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(-MAX_PROMPT_HISTORY);
}

export function readPromptHistoryEntries(workspacePath: string): string[] {
  const raw = kvGet(getPromptHistoryStorageKey(workspacePath));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalizeEntries(parsed);
  } catch {
    return [];
  }
}

export function persistPromptHistoryEntries(
  workspacePath: string,
  entries: readonly string[],
): void {
  kvSet(
    getPromptHistoryStorageKey(workspacePath),
    JSON.stringify(normalizeEntries(entries)),
  );
}
