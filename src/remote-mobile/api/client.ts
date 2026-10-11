/**
 * client —— 手机远控 WS 客户端（reqId Promise 匹配 + 事件分发 + 自动重连）。
 *
 * 连接状态机对齐 ZCode WebRemoteControlTerminalTransportState（loading/reconnect 文案数据源）：
 * connecting → paired；断开 → reconnecting（保留页面与输入态，自动恢复）；
 * 鉴权失败/会话失效 → failed（错误页）。
 */
import type {
  ClientMessage,
  RemoteAttachmentRef,
  RemoteProviderModels,
  ServerMessage,
  TaskOptions,
  TaskStatePayload,
  WebRemoteControlFailure,
  WebRemoteControlWorkspaceListResult,
} from "./protocol";

export type RemoteConnectionState =
  | "connecting"
  | "authenticating"
  | "paired"
  | "reconnecting"
  | "suspended"
  | "failed";

interface RemoteStoreSnapshot {
  connection: RemoteConnectionState;
  failure: WebRemoteControlFailure | null;
  workspaceList: WebRemoteControlWorkspaceListResult;
  desktopState: { activeTaskId: string | null; activeWorkspaceKey: string | null };
  taskStates: Record<string, TaskStatePayload>;
  /** 已订阅并收到过状态的任务 id（按 revision 判稳） */
  models: RemoteProviderModels[] | null;
  serverTimeOffsetMs: number;
}

const initialState: RemoteStoreSnapshot = {
  connection: "connecting",
  failure: null,
  workspaceList: { workspaces: [], tasks: [] },
  desktopState: { activeTaskId: null, activeWorkspaceKey: null },
  taskStates: {},
  models: null,
  serverTimeOffsetMs: 0,
};

let snapshot: RemoteStoreSnapshot = initialState;
const listeners = new Set<() => void>();
let socket: WebSocket | null = null;
let reqSeq = 0;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>();
const workspaceListListeners = new Set<(result: WebRemoteControlWorkspaceListResult) => void>();
let reconnectAttempts = 0;
let reconnectTimer: number | null = null;
let suspended = false;
/** URL ?token=（replaceState 前抓取；刷新后 Cookie 兜底） */
let authToken = "";

export function initAuthToken(): string {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") ?? "";
  if (token) {
    authToken = token;
    params.delete("token");
    const next = params.toString();
    window.history.replaceState(
      null,
      "",
      window.location.pathname + (next ? `?${next}` : "") + window.location.hash,
    );
  }
  return authToken;
}

function update(patch: Partial<RemoteStoreSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

export function subscribeRemote(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRemoteSnapshot(): RemoteStoreSnapshot {
  return snapshot;
}

function notifyWorkspaceList(result: WebRemoteControlWorkspaceListResult): void {
  for (const listener of workspaceListListeners) listener(result);
}

// ---------------- 连接 ----------------

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const tokenQuery = authToken ? `?token=${encodeURIComponent(authToken)}` : "";
  return `${proto}//${window.location.host}/ws${tokenQuery}`;
}

function send(frame: ClientMessage): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(frame));
  }
}

function nextReqId(): string {
  reqSeq += 1;
  return `req-${Date.now().toString(36)}-${reqSeq}`;
}

const REQUEST_TIMEOUT_MS = 20_000;

