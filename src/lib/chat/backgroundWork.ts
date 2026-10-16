/**
 * 后台工作状态源（对齐 ZCode buildConversationStatusPanelModel 的最小移植）。
 *
 * 两个视图（composer 徽标 + 管理浮层）共用同一真值：
 * - 子代理：subagentRegistry（running 记录，前台+后台都算——ZCode 同样把
 *   前台子代理计入 Agents 区）；
 * - 终端：bg_list() 的 running 后台任务（background_bash 启动的进程）。
 *   bg_list 无推送事件，用可暂停的 1s 轮询（有订阅者才轮询；对齐 ZCode
 *   BackgroundBashOutputSidePane 的 1s 轮询先例）。
 *
 * 会话隔离支持：
 * - 每个后台任务（终端/子代理）关联启动它的 conversationId；
 * - useBackgroundWork(conversationId) 默认按当前会话过滤；
 * - 新建任务（conversationId 为空/未提供）时返回空列表，绝不跨会话串台显示其他任务进程。
 */

import { invoke } from "@tauri-apps/api/core";
import { useMemo, useSyncExternalStore } from "react";
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
  /** 所属会话 ID（未绑定时为 undefined）。 */
  conversationId?: string;
}

export interface BackgroundSubagentWork {
  id: string;
  type: string;
  description: string;
  startedAt: number;
  /** 后台运行可独立停止；前台运行挂在父轮 signal 上，如实不可停。 */
  stoppable: boolean;
  /** 所属会话 ID（未绑定时为 undefined）。 */
  conversationId?: string;
}

export interface BackgroundWorkState {
  terminals: BackgroundTerminalWork[];
  subagents: BackgroundSubagentWork[];
}

/** 终端后台任务 taskId -> conversationId 映射表。 */
const terminalConversationMap = new Map<string, string>();

/** 绑定终端后台任务到指定会话。 */
export function bindTerminalToConversation(taskId: string, conversationId: string): void {
  if (!taskId || !conversationId) return;
  terminalConversationMap.set(taskId, conversationId);
  // 若当前状态中已有该终端，同步更新其 conversationId 并通知监听者
  let updated = false;
  const terminals = state.terminals.map((t) => {
    if (t.taskId === taskId && t.conversationId !== conversationId) {
      updated = true;
      return { ...t, conversationId };
    }
    return t;
  });
  if (updated) {
    state = { ...state, terminals };
    notify();
  }
}

/** 获取终端后台任务绑定的会话 ID。 */
export function getTerminalConversation(taskId: string): string | undefined {
  return terminalConversationMap.get(taskId);
}

/** 从会话历史消息中同步扫描并绑定 background_bash 终端归属。 */
export function syncConversationTerminals(conversationId: string, messages: any[]): void {
  if (!conversationId || !Array.isArray(messages)) return;
  for (const msg of messages) {
    const parts = Array.isArray(msg?.content) ? msg.content : Array.isArray(msg?.parts) ? msg.parts : [];
    for (const part of parts) {
      // 提取 toolResult 中携带的 taskId
      let taskId: string | undefined =
        part?.details?.taskId ??
        part?.toolResult?.details?.taskId ??
        part?.outputDetails?.taskId;

      // 若 details 未包含，尝试从文本 "Background task started: bg-xxx" 正则匹配
      if (!taskId && typeof part?.content === "string") {
        const m = part.content.match(/Background task started:\s*(bg-[^\s\n]+)/);
        if (m) taskId = m[1];
      }
      if (!taskId && typeof part?.text === "string") {
        const m = part.text.match(/Background task started:\s*(bg-[^\s\n]+)/);
        if (m) taskId = m[1];
      }

      if (taskId) {
        bindTerminalToConversation(taskId, conversationId);
      }
    }
  }
}

/** 按会话过滤后台工作：新建任务（conversationId 未提供）一律返回空。 */
export function filterBackgroundWork(
  sourceState: BackgroundWorkState,
  conversationId?: string,
): BackgroundWorkState {
  if (!conversationId) {
    return { terminals: [], subagents: [] };
  }
  return {
    terminals: sourceState.terminals.filter((t) => t.conversationId === conversationId),
    subagents: sourceState.subagents.filter((s) => s.conversationId === conversationId),
  };
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
          .map((t) => ({
            taskId: t.taskId,
            startedAtMs: t.startedAtMs,
            outputTail: t.newOutput,
            conversationId: terminalConversationMap.get(t.taskId),
          }));
        if (
          terminals.length !== state.terminals.length ||
          terminals.some(
            (t, i) =>
              t.taskId !== state.terminals[i]?.taskId ||
              t.outputTail !== state.terminals[i]?.outputTail ||
              t.conversationId !== state.terminals[i]?.conversationId,
          )
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
      conversationId: r.conversationId,
    }));
}

/** 子代理注册表推送 → 并入联合状态（幂等）。 */
function handleSubagentSnapshot(records: SubagentRunRecord[]): void {
  const subagents = subagentsToWork(records);
  if (
    subagents.length !== state.subagents.length ||
    subagents.some(
      (s, i) =>
        s.id !== state.subagents[i]?.id ||
        s.description !== state.subagents[i]?.description ||
        s.conversationId !== state.subagents[i]?.conversationId,
    )
  ) {
    state = { ...state, subagents };
    notify();
  }
}

// 注册表推送直接并入联合状态（订阅一次，生命周期与模块同长）；
// 不放 hook 体里——handleSubagentSnapshot 在渲染期调用会违反纯渲染纪律。
subscribeSubagentRuns(() => handleSubagentSnapshot(getSubagentRunSnapshot()));

/**
 * 获取后台工作状态。
 * @param conversationId 可选。传入时按该会话过滤；未传入（如新建任务）时一律返回空。
 */
export function useBackgroundWork(conversationId?: string): BackgroundWorkState {
  const rawState = useSyncExternalStore(subscribe, getSnapshot);
  return useMemo(() => filterBackgroundWork(rawState, conversationId), [rawState, conversationId]);
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

/** 仅供测试使用：设置模拟状态。 */
export function __setMockStateForTests(mockState: BackgroundWorkState): void {
  state = { ...mockState };
  notify();
}

/** 仅供测试使用：重置映射表。 */
export function __resetTerminalConversationMapForTests(): void {
  terminalConversationMap.clear();
}
