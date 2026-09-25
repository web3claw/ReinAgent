/**
 * conversationPool —— 会话池（对齐 LiveAgent 的 ConversationRuntimeRegistry）。
 *
 * 核心语义（对齐 LiveAgent/ZCode）：
 * - `Map<taskId, PoolEntry>`：每个任务一个独立的 controller + 状态 + 监听器集合；
 * - **切任务 ≠ 停止**：切换只是换 UI 的订阅目标，后台任务的流式管线照常消费事件、
 *   更新自己的状态（「注销 ≠ 停止」，所有权单一化——池是 Agent 循环的唯一持有者）；
 * - 持久化下沉到池层：状态变化防抖写 SQLite（conversation_sync），后台任务零主线程开销；
 * - 内存治理：空闲条目 LRU 驱逐（豁免流式中），删除任务时销毁其 controller。
 *
 * 外部 store 形态（getSnapshot/subscribe/notify）供 `useSyncExternalStore` 订阅；
 * 后台任务无监听者时 notify 遍历空集合，零渲染成本。
 */

import { createConversationController } from "./conversationController";
import type { ConversationController } from "./conversationController";
import type { ChatState, TimelineEntry } from "./conversationModel";
import { initialState, restoreState } from "./conversationModel.js";
import { runAgentTurn } from "../providers/runAgentTurn";
import type { AgentSource, ApprovalCoordinator, ApprovalDecision } from "../providers/runAgentTurn";
import { invoke } from "@tauri-apps/api/core";

/** 发送选项形状 = controller deps 的 getOptions 返回类型（单一真源，避免漂移） */
type ControllerDeps = Parameters<typeof createConversationController>[0];
export type PoolSendOptions = ControllerDeps["getOptions"] extends () => infer R ? R : never;

interface PoolEntry {
  taskId: string;
  state: ChatState;
  /** 最近一次发送注入的轮次选项（每次 pool.send 更新） */
  sendOptions: PoolSendOptions | null;
  controller: ConversationController;
  listeners: Set<() => void>;
  hydrated: boolean;
  hydrating: boolean;
  lastActivityAt: number;
  persistTimer: number | null;
  notifyScheduled: boolean;
  /** 「总是允许」免审集合（任务级内存态；重启即失效，对齐一期范围）。 */
  alwaysAllowedTools: Set<string>;
}

/** 空闲条目上限（LRU 驱逐，豁免流式中），对齐 LiveAgent MAX_IDLE_CONVERSATION_RUNTIME_CACHE_ENTRIES */
const MAX_IDLE_POOL_ENTRIES = 12;
/** 持久化防抖（ms）：流式期间的高频状态变化合并为一次 SQLite 写 */
const PERSIST_DEBOUNCE_MS = 300;

const entries = new Map<string, PoolEntry>();
/** 稳定的空状态常量：useSyncExternalStore 的 getSnapshot 必须返回稳定引用 */
const EMPTY_STATE: ChatState = initialState();

// ---- 序列化：TimelineEntry ↔ message/part 两表行（对齐 LiveAgent message/part 拆分）----

function serializeEntry(entry: TimelineEntry, seq: number) {
  const parts: { part_index: number; kind: string; payload: string }[] = [];
  let partIndex = 0;
  if (entry.text) {
    parts.push({ part_index: partIndex++, kind: "text", payload: JSON.stringify({ text: entry.text }) });
  }
  if (entry.thinking) {
    parts.push({ part_index: partIndex++, kind: "thinking", payload: JSON.stringify({ thinking: entry.thinking }) });
  }
  if (entry.role === "tool") {
    parts.push({ part_index: partIndex++, kind: "tool_args", payload: JSON.stringify({ args: entry.args ?? null }) });
    if (entry.resultText) {
      parts.push({
        part_index: partIndex++,
        kind: "tool_result",
        payload: JSON.stringify({ resultText: entry.resultText, details: entry.details ?? null }),
      });
    }
  }
  // 权威 API 消息原件（对齐 LiveAgent「落盘原件而非 UI 投影」）：含 usage（token 统计、
  // 缓存命中率、上下文容量的数据源）与精确 API 格式（刷新后 toApiMessages 恢复完整历史，
  // 模型不失忆）。assistant 上是 AssistantMessage，tool 上是 ToolResultMessage。
  if (entry.apiMessage) {
    parts.push({
      part_index: partIndex++,
      kind: "api_message",
      payload: JSON.stringify(entry.apiMessage),
    });
  }
  return {
    msg_id: entry.id,
    seq,
    role: entry.role,
    status: entry.status,
    started_at: entry.startedAt ?? null,
    ended_at: entry.endedAt ?? null,
    tool_name: entry.toolName ?? null,
    tool_call_id: entry.toolCallId ?? null,
    is_error: entry.isError ?? null,
    truncated_by: entry.truncatedBy ?? null,
    error: entry.error ?? null,
    thinking_started_at: entry.thinkingStartedAt ?? null,
    thinking_duration_ms: entry.thinkingDurationMs ?? null,
    parts,
  };
}