function request(op: ClientMessage & { reqId: string }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const reqId = op.reqId;
    const timer = window.setTimeout(() => {
      pending.delete(reqId);
      reject(new Error(`request timeout: ${op.op}`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(reqId, { resolve, reject, timer });
    send(op);
  });
}

function rejectAllPending(message: string): void {
  for (const [, entry] of pending) {
    window.clearTimeout(entry.timer);
    entry.reject(new Error(message));
  }
  pending.clear();
}

function handleServerMessage(raw: MessageEvent): void {
  let msg: ServerMessage;
  try {
    msg = JSON.parse(typeof raw.data === "string" ? raw.data : "") as ServerMessage;
  } catch {
    return;
  }
  switch (msg.op) {
    case "hello": {
      reconnectAttempts = 0;
      update({
        connection: suspended ? snapshot.connection : "paired",
        failure: null,
        serverTimeOffsetMs: msg.serverTime - Date.now(),
      });
      // hello 后立刻拉一次工作区快照 + 模型列表
      void request({ op: "list_workspaces", reqId: nextReqId() }).catch(() => undefined);
      void request({ op: "list_models", reqId: nextReqId() })
        .then((payload) => {
          const providers = (payload as { providers?: RemoteProviderModels[] })?.providers ?? [];
          update({ models: providers });
        })
        .catch(() => undefined);
      break;
    }
    case "result": {
      const entry = pending.get(msg.reqId);
      if (entry) {
        pending.delete(msg.reqId);
        window.clearTimeout(entry.timer);
        if (msg.ok) entry.resolve(msg.payload ?? {});
        else entry.reject(new Error(msg.error || "request failed"));
      }
      break;
    }
    case "workspaceList": {
      update({ workspaceList: msg.payload });
      notifyWorkspaceList(msg.payload);
      // workspaceList 自带活动任务/工作区——同步 desktopState（新连接错过独立
      // desktopState 推送时的兜底；两帧内容一致，幂等）。
      update({
        desktopState: {
          activeTaskId: msg.payload.activeTaskId ?? null,
          activeWorkspaceKey: msg.payload.activeWorkspaceKey ?? null,
        },
      });
      break;
    }
    case "state": {
      const next = { ...snapshot.taskStates };
      next[msg.taskId] = {
        taskId: msg.taskId,
        revision: msg.revision,
        messages: msg.messages,
        running: msg.running,
        queuedMessages: msg.queuedMessages ?? null,
        pendingApproval: msg.pendingApproval ?? null,
        contextUsage: msg.contextUsage ?? null,
      };
      update({ taskStates: next });
      break;
    }
    case "desktopState": {
      update({
        desktopState: { activeTaskId: msg.activeTaskId, activeWorkspaceKey: msg.activeWorkspaceKey },
      });
      break;
    }
    case "accepted":
    case "error":
    default:
      break;
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  reconnectAttempts += 1;
  const delay = Math.min(800 * 2 ** Math.min(reconnectAttempts, 5), 15_000);
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect(): void {
  if (socket) {
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.onopen = null;
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  }
  if (snapshot.connection !== "reconnecting" && reconnectAttempts > 0) {
    update({ connection: "reconnecting" });
  }
  try {
    socket = new WebSocket(wsUrl());
  } catch (err) {
    update({
      connection: "failed",
      failure: { reason: "relay-unavailable", message: err instanceof Error ? err.message : String(err) },
    });
    return;
  }
  socket.onopen = () => {
    update({ connection: suspended ? "suspended" : reconnectAttempts > 0 ? "reconnecting" : "authenticating" });
    send({ op: "hello" });
    // 重连后恢复订阅（桌面重置了订阅集合）
    for (const taskId of Object.keys(snapshot.taskStates)) {
      send({ op: "subscribe", reqId: nextReqId(), taskId });
    }
  };
  socket.onmessage = handleServerMessage;
  socket.onerror = () => {
    /* close 事件统一处理 */
  };
  socket.onclose = (event) => {
    socket = null;
    rejectAllPending("connection closed");
    // 鉴权/会话类失败直接进错误页（对齐 ZCode resolveWebRemoteControlFailureReasonFromCloseCode 语义）
    const reason = event.reason as WebRemoteControlFailure["reason"] | "";
    if (reason === "invalid-mobile-connection" || event.code === 4401 || event.code === 1008) {
      update({
        connection: "failed",
        failure: { reason: reason || "invalid-mobile-connection", message: event.reason || undefined },
      });
      return;
    }
    if (snapshot.connection !== "failed") {
      update({ connection: suspended ? "suspended" : "reconnecting" });
      scheduleReconnect();
    }
  };
}

document.addEventListener("visibilitychange", () => {
  suspended = document.visibilityState === "hidden";
  if (!suspended && socket && socket.readyState === WebSocket.OPEN) {
    update({ connection: "paired" });
  } else if (!suspended) {
    // 回前台立刻尝试恢复（对齐 ZCode recoverVisibleSession 语义）
    if (reconnectTimer === null) scheduleReconnect();
  }
});

export function connectRemote(): void {
  connect();
}

/** 诊断句柄（远控页调试用）：socket 状态、订阅集合、最近帧计数。 */
export function __diag(): Record<string, unknown> {
  return {
    socketState: socket?.readyState ?? "null",
    url: socket?.url ?? null,
    reqSeq,
    pendingCount: pending.size,
    taskStateKeys: Object.keys(snapshot.taskStates),
    taskStateRows: Object.fromEntries(
      Object.entries(snapshot.taskStates).map(([id, st]) => [id.slice(-8), st.messages.length]),
    ),
    connection: snapshot.connection,
  };
}

export function connectionAlive(): boolean {
  return socket !== null && socket.readyState === WebSocket.OPEN;
}

// ---------------- Switcher API（ZCode WebRemoteControlWorkspaceSwitcherApi 同构） ----------------

export const remoteSwitcher = {
  async listWorkspaces(): Promise<WebRemoteControlWorkspaceListResult> {
    const payload = (await request({ op: "list_workspaces", reqId: nextReqId() })) as
      | WebRemoteControlWorkspaceListResult
      | undefined;
    if (payload && (payload.workspaces || payload.tasks)) return payload;
    return getRemoteSnapshot().workspaceList;
  },
  onWorkspaceListUpdated(listener: (result: WebRemoteControlWorkspaceListResult) => void): () => void {
    workspaceListListeners.add(listener);
    return () => workspaceListListeners.delete(listener);
  },
  async switchWorkspace(workspaceKey: string, options?: { taskId?: string }): Promise<void> {
    // 本仓无跨设备多工作区 bridge 语义：切任务即桌面 setActiveTaskId（workspaceKey 仅做校验）
    if (!options?.taskId) {
      await request({ op: "update_mobile_view_state", reqId: nextReqId(), workspaceKey });
      return;
    }
    await request({ op: "switch_task", reqId: nextReqId(), taskId: options.taskId });
  },
  async markTaskRead(task: { taskId: string }): Promise<void> {
    await request({ op: "mark_task_read", reqId: nextReqId(), taskId: task.taskId });
  },
  async updateMobileViewState(workspaceKey: string, taskId?: string): Promise<void> {
    await request({ op: "update_mobile_view_state", reqId: nextReqId(), workspaceKey, taskId: taskId ?? null });
  },
  async startDraft(workspaceKey: string): Promise<void> {
    await request({ op: "start_draft", reqId: nextReqId(), workspaceKey });
  },
};

// ---------------- 会话操作 ----------------

export function subscribeTask(taskId: string): void {
  send({ op: "subscribe", reqId: nextReqId(), taskId });
}

export function unsubscribeTask(taskId: string): void {
  send({ op: "unsubscribe", reqId: nextReqId(), taskId });
}

export async function sendMessage(args: {
  taskId: string | null;
  text: string;
  attachments: RemoteAttachmentRef[];
}): Promise<boolean> {
  if (!args.taskId && !args.text.trim() && args.attachments.length === 0) return false;
  // send 无 Result 应答（fire-and-forget）；受理与否由后续 state 推送体现
  send({ op: "send", reqId: nextReqId(), taskId: args.taskId, text: args.text, attachments: args.attachments });
  return true;
}

export async function stopTask(taskId: string): Promise<void> {
  send({ op: "stop", reqId: nextReqId(), taskId });
}

export async function resolveApproval(taskId: string, decision: unknown): Promise<void> {
  send({ op: "approve", reqId: nextReqId(), taskId, decision });
}

export async function removeQueuedMessage(taskId: string, index: number): Promise<void> {
  await request({ op: "remove_queued", reqId: nextReqId(), taskId, index });
}

export async function fetchTaskOptions(taskId: string | null): Promise<TaskOptions> {
  const payload = (await request({ op: "get_task_options", reqId: nextReqId(), taskId })) as TaskOptions;
  return payload;
}

export async function setTaskModel(args: {
  taskId: string | null;
  providerId: string;
  modelId: string;
}): Promise<void> {
  await request({ op: "set_model", reqId: nextReqId(), ...args });
}

export async function setApprovalMode(args: {
  taskId: string | null;
  mode: string;
}): Promise<void> {
  await request({ op: "set_approval_mode", reqId: nextReqId(), ...args });
}

export async function setThinkingLevel(args: {
  taskId: string | null;
  level: string;
}): Promise<void> {
  await request({ op: "set_thinking_level", reqId: nextReqId(), ...args });
}

// ---------------- 附件上传 ----------------

export async function uploadAttachments(args: {
  taskId: string | null;
  files: File[];
}): Promise<RemoteAttachmentRef[]> {
  const form = new FormData();
  for (const file of args.files) {
    form.append("files", file, file.name);
  }
  const tokenQuery = authToken ? `token=${encodeURIComponent(authToken)}&` : "";
  const taskQuery = args.taskId ? `taskId=${encodeURIComponent(args.taskId)}` : "";
  const response = await fetch(`/api/attachment?${tokenQuery}${taskQuery}`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`upload failed: HTTP ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ""}`);
  }
  const uploaded = (await response.json()) as { path: string; name: string; kind: string }[];
  return uploaded.map((u) => ({
    path: u.path,
    name: u.name,
    kind: u.kind === "image" ? "image" : "file",
  }));
}
