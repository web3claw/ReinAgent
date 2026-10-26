/**
 * 索引计划与增量比对（纯模块，无 Tauri 依赖，node --test 可直跑）。
 *
 * - computeIndexPlan：扫描行 vs 库内元数据 → 需索引/需删除/未变化三清单
 *   （fingerprint 不同或上次 status=error 的源都要重索引——错误源不静默放过）。
 * - diffChunks：新块 vs 旧块按 (headingPath + content) 键匹配复用旧向量
 *   （Hetu 增量语义：内容未变不重算 embedding；位置无关，段落插入也能命中复用）。
 */

export interface KnowledgeScanRow {
  sourceId: string;
  sourceType: "note" | "import" | "wiki";
  title: string;
  sourcePath: string;
  fingerprint: string;
}

export interface KnowledgeStoredMeta {
  sourceId: string;
  fingerprint: string;
  status: string;
}

export interface IndexPlan {
  toIndex: KnowledgeScanRow[];
  toDelete: string[];
  unchanged: string[];
}

export function computeIndexPlan(
  scanned: KnowledgeScanRow[],
  stored: KnowledgeStoredMeta[],
): IndexPlan {
  const storedMap = new Map(stored.map((m) => [m.sourceId, m]));
  const scannedIds = new Set(scanned.map((r) => r.sourceId));
  const toIndex: KnowledgeScanRow[] = [];
  const unchanged: string[] = [];
  for (const row of scanned) {
    const prev = storedMap.get(row.sourceId);
    if (!prev || prev.fingerprint !== row.fingerprint || prev.status !== "ok") {
      toIndex.push(row);
    } else {
      unchanged.push(row.sourceId);
    }
  }
  const toDelete = stored
    .map((m) => m.sourceId)
    .filter((id) => !scannedIds.has(id));
  return { toIndex, toDelete, unchanged };
}

export interface OldChunk {
  headingPath: string;
  content: string;
  embedding: number[];
}

export interface NewChunk {
  headingPath: string;
  content: string;
}

export interface ChunkDiff {
  /** 与 newChunks 等长：i 位为旧向量（可复用）或 null（需向量化） */
  reusable: Array<number[] | null>;
  /** 需要调 embedding 的 newChunks 下标 */
  toEmbed: number[];
}

export function diffChunks(oldChunks: OldChunk[], newChunks: NewChunk[]): ChunkDiff {
  const key = (c: { headingPath: string; content: string }) => `${c.headingPath}\u0000${c.content}`;
  const oldMap = new Map<string, number[]>();
  for (const chunk of oldChunks) {
    const k = key(chunk);
    if (!oldMap.has(k)) oldMap.set(k, chunk.embedding);
  }
  const reusable: Array<number[] | null> = [];
  const toEmbed: number[] = [];
  newChunks.forEach((chunk, i) => {
    const hit = oldMap.get(key(chunk));
    if (hit) {
      reusable.push(hit);
    } else {
      reusable.push(null);
      toEmbed.push(i);
    }
  });
  return { reusable, toEmbed };
}
