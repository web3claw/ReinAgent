/**
 * db.ts —— SQLite 存储客户端（Tauri IPC 封装）。
 *
 * 启动时 `initStorage()` 一次性拉取：kv 全量、任务元数据列表、用户主目录，
 * 缓存在模块级内存中 —— 之后所有同步读都走缓存（useAppStore 初始化、
 * ProjectList 折叠状态等无需等待异步）；写入走写透（缓存 + 防抖批量 IPC）。
 *
 * 对齐 LiveAgent：每任务写串行（promise 链）、运行中条目豁免驱逐、
 * 内存态与持久层的对齐由调用方（会话池）管理。
 */

import { invoke } from "@tauri-apps/api/core";

let kvCache = new Map<string, string>();
let taskCache: { id: string; payload: string; updated_at: number }[] = [];
let homeDir: string | null = null;
let initialized = false;

// ---- 写透队列：kv 批量防抖 / 任务列表防抖 ----
let kvFlushTimer: number | null = null;
const kvPending = new Map<string, string>();
let taskSyncTimer: number | null = null;
let taskSyncPending: { id: string; payload: string; updated_at: number }[] | null = null;

function flushKv() {
  if (kvPending.size === 0) return;
  const pairs = Array.from(kvPending.entries()).map(([key, value]) => ({ key, value }));
  kvPending.clear();
  invoke("kv_set_many", { pairs }).catch((err) =>
    console.error("[db] kv_set_many failed:", err),
  );
}

function flushTasks() {
  if (!taskSyncPending) return;
  const tasks = taskSyncPending;
  taskSyncPending = null;
  invoke("task_sync", { tasks }).catch((err) =>
    console.error("[db] task_sync failed:", err),
  );
}

/** 启动初始化：拉取 kv 全量 + 任务列表 + 用户主目录。main.tsx 在渲染前 await。 */
export async function initStorage(): Promise<void> {
  if (initialized) return;
  try {
    const [kvPairs, tasks, home] = await Promise.all([
      invoke<{ key: string; value: string }[]>("kv_get_all"),
      invoke<{ id: string; payload: string; updated_at: number }[]>("task_list"),
      invoke<string | null>("path_home_dir").catch(() => null),
    ]);
    kvCache = new Map(kvPairs.map((p) => [p.key, p.value]));
    taskCache = tasks;
    homeDir = home && home.trim().length > 0 ? home : null;
  } catch (err) {
    // 初始化失败：缓存为空，应用以默认值启动（No-Fallback：不编造数据），
    // 后续写入仍会尝试落库。
    console.error("[db] initStorage failed:", err);
  }
  initialized = true;
}

export function isStorageInitialized(): boolean {
  return initialized;
}

// ---- kv 同步读（缓存） / 写透 ----

export function kvGet(key: string): string | null {
  return kvCache.get(key) ?? null;
}

export function kvGetJSON<T>(key: string): T | null {
  const raw = kvCache.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    console.error(`[db] kv JSON parse failed for ${key}:`, e);
    return null;
  }
}

/** 环境无关定时器（Node 测试环境无 window； flushKv/flushTasks 自带 invoke 失败兜底）。 */
function scheduleDebounce(timerKey: "kv" | "tasks"): void {
  const run = () => {
    if (timerKey === "kv") {
      kvFlushTimer = null;
      flushKv();
    } else {
      taskSyncTimer = null;
      flushTasks();
    }
  };
  const done = () => run();
  if (typeof window !== "undefined") {
    if (timerKey === "kv") kvFlushTimer = window.setTimeout(done, 200);
    else taskSyncTimer = window.setTimeout(done, 200);
  } else if (typeof setTimeout === "function") {
    if (timerKey === "kv") kvFlushTimer = setTimeout(done, 200) as unknown as number;
    else taskSyncTimer = setTimeout(done, 200) as unknown as number;
  }
}

export function kvSet(key: string, value: string): void {
  kvCache.set(key, value);
  kvPending.set(key, value);
  if (kvFlushTimer !== null) return;
  scheduleDebounce("kv");
}

export function kvSetJSON(key: string, value: unknown): void {
  kvSet(key, JSON.stringify(value));
}

// ---- 任务元数据 ----

export function getTaskListCached(): { id: string; payload: string; updated_at: number }[] {
  return taskCache;
}

/** 全量同步任务列表（防抖；调用方在任务增删改后调用）。seq 由索引派生（= 创建顺序）。 */
export function syncTasks(
  tasks: { id: string; payload: string; updated_at: number }[],
): void {
  taskCache = tasks.map((t, index) => ({ ...t, seq: index }));
  taskSyncPending = taskCache;
  if (taskSyncTimer !== null) return;
  scheduleDebounce("tasks");
}

// ---- 用户主目录 ----

export function getStoredUserHome(): string | null {
  return homeDir;
}

export function setStoredUserHome(home: string): void {
  homeDir = home;
}

// ---- 提示：对话条目持久化在会话池层（conversationPool.ts），
// 按 LiveAgent 的边界制写入 conversation_message / part 两表。 ----
