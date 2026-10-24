/**
 * 记忆向量差分（纯模块，node --test 直跑）：按 (keys, bodyHash) 比对决定
 * 重嵌与清理；模型变更 = 全量重嵌 + 全部旧行删除。
 */

export interface MemoryEmbedScanEntry {
  scope: string;
  workdirHash: string;
  slug: string;
  bodyHash: string;
  memoryType: string;
  embedText: string;
}

export interface MemoryEmbedStoredRow {
  scope: string;
  workdirHash: string;
  slug: string;
  bodyHash: string;
  dims: number;
}

export interface MemoryEmbedScanResponse {
  entries: MemoryEmbedScanEntry[];
  stored: MemoryEmbedStoredRow[];
  modelId: string;
  dims: number | null;
}

export interface MemoryEmbedDiff {
  toEmbed: MemoryEmbedScanEntry[];
  toDelete: Array<{ scope: string; workdirHash: string; slug: string }>;
}

/** 差分纯函数（单测缝）：按 (keys, bodyHash) 比对；模型变更 → 全量重嵌 + 清旧行。 */
export function planMemoryEmbedDiff(
  scan: MemoryEmbedScanResponse,
  targetModelId: string,
): MemoryEmbedDiff {
  const storedByKey = new Map(
    scan.stored.map((row) => [`${row.scope}\u0000${row.workdirHash}\u0000${row.slug}`, row]),
  );
  const entryKeys = new Set(scan.entries.map((e) => `${e.scope}\u0000${e.workdirHash}\u0000${e.slug}`));
  const modelChanged = scan.modelId !== "" && scan.modelId !== targetModelId;
  const toEmbed = scan.entries.filter((entry) => {
    if (modelChanged) return true;
    const prev = storedByKey.get(`${entry.scope}\u0000${entry.workdirHash}\u0000${entry.slug}`);
    return !prev || prev.bodyHash !== entry.bodyHash;
  });
  const toDelete = modelChanged
    ? scan.stored.map((row) => ({ scope: row.scope, workdirHash: row.workdirHash, slug: row.slug }))
    : scan.stored
        .filter((row) => {
          const key = `${row.scope}\u0000${row.workdirHash}\u0000${row.slug}`;
          return !entryKeys.has(key);
        })
        .map((row) => ({ scope: row.scope, workdirHash: row.workdirHash, slug: row.slug }));
  return { toEmbed, toDelete };
}

