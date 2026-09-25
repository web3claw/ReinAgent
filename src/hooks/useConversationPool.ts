/**
 * useConversationPool —— React 侧的池化胶水层。
 *
 * 对给定 taskId：从会话池取（或创建）该任务的 controller 条目，
 * 用 useSyncExternalStore 订阅其状态。切换任务只是换订阅目标——
 * 后台任务的流式管线由池持有，与本 hook 的生命周期无关。
 *
 * send/stop 按显式 taskId 路由（对齐 LiveAgent「Stop only ever targets
 * the conversation the user is looking at」——永不回落到 any running）。
 */

import { useCallback, useSyncExternalStore } from "react";
import type { ChatState } from "../lib/chat/conversationModel";
import {
  ensureEntry,
  subscribeTask,
  getEntrySnapshot,
  send as poolSend,
  stop as poolStop,
  type PoolSendOptions,
} from "../lib/chat/conversationPool";
import { initialState } from "../lib/chat/conversationModel";

export interface UseConversationPoolResult {
  state: ChatState;
  /** 该任务是否已完成水合（从 SQLite 载入） */
  hydrated: boolean;
  send: (text: string, options: PoolSendOptions) => boolean;
  stop: () => void;
  isStreaming: boolean;
}

export function useConversationPool(taskId: string | null): UseConversationPoolResult {
  // 同步 ensure（幂等；水合在内部异步进行，完成后 notify 触发重渲染）
  const entry = taskId ? ensureEntry(taskId) : null;

  const subscribe = useCallback(
    (listener: () => void) => {
      if (!taskId) return () => undefined;
      return subscribeTask(taskId, listener);
    },
    [taskId],
  );

  // getSnapshot 必须返回稳定引用：草稿态（taskId=null）走池的 EMPTY_STATE 常量，
  // 否则 useSyncExternalStore 判定快照不稳定 → 无限重渲染 → 白屏。
  const getSnapshot = useCallback(() => {
    return getEntrySnapshot(taskId);
  }, [entry, taskId]);

  useSyncExternalStore(subscribe, getSnapshot);

  const send = useCallback(
    (text: string, options: PoolSendOptions) => {
      if (!taskId) return false;
      return poolSend(taskId, text, options);
    },
    [taskId],
  );

  const stop = useCallback(() => {
    if (taskId) poolStop(taskId);
  }, [taskId]);

  const state = entry ? entry.state : initialState();
  return {
    state,
    hydrated: entry ? entry.hydrated : true,
    send,
    stop,
    isStreaming: state.status === "streaming",
  };
}
