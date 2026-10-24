/**
 * Dream 巩固 DTO（与 Rust memory/dream.rs MemoryDreamReport 逐字段对齐，
 * serde camelCase）。独立文件避免 api.ts ↔ dreamService 循环引用。
 */

export interface MemoryDreamMergePlan {
  keeper: { scope: string; workdirHash: string; slug: string };
  keeperImportance: number;
  absorbed: Array<{ scope: string; workdirHash: string; slug: string }>;
}

export interface MemoryDreamReport {
  dryRun: boolean;
  merged: number;
  decayed: number;
  forgotten: number;
  remaining: number;
  durationMs: number;
  runId?: string | null;
  plannedMerges: MemoryDreamMergePlan[];
  skippedReason?: string | null;
}
