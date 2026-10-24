/**
 * 知识库自动索引触发（防抖）：笔记保存 / 导入完成后调度单源索引。
 *
 * - 每 source 一个定时器（重复触发合并）；1.5s 防抖等 Rust 侧 mtime/文件落稳；
 * - 未配置 embedding 服务商时 knowledgeIndexSingleSource 内部如实跳过（合法空态）；
 * - 失败只 console.warn——自动索引是尽力而为的旁路，绝不打扰用户主流程
 *   （手动 sweep 在设置页，失败有完整错误呈现）。
 */

import { knowledgeIndexSingleSource } from "./indexingService";

const DEBOUNCE_MS = 1500;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleKnowledgeIndex(sourceId: string, delayMs = DEBOUNCE_MS): void {
  const prev = timers.get(sourceId);
  if (prev) clearTimeout(prev);
  timers.set(
    sourceId,
    setTimeout(() => {
      timers.delete(sourceId);
      void knowledgeIndexSingleSource(sourceId).catch((err) => {
        console.warn(`[knowledge] 自动索引失败（${sourceId}）:`, err instanceof Error ? err.message : err);
      });
    }, delayMs),
  );
}