function deserializeRow(row: {
  msg_id: string;
  role: string;
  status: string;
  started_at: number | null;
  ended_at: number | null;
  tool_name: string | null;
  tool_call_id: string | null;
  is_error: number | boolean | null;
  truncated_by: string | null;
  error: string | null;
  thinking_started_at: number | null;
  thinking_duration_ms: number | null;
  parts: { part_index: number; kind: string; payload: string }[];
}): TimelineEntry {
  let text = "";
  let thinking = "";
  let args: unknown = undefined;
  let resultText = "";
  let details: unknown = undefined;
  let apiMessage: unknown = undefined;
  for (const part of row.parts) {
    try {
      const parsed = JSON.parse(part.payload);
      if (part.kind === "text") text = parsed.text ?? "";
      else if (part.kind === "thinking") thinking = parsed.thinking ?? "";
      else if (part.kind === "tool_args") args = parsed.args;
      else if (part.kind === "tool_result") {
        resultText = parsed.resultText ?? "";
        details = parsed.details;
      } else if (part.kind === "api_message") {
        apiMessage = parsed.apiMessage ?? parsed;
      }
    } catch (e) {
      // 单块损坏不拖垮整条：跳过该块（No-Fallback：不编造内容）。
      console.error("[pool] part payload parse failed:", e);
    }
  }
  const base = {
    id: row.msg_id,
    text,
    thinking,
    status: row.status as TimelineEntry["status"],
    error: row.error ?? undefined,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    thinkingStartedAt: row.thinking_started_at ?? undefined,
    thinkingDurationMs: row.thinking_duration_ms ?? undefined,
    truncatedBy: (row.truncated_by ?? undefined) as TimelineEntry["truncatedBy"],
    apiMessage: apiMessage as TimelineEntry["apiMessage"],
  };
  if (row.role === "tool") {
    return {
      ...base,
      role: "tool",
      toolCallId: row.tool_call_id ?? "",
      toolName: row.tool_name ?? "",
      args,
      resultText,
      isError: Boolean(row.is_error),
      details,
    } as TimelineEntry;
  }
  return { ...base, role: row.role as "user" | "assistant" } as TimelineEntry;
}

// ---- 池内部 ----

function notify(entry: PoolEntry) {
  // 按微任务合并通知：pi 库的 processEvents 会在同一轮同步循环里连续发大量事件，
  // 每个事件都直接 notify 会让 useSyncExternalStore 连续 forceStoreRerender，
  // 被 React 计为嵌套更新并抛「Maximum update depth exceeded」。
  // 合并后一轮事件爆发只渲染一次（状态本身已同步更新，订阅者拿到的是最新快照）。
  if (entry.notifyScheduled) return;
  entry.notifyScheduled = true;
  queueMicrotask(() => {
    entry.notifyScheduled = false;
    for (const listener of entry.listeners) listener();
    refreshStreamingSet();
  });
}

function schedulePersist(entry: PoolEntry) {
  if (entry.persistTimer !== null) return;
  entry.persistTimer = window.setTimeout(() => {
    entry.persistTimer = null;
    const messages = entry.state.messages;
    const payload = messages.map((m, seq) => serializeEntry(m, seq));
    invoke("conversation_sync", { taskId: entry.taskId, messages: payload }).catch((err) =>
      console.error(`[pool] conversation_sync failed for ${entry.taskId}:`, err),
    );
  }, PERSIST_DEBOUNCE_MS);
}

function createEntry(taskId: string): PoolEntry {
  const entry: PoolEntry = {
    taskId,
    state: initialState(),
    controller: null as unknown as ConversationController,
    listeners: new Set(),
    hydrated: false,
    hydrating: false,
    lastActivityAt: Date.now(),
    persistTimer: null,
    notifyScheduled: false,
    sendOptions: null,
    alwaysAllowedTools: new Set<string>(),
  };
  entry.controller = createConversationController({
    getState: () => entry.state,
    setState: (updater) => {
      entry.state = updater(entry.state);
      notify(entry);
      schedulePersist(entry);
    },
    runAgentTurn,
    getOptions: () => {
      // options 由 pool.send 在每次发送时注入（活跃任务发送前更新）。
      // 兜底形状仅占位（该路径在 App 的 send 前必被注入，实际不可达）。
      return (
        entry.sendOptions ?? {
          source: "faux" as AgentSource,
          config: { apiKey: "", modelId: "" },
          systemPrompt: "",
          maxSteps: undefined,
          workspaceRoot: undefined,
          thinkingLevel: undefined,
        }
      );
    },
  });
  // 异步水合：从 SQLite 载入历史（幂等——已有消息时保留内存态，对齐 LiveAgent「运行中内存赢过磁盘」）。
  void (async () => {
    try {
      const rows = await invoke<{
        msg_id: string;
        seq: number;
        role: string;
        status: string;
        started_at: number | null;
        ended_at: number | null;
        tool_name: string | null;
        tool_call_id: string | null;
        is_error: boolean | null;
        truncated_by: string | null;
        error: string | null;
        thinking_started_at: number | null;
        thinking_duration_ms: number | null;
        parts: { part_index: number; kind: string; payload: string }[];
      }[]>("conversation_load", { taskId });
      if (rows.length > 0 && entry.state.messages.length === 0) {
        const messages = rows.map(deserializeRow);
        const restored = restoreState(messages);
        entry.state = restored;
      }
    } catch (err) {
      console.error(`[pool] conversation_load failed for ${taskId}:`, err);
    } finally {
      entry.hydrated = true;
      notify(entry);
    }
  })();
  return entry;
}

