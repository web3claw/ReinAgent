/**
 * conversationController 的类型声明（实现见同目录 `conversationController.js`）。
 *
 * 与 conversationModel 一致，采用「.js 实现 + .d.ts 声明」，以便：
 *   - Node（`node --test`）直接加载 `.js` 运行；
 *   - TS/Vite 取 `.d.ts` 做类型检查，无需预编译。
 */

import type { ChatState } from "./conversationModel";
import type { AgentSource, RunAgentTurnParams } from "../providers/runAgentTurn";
import type { RunTurnResult } from "../agent/agentRuntime";
import type { ProviderConfig } from "../providers/modelFactory";

/** 编排器依赖（全部注入，便于无头测试）。 */
export interface ConversationControllerOptions {
  /** 读取当前状态（唯一真相，用于忙判定）。 */
  getState: () => ChatState;
  /** 以「纯函数更新」的语义写回状态。 */
  setState: (updater: (prev: ChatState) => ChatState) => void;
  /** 发起一轮 agent 运行（库内部完整多轮循环；事件经 params.onEvent 回传）。 */
  runAgentTurn: (params: RunAgentTurnParams) => Promise<RunTurnResult>;
  /** 读取当前数据源/配置/系统提示词/最大步数/工作区根目录。 */
  getOptions: () => {
    source: AgentSource;
    config: ProviderConfig;
    systemPrompt: string;
    maxSteps?: number;
    workspaceRoot?: string;
    thinkingLevel?: import("../agent/agentRuntime").RunTurnDeps["thinkingLevel"];
    /** 本轮审批模式（任务级，发送时冻结；缺省 full=完全访问）。 */
    approvalMode?: import("../providers/runAgentTurn").ApprovalMode;
    /** 审批协调器（由会话池注入；缺省=不启用审批门）。 */
    approval?: import("../providers/runAgentTurn").ApprovalCoordinator;
  };
  /** AbortController 工厂（可注入以在测试中控制）。 */
  createAbortController?: () => AbortController;
  /** 时钟（可注入以便确定性测试）。 */
  now?: () => number;
}

export interface ConversationController {
  /** 发送用户消息；返回本次是否被受理（false=空文本或正在流式中）。 */
  send: (text: string) => boolean;
  /** 停止当前轮次（解除审批挂起 + 中止并标注「已停止」）。 */
  stop: () => void;
  /** 清空会话。 */
  clear: () => void;
  /** 加载或切换到指定消息列表。 */
  loadState: (messages: import("./conversationModel").TimelineEntry[]) => void;
  /** 审批门挂起入口（runAgentTurn 的协调器回调到这）。 */
  requestApproval: (req: import("./conversationModel").PendingApproval) => Promise<
    import("../providers/runAgentTurn").ApprovalDecision
  >;
  /** 解决当前挂起的审批（allow/always/reject）；无挂起时静默。 */
  resolveApproval: (decision: import("../providers/runAgentTurn").ApprovalDecision) => void;
}

export function createConversationController(
  options: ConversationControllerOptions,
): ConversationController;
