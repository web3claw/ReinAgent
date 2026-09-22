/**
 * conversationModel 的类型声明（实现见同目录 `conversationModel.js`）。
 *
 * 之所以用「.js 实现 + .d.ts 声明」而非直接 .ts：
 * 纯逻辑层需要能被 `node --test` 直接跑（`node --test src/lib/chat/conversationModel.test.mjs`），
 * 而不必先 `tsc` 编译整个项目。`.js`（package.json `type: "module"` → ESM）+ `.d.ts`
 * 让 Node 与 TS/Vite 各取所需，无需任何预编译步骤。
 *
 * ⚠ 运行时导入纪律：本文件**只用 `import type`**。pi-ai / pi-agent-core 的桶文件
 *   做**运行时**导入会拖入 `node:fs/promises`，导致 Vite 打包失败且报错指向 aws-sdk。
 *
 * ★ S7 类型设计说明（向后兼容优先）：
 *   时间线现在可能是「用户 / 助手 / 工具」三类条目。为让既有 UI（App.tsx →
 *   MessageList/MessageItem，均声明为 `ChatMessage[]`）**无需改动即可继续编译**，
 *   `ChatMessage.role` 放宽为 `TimelineRole`（含 "tool"），并让 `ToolTimelineEntry`
 *   成为 `ChatMessage` 的**子类型**。于是 `TimelineEntry[]` 仍可赋给 `ChatMessage[]`。
 *   工具专属字段在 `ChatMessage` 上是可选的，仅在 `ToolTimelineEntry` 上必填。
 *   （UI 真正渲染工具卡片由 S7-6 负责。）
 */

import type { AssistantMessage, AssistantMessageEvent, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentEvent } from "@earendil-works/pi-agent-core";

/** 时间线条目角色：用户 / 助手 / 工具。 */
export type TimelineRole = "user" | "assistant" | "tool";
/** 历史别名（UI 侧仍在用）。 */
export type ChatRole = TimelineRole;
export type ChatStatus = "idle" | "streaming" | "error";
export type MessageStatus = "pending" | "streaming" | "done" | "stopped" | "error";
/** 工具条目状态。 */
export type ToolEntryStatus = "running" | "done" | "error";

export interface ChatMessage {
  id: string;
  role: TimelineRole;
  /** 正文文本（仅由 text_delta 累积）。用户 / 助手使用；工具条目为空串。 */
  text: string;
  /** 思考文本（S2 不渲染，但不丢弃）。 */
  thinking: string;
  status: MessageStatus | ToolEntryStatus;
  error?: string;
  /** finish / turn_end 时保存的权威消息，供多轮上下文复用。 */
  apiMessage?: AssistantMessage | ToolResultMessage;

  // ---- 工具专属字段（仅 role === "tool" 时存在；在 ChatMessage 上可选仅为类型兼容）----
  toolCallId?: string;
  toolName?: string;
  /** 库已解析好的参数对象（勿自行拼 JSON）。 */
  args?: any;
  /** 从 `result.content` 的 text 块拼出的文本。 */
  resultText?: string;
  isError?: boolean;
  /** 工具 details（UI 用）。 */
  details?: any;

  /**
   * ★ S7：本次回复因**步数硬闸触顶**而停止的**纯展示**标注（由 `noteMaxSteps` 打上）。
   * **不参与** `toApiMessages`，也**不改变** `status`（改 status 会触发 R13 剪枝 →
   * 孤儿 toolResult → 下一次请求 400）。
   */
  truncatedBy?: "maxSteps";
}

/**
 * 工具时间线条目（S7）：一次工具调用在 UI / 上下文里的映射。
 * 由 `tool_execution_start`（建条目）/ `tool_execution_end`（结果）与
 * `turn_end.toolResults`（权威 ToolResultMessage）共同填充。
 */
export interface ToolTimelineEntry extends ChatMessage {
  role: "tool";
  toolCallId: string;
  toolName: string;
  args: any;
  status: ToolEntryStatus;
  /** 从 `result.content` 的 text 块拼出的文本。 */
  resultText: string;
  isError: boolean;
  /** ★ 权威 ToolResultMessage（`turn_end.toolResults` 里的原件）。 */
  apiMessage?: ToolResultMessage;
}

/** 时间线条目联合类型。 */
export type TimelineEntry = ChatMessage | ToolTimelineEntry;

export interface ChatState {
  messages: TimelineEntry[];
  status: ChatStatus;
  error?: string;
  /**
   * 单调递增的消息序号，用于生成**唯一** id（`m${seq}`）。
   *
   * 取代旧的 `m${messages.length}`：后者仅在「数组只增不减」前提下唯一，任何
   * 删除片段 / 重新生成 / 截断历史的功能都会让它撞 key。
   *
   * 设为**可选**：调用方可用对象字面量手造 ChatState（如测试里直接构造喂给
   * `toApiMessages`）；缺省时消息创建器回退为 `messages.length`，不会算出 NaN。
   */
  nextMessageSeq?: number;
}

export function initialState(): ChatState;
export function restoreState(messages: TimelineEntry[]): ChatState;

export function appendUser(state: ChatState, text: string): ChatState;

export function beginAssistant(state: ChatState): ChatState;

export function applyEvent(state: ChatState, ev: AssistantMessageEvent): ChatState;

/** 应用一个库事件（pi-agent-core `AgentEvent`）→ 时间线。收敛点只能是 agent_end。 */
export function applyLibraryEvent(state: ChatState, ev: AgentEvent): ChatState;

export function finish(state: ChatState, finalMessage?: AssistantMessage, error?: string): ChatState;

/** 用户主动中止：回 idle、保留已生成文本、标注「已停止」、不进入 error。 */
export function finishAborted(state: ChatState): ChatState;

/** 步数硬闸触顶：给最后一条助手条目打「已达最大步数」纯展示标注（不改 status）。 */
export function noteMaxSteps(state: ChatState): ChatState;

export function lastAssistant(state: ChatState): ChatMessage | undefined;

export function isStreaming(state: ChatState): boolean;

export function toApiMessages(state: ChatState): Message[];
