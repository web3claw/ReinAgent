/**
 * subagentRegistry —— 子代理运行登记表（P1-6 增量，进程内内存态）。
 *
 * 职责：
 * - 记录每个子代理运行（前台/后台）的生命周期：running → completed | failed | stopped；
 * - 后台子代理的 AbortController 存放处（侧栏 Stop 按钮）；
 * - 供右侧「子代理」面板订阅（useSyncExternalStore）。
 *
 * ⚠ 并发纪律（并行会话池的教训）：
 * - getSnapshot 必须**返回稳定引用**——只在数据变更时重建快照数组；
 * - notify 必须**按微任务合并**——同一次同步流程内多次变更只触发一轮监听，
 *   否则流式/连续更新会打出 Maximum update depth。
 * - AbortController 等对象引用**不进快照**（内部 controls 表分离存放），
 *   快照里只有可序列化纯数据。
 */

import type { SubagentUsage } from "../providers/subagentRunner.js";

export type SubagentRunStatus = "running" | "completed" | "failed" | "stopped";

/** 快照记录（纯数据；可序列化）。 */
export interface SubagentRunRecord {
  id: string;
  type: string;
  description: string;
  prompt: string;
  status: SubagentRunStatus;
  /** 是否后台运行（agent 工具 run_in_background=true）。 */
  background: boolean;
  startedAt: number;
  endedAt?: number;
  toolUseCount?: number;
  durationMs?: number;
  usage?: SubagentUsage;
  /** 最终报告（completed 时）。 */
  summary?: string;
  error?: string;
  /** 步数触顶：true 时 summary 可能只是中间叙述而非最终报告（诚实标记）。 */
  maxStepsReached?: boolean;
  /** 是否已触发过完成通知（防重）。 */
  notified?: boolean;
}

interface RegistryState {
  /** 快照（不可变：每次变更重建数组与被变更的记录对象）。 */
  records: SubagentRunRecord[];
  /** 内部控制表（不进快照）。 */
  controls: Map<string, AbortController>;
}

const state: RegistryState = { records: [], controls: new Map() };

const listeners = new Set<() => void>();
let notifyScheduled = false;

function notify(): void {
  if (notifyScheduled) return;
  notifyScheduled = true;
  queueMicrotask(() => {
    notifyScheduled = false;
    for (const listener of listeners) {
      try {
        listener();
      } catch (err) {
        console.error("[subagent-registry] listener failed:", err);
      }
    }
  });
}

/** useSyncExternalStore 订阅面。 */
export function subscribeSubagentRuns(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** useSyncExternalStore 快照（稳定引用：仅变更时重建）。 */
export function getSubagentRunSnapshot(): SubagentRunRecord[] {
  return state.records;
}

let seq = 0;

/** 登记一次新运行（running 起点）。返回运行 id。 */
export function registerRun(input: {
  type: string;
  description: string;
  prompt: string;
  background: boolean;
  startedAt: number;
}): string {
  seq += 1;
  const id = `sub-${Date.now()}-${seq}`;
  const record: SubagentRunRecord = {
    id,
    type: input.type,
    description: input.description,
    prompt: input.prompt,
    status: "running",
    background: input.background,
    startedAt: input.startedAt,
  };
  state.records = [record, ...state.records];
  if (input.background) {
    state.controls.set(id, new AbortController());
  }
  notify();
  return id;
}

/** 更新一条记录（不可变替换；记录不存在则静默忽略——幂等）。 */
export function updateRun(id: string, patch: Partial<SubagentRunRecord>): void {
  const index = state.records.findIndex((r) => r.id === id);
  if (index === -1) return;
  const next = { ...state.records[index], ...patch };
  state.records = [...state.records.slice(0, index), next, ...state.records.slice(index + 1)];
  notify();
}

/** 运行收束（终态 + 事实字段一次写入）。 */
export function finishRun(
  id: string,
  status: "completed" | "failed" | "stopped",
  facts: {
    toolUseCount?: number;
    durationMs?: number;
    usage?: SubagentUsage;
    summary?: string;
    error?: string;
    maxStepsReached?: boolean;
  },
): void {
  updateRun(id, { status, endedAt: Date.now(), ...facts });
  state.controls.delete(id);
}

/** 请求停止一个运行；返回是否存在且处于运行中。 */
export function stopRun(id: string): boolean {
  const record = state.records.find((r) => r.id === id);
  if (!record || record.status !== "running") return false;
  const control = state.controls.get(id);
  if (control) {
    control.abort();
    return true;
  }
  // 前台运行没有独立 controller（挂在父轮 signal 上）——标记为不可停。
  return false;
}

/** 按 id 查询（tool 结果渲染用；返回快照中的引用，勿改写）。 */
export function getRun(id: string): SubagentRunRecord | undefined {
  return state.records.find((r) => r.id === id);
}

/** 后台运行的 AbortSignal（driveRun 用）；前台运行/不存在返回 undefined。 */
export function getRunSignal(id: string): AbortSignal | undefined {
  return state.controls.get(id)?.signal;
}

/** 测试隔离用：清空全部状态（生产勿调）。 */
export function __resetForTests(): void {
  state.records = [];
  state.controls.clear();
  seq = 0;
}
