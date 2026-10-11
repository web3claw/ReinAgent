/**
 * protocol —— 手机远控 WS 协议类型（remote_server.rs ServerMessage/ClientMessage 同形，
 * serde tag=op + rename_all=camelCase）。数据契约逐字对齐 ZCode WebRemoteControlWorkspaceListResult。
 */

// ---- ZCode shared web-remote-control.ts 契约子集（本地会话语义适配） ----

export type WebRemoteControlTaskDisplayStatus = "idle" | "running" | "completed" | "error";

export interface WebRemoteControlTaskTarget {
  taskId: string;
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceLabel: string;
  workspaceKind: "local";
  createdAt: number;
  updatedAt: number;
  unreadAt?: number;
  displayStatus?: WebRemoteControlTaskDisplayStatus;
  pinned?: boolean;
  archived?: boolean;
}

export interface WebRemoteControlWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  label: string;
  kind: "local";
  workspacePurpose: "project" | "conversation";
}

export interface WebRemoteControlWorkspaceListResult {
  workspaces: WebRemoteControlWorkspaceTarget[];
  tasks?: WebRemoteControlTaskTarget[];
  activeWorkspaceKey?: string;
  activeTaskId?: string;
}

/** ZCode WebRemoteControlWorkspaceSwitcherApi（手机端消费面；远程 SSH 工作区分支裁剪）。 */
export interface WebRemoteControlWorkspaceSwitcherApi {
  listWorkspaces(): Promise<WebRemoteControlWorkspaceListResult>;
  onWorkspaceListUpdated?(listener: (result: WebRemoteControlWorkspaceListResult) => void): () => void;
  switchWorkspace(workspaceKey: string, options?: { taskId?: string }): Promise<void>;
  markTaskRead?(task: WebRemoteControlTaskTarget): Promise<void>;
  updateMobileViewState?(workspaceKey: string, taskId?: string): Promise<void>;
  startDraft?(workspaceKey: string): Promise<void>;
}

export function resolveWebRemoteControlWorkspaceKey(target: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

// ---- 时间线行（桌面 serializeEntry 同形） ----

export interface TimelineRowPart {
  part_index: number;
  kind: string;
  payload: string;
}

export interface TimelineRow {
  msg_id: string;
  seq: number;
  role: "user" | "assistant" | "tool";
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
  parts: TimelineRowPart[];
}

/** 挂起审批/提问/计划（桌面 PendingApproval 原样；args.kind 区分三态）。 */
export interface PendingApprovalPayload {
  toolName: string;
  toolCallId: string;
  args?: { kind?: string; questions?: unknown[]; plan?: string; allowedPrompts?: unknown[] } & Record<string, unknown>;
}

/** 上下文容量快照（桌面 buildContextUsageData 产物的可序列化子集）。 */
export interface RemoteContextUsage {
  used: number;
  total: number;
  percent: number;
  hitRate?: number;
  categories: { key: string; labelKey: string; percent: number; chars: number }[];
}

export interface TaskStatePayload {
  taskId: string;
  revision: number;
  messages: TimelineRow[];
  running: boolean;
  queuedMessages?: string[] | null;
  pendingApproval?: PendingApprovalPayload | null;
  contextUsage?: RemoteContextUsage | null;
}

export interface DesktopStatePayload {
  activeTaskId: string | null;
  activeWorkspaceKey: string | null;
}

// ---- 服务器帧 ----

export type ServerMessage =
  | { op: "hello"; ok: boolean; serverTime: number }
  | { op: "result"; reqId: string; ok: boolean; payload?: unknown; error?: string }
  | { op: "workspaceList"; payload: WebRemoteControlWorkspaceListResult }
  | {
      op: "state";
      taskId: string;
      revision: number;
      messages: TimelineRow[];
      running: boolean;
      queuedMessages?: string[] | null;
      pendingApproval?: PendingApprovalPayload | null;
      contextUsage?: RemoteContextUsage | null;
    }
  | { op: "desktopState"; activeTaskId: string | null; activeWorkspaceKey: string | null }
  | { op: "accepted"; reqId: string }
  | { op: "error"; reqId: string; message: string };

// ---- 客户端帧 ----

export interface RemoteAttachmentRef {
  path: string;
  name: string;
  kind: "image" | "file";
}

export type ClientMessage =
  | { op: "hello" }
  | { op: "list_workspaces"; reqId: string }
  | { op: "subscribe"; reqId: string; taskId: string }
  | { op: "unsubscribe"; reqId: string; taskId: string }
  | {
      op: "send";
      reqId: string;
      taskId: string | null;
      text: string;
      attachments: RemoteAttachmentRef[];
    }
  | { op: "approve"; reqId: string; taskId: string; decision: unknown }
  | { op: "stop"; reqId: string; taskId: string }
  | { op: "switch_task"; reqId: string; taskId: string }
  | { op: "start_draft"; reqId: string; workspaceKey: string }
  | { op: "mark_task_read"; reqId: string; taskId: string }
  | { op: "update_mobile_view_state"; reqId: string; workspaceKey: string; taskId?: string | null }
  | { op: "remove_queued"; reqId: string; taskId: string; index: number }
  | { op: "list_models"; reqId: string }
  | { op: "set_model"; reqId: string; taskId: string | null; providerId: string; modelId: string }
  | { op: "get_task_options"; reqId: string; taskId: string | null }
  | { op: "set_approval_mode"; reqId: string; taskId: string | null; mode: string }
  | { op: "set_thinking_level"; reqId: string; taskId: string | null; level: string };

// ---- 模型选择器数据 ----

export interface RemoteModelInfo {
  id: string;
  name: string;
  contextWindow: number | null;
  supportsImage: boolean | null;
}

export interface RemoteProviderModels {
  id: string;
  name: string;
  models: RemoteModelInfo[];
}

export interface TaskOptions {
  taskId: string | null;
  approvalMode: string;
  thinkingLevel: string;
  providerId: string | null;
  modelId: string | null;
}

// ---- 连接失败（ZCode WebRemoteControlFailureReason 子集） ----

export type WebRemoteControlFailureReason =
  | "session-not-found"
  | "session-expired"
  | "desktop-disconnected"
  | "invalid-mobile-connection"
  | "relay-unavailable"
  | "unexpected-error";

export interface WebRemoteControlFailure {
  reason: WebRemoteControlFailureReason;
  message?: string;
}
