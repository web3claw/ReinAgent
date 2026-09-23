/**
 * useConversation —— React 侧的胶水层（薄壳）。
 *
 * 只做三件事：把 React 的 state 读写接到纯编排器 conversationController、
 * 提供最新的 options、暴露 send/stop/clear/isStreaming。
 *
 * 所有「流式累积 / 中止 / 错误映射 / 忙判定 / 陈旧流隔离」的逻辑都在
 * conversationController + conversationModel（纯逻辑，可无头测试）。
 *
 * S4 二轮修复（A-1）：
 *   - 忙判定改为「状态派生」并落在 conversationController 内；
 *   - `send()` 返回 boolean（本次是否被受理），Composer 只在受理时清空输入框。
 *
 * S4 三轮修复（P2-1）：
 *   - 真相源改由 `stateBridge` **同步推进**（删除了原先「渲染期同步」的 `stateRef`）。
 *     同 tick 内连续 `send()` 时，第二次的 `getState()` 立即看到第一次已进入 streaming → 只受理一次。
 *   - `commit` 只接收**值**（`setState(next)`），**不**接收 updater ——
 *     否则求值会推迟到 React 提交时，「滞后」重现。
 */

import { useCallback, useMemo, useRef, useState } from "react";
import type { ChatState } from "./conversationModel";
import { initialState } from "./conversationModel";
import { createStateBridge } from "./stateBridge";
import type { StateBridge } from "./stateBridge";
import { createConversationController } from "./conversationController";
import type { ConversationController } from "./conversationController";
import { DEFAULT_SYSTEM_PROMPT, runAgentTurn } from "../providers/runAgentTurn";
import type { AgentSource } from "../providers/runAgentTurn";
import type { ProviderConfig } from "../providers/modelFactory";

export interface UseConversationOptions {
  source: AgentSource;
  config: ProviderConfig;
  systemPrompt?: string;
  maxSteps?: number;
  workspaceRoot?: string;
  thinkingLevel?: import("../agent/agentRuntime").RunTurnDeps["thinkingLevel"];
}

export interface UseConversationResult {
  state: ChatState;
  /** 发送消息；返回本次是否被受理（false=空文本或正在流式中）。 */
  send: (text: string) => boolean;
  stop: () => void;
  clear: () => void;
  loadState: (messages: import("./conversationModel").TimelineEntry[]) => void;
  isStreaming: boolean;
}

export function useConversation(options: UseConversationOptions): UseConversationResult {
  const [state, setState] = useState<ChatState>(initialState);

  // 用 ref 持有最新 options，避免把它们放进依赖导致频繁重建。
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // 唯一真相源桥接：只在首次渲染创建一次。
  // 用 ref 惰性初始化而非 useMemo：ref 在同一 fiber 上跨 StrictMode 双渲染共享，
  // 保证**恰好一个** bridge 实例（bridge 内部持有可变真相，必须单例）。
  // `commit` 以「值」语义把新状态交给 React 渲染（React 的 setState 是稳定引用）。
  const bridgeRef = useRef<StateBridge | null>(null);
  if (bridgeRef.current === null) {
    bridgeRef.current = createStateBridge({
      initialState: initialState(),
      commit: (next) => setState(next),
    });
  }
  const bridge = bridgeRef.current;

  // 纯编排器：依赖注入；真相源为 bridge（同步推进）。
  const controller = useMemo<ConversationController>(
    () =>
      createConversationController({
        getState: () => bridge.getState(),
        setState: (updater) => {
          bridge.setState(updater);
        },
        // S7-5：循环来源由 streamChat 换为 runAgentTurn（库内部多轮循环 + 工具调用）。
        // 签名与 conversationController.d.ts 期望的形状完全一致，故直接传引用。
        runAgentTurn,
        getOptions: () => {
          const { source, config, systemPrompt, maxSteps, workspaceRoot, thinkingLevel } = optionsRef.current;
          return {
            source,
            config,
            systemPrompt: systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
            maxSteps,
            workspaceRoot,
            thinkingLevel,
          };
        },
      }),
    [bridge],
  );

  const send = useCallback((text: string) => controller.send(text), [controller]);
  const stop = useCallback(() => controller.stop(), [controller]);
  const clear = useCallback(() => controller.clear(), [controller]);
  const loadState = useCallback(
    (messages: import("./conversationModel").TimelineEntry[]) => controller.loadState(messages),
    [controller],
  );

  return { state, send, stop, clear, loadState, isStreaming: state.status === "streaming" };
}
