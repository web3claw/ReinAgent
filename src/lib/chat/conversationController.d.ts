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
    /** 本轮用户消息附带的图片（原生 image content block 内联）。 */
    images?: { base64: string; mimeType: string }[];
    /** 本轮用户消息附带的文件/图片（时间线展示 + 随消息持久化）。 */
    userAttachments?: import("./conversationModel").UserEntryAttachment[];
  };
  /** AbortController 工厂（可注入以在测试中控制）。 */
  createAbortController?: () => AbortController;
  /** 时钟（可注入以便确定性测试）。 */
  now?: () => number;
  /** 本会话归属的任务 id（检查点上下文来源；缺省=不捕获检查点）。 */
  taskId?: string;
  /** 轮边界回调（检查点 begin_turn 打点；缺省=无）。 */
  onTurnBegin?: (turnId: string) => void;
  /** 压缩生命周期事件（started/done/failed/skipped），供池转发 UI */
  onCompactionEvent?: (event: { type: string; manual?: boolean; error?: string; turnCount?: number; summaryChars?: number }) => void;
  /**
   * Fail-Fast：读取某模型（键 `provider/modelId`）的经验 prompt 上限 tokens；
   * 缺省 = 没有记录。用于把压缩水位线收敛到实测真实限制（见 promptCeiling.ts）。
   */
  getPromptCeiling?: (modelKey: string) => number | undefined;
  /**
   * Fail-Fast：prompt 已达水位线却仍以连接/上下文类错误失败时上报其大小；
   * 实现方（池）负责持久化（只收紧不放宽）。
   */
  onPromptCeilingExceeded?: (modelKey: string, failedPromptTokens: number) => void;
}

export interface ConversationController {
  /** 发送用户消息；返回本次是否被受理（false=空文本或正在流式中）。 */
  send: (text: string) => boolean;
  /**
   * 编辑重发（对齐 LiveAgent 硬截断）：把锚点 user 消息原位替换为新文本，
   * 其后的旧分支全部移除后作为全新一轮重跑。返回是否被受理（false=忙/锚点不存在）。
   */
  editResend: (anchorMessageId: string, text: string) => boolean;
  /** 停止当前轮次（解除审批挂起 + 中止并标注「已停止」）。 */
  stop: () => void;
  /** 清空会话。 */
  clear: () => void;
  /** 加载或切换到指定消息列表。 */
  loadState: (messages: import("./conversationModel").TimelineEntry[]) => void;
  /** 审批门挂起入口（runAgentTurn 的协调器回调到这）。 */
  /** 手动压缩（忙时 false） */
  compactNow: () => boolean;
  /** P2-F1：撤回一条排队中的 steering 消息（按下标）。 */
  removeSteerMessage: (index: number) => void;
  requestApproval: (req: import("./conversationModel").PendingApproval) => Promise<
    import("../providers/runAgentTurn").ApprovalDecision
  >;
  /** 解决当前挂起的审批（allow/always/reject）；无挂起时静默。 */
  resolveApproval: (decision: import("../providers/runAgentTurn").ApprovalDecision) => void;
}

export function createConversationController(
  options: ConversationControllerOptions,
): ConversationController;
