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
import { diagnoseError } from "./errors.js";
import { runAgentTurn } from "../providers/runAgentTurn";
import type { AgentSource, ApprovalCoordinator, ApprovalDecision } from "../providers/runAgentTurn";
import { invoke } from "@tauri-apps/api/core";
import { loadProvidersConfigFromDisk } from "../../components/settings/model-provider/types";
import { readPromptCeiling, recordPromptCeiling } from "./promptCeiling";

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
  lastNotifyAt: number;
  /** 历史分页加载状态（P2-A1b）：fullyLoaded=无更早历史；total=DB 总行数 */
  historyFullyLoaded: boolean;
  historyTotal: number;
  loadingOlder: boolean;
  /** 「总是允许」免审集合（任务级内存态；重启即失效，对齐一期范围）。 */
  alwaysAllowedTools: Set<string>;
  /** 压缩事件订阅（onCompactionEvent 转发目标） */
  compactionHandlers: Set<
    (event: { type: string; manual?: boolean; error?: string; turnCount?: number }) => void
  > | null;
}

/** 空闲条目上限（LRU 驱逐，豁免流式中），对齐 LiveAgent MAX_IDLE_CONVERSATION_RUNTIME_CACHE_ENTRIES */
const MAX_IDLE_POOL_ENTRIES = 12;
/** 持久化防抖（ms）：流式期间的高频状态变化合并为一次 SQLite 写 */
const PERSIST_DEBOUNCE_MS = 300;

const entries = new Map<string, PoolEntry>();
/** 稳定的空状态常量：useSyncExternalStore 的 getSnapshot 必须返回稳定引用 */
const EMPTY_STATE: ChatState = initialState();

// ---- 序列化：TimelineEntry ↔ message/part 两表行（对齐 LiveAgent message/part 拆分）----
// 导出：会话导入（lib/import/runSessions.ts）复用同一落库格式。

