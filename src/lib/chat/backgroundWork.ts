/**
 * 后台工作状态源（对齐 ZCode buildConversationStatusPanelModel 的最小移植）。
 *
 * 两个视图（composer 徽标 + 管理浮层）共用同一真值：
 * - 子代理：subagentRegistry（running 记录，前台+后台都算——ZCode 同样把
 *   前台子代理计入 Agents 区）；
 * - 终端：bg_list() 的 running 后台任务（background_bash 启动的进程）。
 *   bg_list 无推送事件，用可暂停的 1s 轮询（有订阅者才轮询；对齐 ZCode
 *   BackgroundBashOutputSidePane 的 1s 轮询先例）。
 */

import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import {
  getSubagentRunSnapshot,
  stopRun,
  subscribeSubagentRuns,
  type SubagentRunRecord,
} from "../subagents/subagentRegistry";

export interface BackgroundTerminalWork {
  taskId: string;
  startedAtMs: number;
  /** 尾部输出（bg_list 每次回 2KB 尾部；浮层行做摘要展示）。 */
  outputTail: string;
}

export interface BackgroundSubagentWork {
  id: string;
  type: string;
  description: string;
  startedAt: number;
  /** 后台运行可独立停止；前台运行挂在父轮 signal 上，如实不可停。 */
  stoppable: boolean;
}

interface BackgroundWorkState {
  terminals: BackgroundTerminalWork[];
  subagents: BackgroundSubagentWork[];
}

let state: BackgroundWorkState = { terminals: [], subagents: [] };
const listeners = new Set<() => void>();
let pollTimer: number | null = null;
let pollInFlight = false;

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      console.error("[background-work] listener failed:", err);
    }
  }
}

/** 终端 1s 轮询：有订阅者才启动；连续失败 3 次自动停（如非 Tauri 环境）。 */
function ensurePolling(): void {
  if (pollTimer !== null) return;
  let failures = 0;
  const tick = async () => {
    if (listeners.size === 0) {
      maybeStopPolling();
      return;
    }
    if (!pollInFlight) {
      pollInFlight = true;
      try {
        const list = await invoke<
          Array<{ taskId: string; status: string; startedAtMs: number; newOutput: string }>
        >("bg_list");
        failures = 0;
        const terminals: BackgroundTerminalWork[] = list
          .filter((t) => t.status === "running")
          .map((t) => ({ taskId: t.taskId, startedAtMs: t.startedAtMs, outputTail: t.newOutput }));
        if (
          terminals.length !== state.terminals.length ||
          terminals.some((t, i) => t.taskId !== state.terminals[i]?.taskId || t.outputTail !== state.terminals[i]?.outputTail)
        ) {
          state = { ...state, terminals };
          notify();
        }
      } catch {
        failures += 1;
        if (failures >= 3) {
          maybeStopPolling();
          return;
        }
      } finally {
        pollInFlight = false;
      }
    }
    pollTimer = window.setTimeout(tick, 1000);
  };
  pollTimer = window.setTimeout(tick, 0);
}

function maybeStopPolling(): void {
  if (pollTimer !== null && listeners.size === 0) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  ensurePolling();
  return () => {
    listeners.delete(listener);
    maybeStopPolling();
  };
}

function getSnapshot(): BackgroundWorkState {
  return state;
}

function subagentsToWork(records: SubagentRunRecord[]): BackgroundSubagentWork[] {
  return records
    .filter((r) => r.status === "running")
    .map((r) => ({
      id: r.id,
      type: r.type,
      description: r.description,
      startedAt: r.startedAt,
      stoppable: r.background,
    }));
}

/** 子代理注册表推送 → 并入联合状态（幂等）。 */
function handleSubagentSnapshot(records: SubagentRunRecord[]): void {
  const subagents = subagentsToWork(records);
  if (
    subagents.length !== state.subagents.length ||
    subagents.some((s, i) => s.id !== state.subagents[i]?.id || s.description !== state.subagents[i]?.description)
  ) {
    state = { ...state, subagents };
    notify();
  }
}

// 注册表推送直接并入联合状态（订阅一次，生命周期与模块同长）；
// 不放 hook 体里——handleSubagentSnapshot 在渲染期调用会违反纯渲染纪律。
subscribeSubagentRuns(() => handleSubagentSnapshot(getSubagentRunSnapshot()));

export function useBackgroundWork(): BackgroundWorkState {
  // 单一 store：轮询源 + 推送源都归并进 state，这里只订阅它。
  useSyncExternalStore(subscribe, getSnapshot);
  return state;
}

/** 停止一个后台终端任务。 */
export async function stopTerminalWork(taskId: string): Promise<boolean> {
  try {
    const result = await invoke<{ taskId: string; stopped: boolean }>("bg_stop", { taskId });
    return result.stopped;
  } catch (err) {
    console.error("[background-work] stop terminal failed:", err);
    return false;
  }
}

/** 停止一个子代理运行（后台运行才可停；返回是否存在且已请求）。 */
export function stopSubagentWork(id: string): boolean {
  return stopRun(id);
}