function pruneIdle(exemptTaskId?: string) {
  if (entries.size <= MAX_IDLE_POOL_ENTRIES) return;
  const idle = Array.from(entries.values())
    .filter(
      (e) =>
        e.taskId !== exemptTaskId &&
        e.state.status !== "streaming" &&
        e.listeners.size === 0,
    )
    .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
  const overflow = entries.size - MAX_IDLE_POOL_ENTRIES;
  for (let i = 0; i < Math.min(overflow, idle.length); i += 1) {
    entries.delete(idle[i].taskId);
  }
}

// ---- 对外 API ----

/** 同步获取（或创建）任务条目。创建即触发异步水合；幂等。 */
export function ensureEntry(taskId: string): PoolEntry {
  let entry = entries.get(taskId);
  if (!entry) {
    entry = createEntry(taskId);
    entries.set(taskId, entry);
    pruneIdle(taskId);
  }
  entry.lastActivityAt = Date.now();
  return entry;
}

export function getEntrySnapshot(taskId: string | null): ChatState {
  if (!taskId) return EMPTY_STATE;
  return entries.get(taskId)?.state ?? EMPTY_STATE;
}

export function subscribeTask(taskId: string, listener: () => void): () => void {
  const entry = ensureEntry(taskId);
  entry.listeners.add(listener);
  return () => entry.listeners.delete(listener);
}

/** 发送消息到指定任务（options 在发送时注入该轮）。返回是否被受理。 */
export function send(taskId: string, text: string, options: PoolSendOptions): boolean {
  const entry = ensureEntry(taskId);
  // 审批协调器按任务注入：「总是允许」免审集合挂在池条目上（任务级内存态）。
  const approval: ApprovalCoordinator = {
    request: (req) => entry.controller.requestApproval(req),
    isAlwaysAllowed: (toolName) => entry.alwaysAllowedTools.has(toolName),
    allowAlways: (toolName) => {
      entry.alwaysAllowedTools.add(toolName);
    },
  };
  entry.sendOptions = { ...options, approval };
  return entry.controller.send(text);
}

/** 解决指定任务当前挂起的审批（allow/always/reject）。无挂起时静默。 */
export function resolveApproval(taskId: string, decision: ApprovalDecision): void {
  entries.get(taskId)?.controller.resolveApproval(decision);
}

/** 停止指定任务的在途流式（只作用于显式给定的任务）。 */
export function stop(taskId: string): void {
  entries.get(taskId)?.controller.stop();
}

/** 销毁任务条目：停止在途流式 + 清空状态 + 删除 SQLite 数据。 */
export async function destroyTask(taskId: string): Promise<void> {
  const entry = entries.get(taskId);
  if (entry) {
    entry.controller.clear();
    entries.delete(taskId);
    for (const listener of entry.listeners) listener();
  }
  await invoke("conversation_delete", { taskId }).catch((err) =>
    console.error(`[pool] conversation_delete failed for ${taskId}:`, err),
  );
}

// ---- 流式任务集合（侧栏「进行中」标记）----
// 对齐 ZCode sessions-index：只有集合变化才通知，流式 delta 不触发侧栏重算。

let streamingSignature = "";
const streamingListeners = new Set<() => void>();

function refreshStreamingSet() {
  const ids = Array.from(entries.values())
    .filter((e) => e.state.status === "streaming")
    .map((e) => e.taskId)
    .sort();
  const signature = ids.join(",");
  if (signature !== streamingSignature) {
    streamingSignature = signature;
    for (const listener of streamingListeners) listener();
  }
}

export function subscribeStreaming(listener: () => void): () => void {
  streamingListeners.add(listener);
  return () => streamingListeners.delete(listener);
}

export function getStreamingTaskIds(): string[] {
  return streamingSignature ? streamingSignature.split(",") : [];
}