export function serializeEntry(entry: TimelineEntry, seq: number) {
  const parts: { part_index: number; kind: string; payload: string }[] = [];
  let partIndex = 0;
  if (entry.text) {
    parts.push({ part_index: partIndex++, kind: "text", payload: JSON.stringify({ text: entry.text }) });
  }
  if (entry.thinking) {
    parts.push({ part_index: partIndex++, kind: "thinking", payload: JSON.stringify({ thinking: entry.thinking }) });
  }
  if (Array.isArray(entry.retryAttempts) && entry.retryAttempts.length > 0) {
    parts.push({
      part_index: partIndex++,
      kind: "retry_attempts",
      payload: JSON.stringify({ retryAttempts: entry.retryAttempts }),
    });
  }
    if (entry.role === "user" && Array.isArray(entry.attachments) && entry.attachments.length > 0) {
    parts.push({
      part_index: partIndex++,
      kind: "user_attachments",
      payload: JSON.stringify({
        attachments: entry.attachments.map((a) => ({ path: a.path, name: a.name, kind: a.kind })),
      }),
    });
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
  let userAttachments: TimelineEntry["attachments"] = undefined;
  let entryRetryAttempts: TimelineEntry["retryAttempts"] = undefined;
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
      else if (part.kind === "user_attachments") {
        userAttachments = Array.isArray(parsed.attachments) ? parsed.attachments : undefined;
      }
      else if (part.kind === "retry_attempts") {
        entryRetryAttempts = Array.isArray(parsed.retryAttempts) ? parsed.retryAttempts : undefined;
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
    // errorHint 不落库（纯派生展示字段）：水合时由原文重算，保证刷新后仍有友好提示
    errorHint: row.error ? diagnoseError(row.error) : undefined,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    thinkingStartedAt: row.thinking_started_at ?? undefined,
    thinkingDurationMs: row.thinking_duration_ms ?? undefined,
    truncatedBy: (row.truncated_by ?? undefined) as TimelineEntry["truncatedBy"],
    apiMessage: apiMessage as TimelineEntry["apiMessage"],
    ...(userAttachments && userAttachments.length > 0 ? { attachments: userAttachments } : {}),
    ...(entryRetryAttempts && entryRetryAttempts.length > 0 ? { retryAttempts: entryRetryAttempts } : {}),
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

// 流式性能（对齐 ZCode DELIVERY_PROFILES.flushWindowMs=30）：状态更新保持同步，
// 但通知走 30ms 节流窗——窗口首事件立即渲染（leading），窗内后续事件合并到窗口尾
// （trailing）一次渲染。密集 delta 下 UI 每帧最多重渲染一次。
const NOTIFY_FLUSH_MS = 30;

function notify(entry: PoolEntry) {
  // 先按微任务合并同一同步循环内的爆发（避免 zalgo），再进 30ms 节流窗。
  if (entry.notifyScheduled) return;
  entry.notifyScheduled = true;
  queueMicrotask(() => {
    entry.notifyScheduled = false;
    const now = Date.now();
    const elapsed = now - entry.lastNotifyAt;
    if (elapsed >= NOTIFY_FLUSH_MS) {
      entry.lastNotifyAt = now;
      flushNotify(entry);
      return;
    }
    entry.notifyScheduled = true;
    window.setTimeout(() => {
      entry.notifyScheduled = false;
      entry.lastNotifyAt = Date.now();
      flushNotify(entry);
    }, NOTIFY_FLUSH_MS - elapsed);
  });
}

function flushNotify(entry: PoolEntry) {
  for (const listener of entry.listeners) listener();
  refreshStreamingSet();
  refreshPendingApprovalSet();
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
    lastNotifyAt: 0,
    sendOptions: null,
    alwaysAllowedTools: new Set<string>(),
    compactionHandlers: null,
    historyFullyLoaded: false,
    historyTotal: 0,
    loadingOlder: false,
  };
  entry.controller = createConversationController({
    taskId,
    // 检查点轮边界（对齐 LiveAgent checkpoint_begin_turn）：发送瞬间先落一条
    // turn 记录，零文件轮也是合法回退点。失败不阻断发送（后端写日志）。
    onTurnBegin: (turnId: string) => {
      invoke("checkpoint_begin_turn", { conversationId: taskId, turnId }).catch((err) =>
        console.warn("[pool] checkpoint_begin_turn failed:", err),
      );
    },
    onCompactionEvent: (event: { type: string; manual?: boolean; error?: string; turnCount?: number }) => {
      entry.compactionHandlers?.forEach((handler) => {
        try {
          handler(event);
        } catch (err) {
          console.error("[pool] compaction handler failed:", err);
        }
      });
    },
    // Fail-Fast 经验上限（2026-10-05）：大 prompt 上的连接/上下文类失败会被 controller
    // 上报，这里落到 kv（只收紧）；下次发送的压缩水位线据此下调，更早触发压缩。
    getPromptCeiling: (modelKey) => readPromptCeiling(modelKey),
    onPromptCeilingExceeded: (modelKey, failedPromptTokens) =>
      recordPromptCeiling(modelKey, failedPromptTokens),
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
  // 异步水合：从 SQLite 分页载入历史（P2-A1b：默认最新 500 条——超长会话不出
  // 「加载更早」按钮时行为与全量一致；幂等——已有消息时保留内存态）。
  void (async () => {
    try {
      const page = await invoke<{
        rows: {
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
        }[];
        total: number;
        has_more: boolean;
      }>("conversation_load_page", { taskId, limit: 500 });
      if (page.rows.length > 0 && entry.state.messages.length === 0) {
        const messages = page.rows.map(deserializeRow);
        const restored = restoreState(messages);
        entry.state = restored;
        entry.historyTotal = page.total;
        entry.historyFullyLoaded = !page.has_more;
      } else if (page.rows.length === 0) {
        entry.historyFullyLoaded = true;
        entry.historyTotal = page.total;
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

/**
 * 加载更早的历史（P2-A1b）：把当前窗口之前的最多 500 条 prepend 进时间线。
 * 返回本次新加载的条数（0 = 已全部加载/无更早）。加载后发送上下文自然包含更全历史。
 */
export async function loadOlderMessages(taskId: string): Promise<number> {
  const entry = entries.get(taskId);
  if (!entry || entry.loadingOlder) return 0;
  const oldestSeq = entry.state.messages.reduce(
    (min, m) => ((m as { seq?: number }).seq !== undefined ? Math.min(min, (m as { seq?: number }).seq as number) : min),
    Number.POSITIVE_INFINITY,
  );
  entry.loadingOlder = true;
  try {
    const page = await invoke<{
      rows: {
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
      }[];
      total: number;
      has_more: boolean;
    }>("conversation_load_page", {
      taskId,
      limit: 500,
      beforeSeq: Number.isFinite(oldestSeq) ? oldestSeq : undefined,
    });
    if (page.rows.length === 0) {
      entry.historyFullyLoaded = true;
      notify(entry);
      return 0;
    }
    const older = page.rows.map(deserializeRow);
    // 前置的更早消息也要盖进计数器：其序号虽然按创建序必然更小，但「加载更早」
    // 发生在 restoreState 之后，若计数器曾被错误地按 length 恢复（或未来引入
    // 非单调 id），新消息会与前置历史撞 id → conversation_sync 整体被拒。
    let maxOlder = 0;
    for (const m of older) {
      const match = typeof m.id === "string" ? /^m(\d+)$/.exec(m.id) : null;
      if (match) maxOlder = Math.max(maxOlder, Number(match[1]) + 1);
    }
    const curSeq =
      typeof entry.state.nextMessageSeq === "number"
        ? entry.state.nextMessageSeq
        : entry.state.messages.length;
    entry.state = {
      ...entry.state,
      messages: [...older, ...entry.state.messages],
      ...(maxOlder > curSeq ? { nextMessageSeq: maxOlder } : {}),
    };
    entry.historyTotal = page.total;
    entry.historyFullyLoaded = !page.has_more;
    notify(entry);
    return older.length;
  } catch (err) {
    console.error(`[pool] loadOlderMessages failed for ${taskId}:`, err);
    return 0;
  } finally {
    entry.loadingOlder = false;
  }
}

/** 会话历史加载状态（「加载更早消息」按钮的渲染依据）。 */
export function getHistoryLoadState(taskId: string | null): {
  fullyLoaded: boolean;
  total: number;
  loading: boolean;
  loadedCount: number;
} {
  if (!taskId) return { fullyLoaded: true, total: 0, loading: false, loadedCount: 0 };
  const entry = entries.get(taskId);
  if (!entry) return { fullyLoaded: true, total: 0, loading: false, loadedCount: 0 };
  return {
    fullyLoaded: entry.historyFullyLoaded,
    total: entry.historyTotal,
    loading: entry.loadingOlder,
    loadedCount: entry.state.messages.length,
  };
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
  injectOptions(entry, options);
  return entry.controller.send(text);
}

/** 编辑重发：截断锚点 user 消息及其后旧分支，替换后作为全新一轮重跑（对齐 LiveAgent）。 */
export function editResend(
  taskId: string,
  anchorMessageId: string,
  text: string,
  options: PoolSendOptions,
): boolean {
  const entry = entries.get(taskId);
  // 锚点不存在（任务未水合/已截断）时拒绝，原历史保持不变。
  if (!entry || !entry.state.messages.some((m) => m.id === anchorMessageId && m.role === "user")) {
    return false;
  }
  injectOptions(entry, options);
  return entry.controller.editResend(anchorMessageId, text);
}

function injectOptions(entry: PoolEntry, options: PoolSendOptions): void {
  // 审批协调器按任务注入：「总是允许」免审集合挂在池条目上（任务级内存态）。
  const approval: ApprovalCoordinator = {
    request: (req) => entry.controller.requestApproval(req),
    isAlwaysAllowed: (toolName) => entry.alwaysAllowedTools.has(toolName),
    allowAlways: (toolName) => {
      entry.alwaysAllowedTools.add(toolName);
    },
  };
  entry.sendOptions = { ...options, approval };
}

/** 解决指定任务当前挂起的审批（allow/always/reject）。无挂起时静默。 */
export function resolveApproval(
  taskId: string,
  decision: ApprovalDecision | Record<string, unknown>,
): void {
  // 结构化回答对象（ask_user 提问卡）与字符串决策同样经 controller.resolve 透传
  entries.get(taskId)?.controller.resolveApproval(decision as never);
}

/** P2-F1：撤回一条排队中的 steering 消息。 */
export function removeSteerMessage(taskId: string, index: number): void {
  entries.get(taskId)?.controller.removeSteerMessage(index);
}

/** 手动压缩指定任务的历史（controller.compactNow；忙时返回 false）。 */
export function compactConversation(taskId: string): boolean {
  return entries.get(taskId)?.controller.compactNow() ?? false;
}

/** 订阅压缩事件（started/done/failed/skipped；供 UI 压缩带与 toast）。 */
export function onCompactionEvent(
  taskId: string,
  handler: (event: { type: string; manual?: boolean; error?: string; turnCount?: number }) => void,
): () => void {
  const entry = entries.get(taskId);
  if (!entry) return () => {};
  // 事件经 controller deps 的 onCompactionEvent 转发到 entry.compactionHandlers
  entry.compactionHandlers = entry.compactionHandlers ?? new Set();
  entry.compactionHandlers.add(handler);
  return () => entry.compactionHandlers?.delete(handler);
}

/** 清空指定任务的时间线（controller.clear：中止在途轮 + 重置为空态；持久化由防抖 sync 落库）。 */
export function clearConversation(taskId: string): void {
  const entry = entries.get(taskId);
  if (!entry) return;
  entry.controller.clear();
  schedulePersist(entry);
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
    // 终态检测：上一轮在流式、现在不在的任务 = 刚跑到终态（完成/失败/停止）。
    // 通知编排（E1）在 App 层订阅此事件——池只负责「谁刚结束」这一事实。
    const before = new Set(streamingSignature ? streamingSignature.split(",") : []);
    for (const id of before) {
      if (ids.includes(id)) continue;
      const entry = entries.get(id);
      if (!entry) continue;
      const outcome =
        entry.state.status === "error"
          ? "error"
          : entry.state.messages.some((m) => m.status === "stopped")
            ? "stopped"
            : "done";
      const lastAssistant = [...entry.state.messages].reverse().find((m) => m.role === "assistant");
      const pending = entry.state.pendingApproval;
      const terminal = {
        taskId: id,
        outcome: outcome as "done" | "error" | "stopped",
        lastAssistantText: lastAssistant?.text,
        error: entry.state.error,
        /** 审批挂起中（不是真完成——用户决策后还会有后续） */
        awaitingDecision: pending !== null && pending !== undefined,
      };
      for (const handler of terminalListeners) {
        try {
          handler(terminal);
        } catch (err) {
          console.error("[pool] terminal handler failed:", err);
        }
      }
      // 聊天后记忆抽取（P1-8，对齐 LA：每轮成功结束后 fire-and-forget，
      // 历史已持久化【conversation_sync 在状态更新时防抖落库】；失败不阻塞聊天）。
      if (outcome === "done" && !terminal.awaitingDecision) {
        void maybeExtractMemory(id, entry);
      }
    }
    streamingSignature = signature;
    for (const listener of streamingListeners) listener();
  }
}

/**
 * 聊天后记忆抽取（P1-8）：终态 done 时由 refreshStreamingSet 触发。
 * 模型解析（P2 尾巴 #6）：优先「记忆整理」独立模型（记忆设置抽屉配置，与
 * Organizer 编排批同源共享 resolveIndependentMemoryModelDeps）；未配置回落
 * 当轮 sendOptions 的主模型凭证。faux 测试源跳过。
 */
async function maybeExtractMemory(taskId: string, entry: PoolEntry): Promise<void> {
  try {
    const options = entry.sendOptions;
    if (!options || options.source === "faux") return; // 测试模型不产记忆
    const config = options.config;
    const fallbackConfigReady = Boolean(config?.apiKey && config?.modelId);
    // 独立模型优先（供应商不存在/未配置 → null → 回落主模型）
    let independent: Awaited<
      ReturnType<typeof import("../memory/modelResolution").resolveIndependentMemoryModelDeps>
    > | null = null;
    try {
      const { useHubSettings } = await import("../../store/hubSettingsStore");

      const memory = useHubSettings.getState().settings.memory;
      const providers = await loadProvidersConfigFromDisk();
      independent = await import("../memory/modelResolution").then((m) =>
        m.resolveIndependentMemoryModelDeps(memory, providers),
      );
    } catch (err) {
      // 独立模型解析失败（如 API Key 为空）：如实上抛语义太重会打断聊天终态流，
      // 记错误后回落主模型；App 层 organizer 路径同错误会直接抛（那里的失败必须可见）。
      console.warn("[pool] independent memory model resolution failed, falling back:", err);
    }
    if (!independent && !fallbackConfigReady) return;
    const { getStreamFnForApi } = await import("../providers/runAgentTurn");
    const { requestMemoryExtraction } = await import("./memory/extractionController");
    const deps = independent
      ? independent
      : await (async () => {
          const { buildModel } = await import("../providers/modelFactory");
          const model = buildModel(config);
          return {
            model,
            stream: await getStreamFnForApi(model.api),
            api: model.api,
            label: model.provider || "openai-completions",
            getApiKey: () => config!.apiKey,
            thinkingLevel: undefined,
          };
        })();
    requestMemoryExtraction({
      taskId,
      sessionId: taskId,
      workspaceRoot: options.workspaceRoot,
      messages: entry.state.messages,
      model: deps,
    });
  } catch (err) {
    console.warn("[pool] memory extraction dispatch failed (non-blocking):", err);
  }
}

/** 任务终态事件（刚离开流式集合的任务）。 */
export interface TaskTerminalEvent {  taskId: string;
  outcome: "done" | "error" | "stopped";
  lastAssistantText?: string;
  error?: string;
  /** 审批挂起中（不是真完成——用户决策后还会有后续） */
  awaitingDecision: boolean;
}
const terminalListeners = new Set<(event: TaskTerminalEvent) => void>();

export function subscribeTaskTerminal(listener: (event: TaskTerminalEvent) => void): () => void {
  terminalListeners.add(listener);
  return () => terminalListeners.delete(listener);
}

// ---- 挂起审批集合（侧栏红点；对齐 ZCode TaskInteractionBadge 的最小可用版）----
// 与流式集合同款签名通知：只有集合变化才触发侧栏重算。

let pendingApprovalSignature = "";
const pendingApprovalListeners = new Set<() => void>();

function refreshPendingApprovalSet() {
  const ids = Array.from(entries.values())
    .filter((e) => e.state.pendingApproval !== null && e.state.pendingApproval !== undefined)
    .map((e) => e.taskId)
    .sort();
  const signature = ids.join(",");
  if (signature !== pendingApprovalSignature) {
    pendingApprovalSignature = signature;
    for (const listener of pendingApprovalListeners) listener();
  }
}

export function subscribePendingApprovals(listener: () => void): () => void {
  pendingApprovalListeners.add(listener);
  return () => pendingApprovalListeners.delete(listener);
}

export function getPendingApprovalTaskIds(): string[] {
  return pendingApprovalSignature ? pendingApprovalSignature.split(",") : [];
}

export function subscribeStreaming(listener: () => void): () => void {
  streamingListeners.add(listener);
  return () => streamingListeners.delete(listener);
}

export function getStreamingTaskIds(): string[] {
  return streamingSignature ? streamingSignature.split(",") : [];
}
