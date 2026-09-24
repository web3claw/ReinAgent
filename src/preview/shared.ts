/**
 * shared.ts —— @zcode/shared 的宿主侧 stub（仅覆盖预览面板闭包实际消费的符号）。
 * 类型形状从 ZCode packages/shared/src 原样提取；运行时函数优先原样复制（uuid/log-format/
 * lineChangeStat/media-preview/tool-identity/memoryDiagnostics 见 ./shared-src/*）。
 * 铁律：这里不允许编造任何业务数据——只是类型与纯函数。
 */

// ---- re-export 自包含的实现文件 ----
export { createUuid } from "./shared-src/uuid";
export { formatLogPrefix } from "./shared-src/log-format";
export { computeLineChangeStat, type LineChangeStat } from "./shared-src/lineChangeStat";
export {
  getMediaPreviewFormat,
  MEDIA_PREVIEW_FORMATS,
  type MediaPreviewKind,
  type MediaPreviewFormat,
} from "./shared-src/media-preview";
export {
  normalizeZCodeToolName,
  getZCodeToolFamilyForName,
  isZCodeToolFamily,
  isZCodeFileContentWriteToolName,
  isTodoPlanToolName,
  type ZCodeKnownToolName,
  type ZCodeToolFamily,
} from "./shared-src/tool-identity";
export {
  MEMORY_SAMPLE_INTERVAL_MS,
  createMemoryDiagnosticsRegistry,
  createMemorySampleWriteGate,
  formatMemorySampleLine,
  type MemoryDiagnosticsRegistry,
  type MemorySample,
} from "./shared-src/memoryDiagnostics";

// ---- 协议类型（提取自 shared/protocol.ts）----

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  /** 旧远端服务端可能不返回；调用方应按 false 处理。 */
  isSymbolicLink?: boolean;
}

export interface FileTextSlice {
  path: string;
  content: string;
  offset: number;
  bytesRead: number;
  totalBytes: number;
  truncated: boolean;
  isBinary: boolean;
}

export interface FileWatchEvent {
  /** 发生变更的目录路径 */
  dirPath: string;
  /** 能由底层 watcher 确认时返回发生变化的完整路径；否则省略，调用方应保守刷新。 */
  changedPath?: string;
}

export interface FileBinaryPreview {
  path: string;
  dataBase64: string;
  totalBytes: number;
}

export interface FileMediaPreview {
  path: string;
  mediaType: string;
  dataBase64: string;
  totalBytes: number;
}

// ---- 渲染进程堆采样（shared 侧类型子集）----

export interface RendererHeapSample {
  heapUsedMb?: number;
  heapTotalMb?: number;
  sampledAt?: string;
  [key: string]: unknown;
}

// ---- 媒体预览服务（闭包消费子集；宿主未实现，运行时为 undefined）----

import { type MediaPreviewKind } from "./shared-src/media-preview";

export interface MediaPreviewIdRef {
  previewId: string;
  url?: string;
  dataBase64?: string;
  mediaType?: string;
  [key: string]: unknown;
}

export interface IMediaPreviewService {
  prepare: (input: {
    path: string;
    expectedKind?: MediaPreviewKind;
    kind?: MediaPreviewKind;
  }) => Promise<MediaPreviewIdRef>;
  release: (input: { previewId: string }) => Promise<void>;
  refreshPlaybackUrl?: (input: { previewId: string }) => Promise<{ url?: string }>;
  [key: string]: unknown;
}

// ---- 平台（提取自 shared/platform.ts 的闭包消费子集）----

export type RemoteTarget = {
  /** 远端会话标识（宿主当前不支持远端 workspace，仅保留类型兼容）。 */
  sessionId?: string;
  [key: string]: unknown;
};

export interface EditorInfo {
  id: string;
  name: string;
  /** 打开文件/目录的命令行模板等宿主相关信息（stub 可为空）。 */
  [key: string]: unknown;
}

export interface OpenInEditorRemoteTarget {
  [key: string]: unknown;
}

export function createOpenInEditorRemoteTarget(
  target?: RemoteTarget | null,
): OpenInEditorRemoteTarget | undefined {
  if (!target) return undefined;
  return { ...target };
}

/**
 * 平台服务（宿主最小实现面）：闭包实际只消费 selectDirectory / connectRemote /
 * openInEditor / getInstalledEditors。宿主（Tauri）当前不支持远端 workspace，
 * connectRemote 返回 undefined；openInEditor 由 tauri opener 插件承接（见 usePlatform 适配层）。
 */
export interface PlatformOpenInEditorResult {
  success: boolean;
  error?: string;
}

export interface IPlatformService {
  selectDirectory: (options?: { directory?: boolean }) => Promise<string | null>;
  connectRemote: (
    options: RemoteTarget,
    requestId?: string,
  ) => Promise<PlatformOpenInEditorResult>;
  openInEditor: (
    editorIdOrInput: string | { path: string; editorId?: string },
    openPath?: string,
    options?: { pathKind?: string; remoteTarget?: unknown; workspaceIdentity?: string },
  ) => Promise<PlatformOpenInEditorResult>;
  openInFileManager: (path: string) => Promise<PlatformOpenInEditorResult>;
  getInstalledEditors: () => Promise<EditorInfo[]>;
  [key: string]: unknown;
}

// ---- 用户 / OAuth（shared/oauth.ts 的类型子集）----

export interface UserInfo {
  id?: string;
  name?: string;
  email?: string;
  [key: string]: unknown;
}

export type OAuthProviderId = string;

// ---- 编码计划重置（shared/coding-plan-reset.ts 的类型子集）----

export type CodingPlanResetType = "none" | "daily" | "monthly" | string;

// ---- Git（shared/git.ts 的类型子集）----

export interface GitFileChange {
  path: string;
  status?: string;
  kind?: string;
  section?: string;
  isUntracked?: boolean;
  additions?: number;
  deletions?: number;
  [key: string]: unknown;
}

export interface GitRepositorySummary {
  path: string;
  branch?: string;
  isGitAvailable?: boolean;
  isRepository?: boolean;
  [key: string]: unknown;
}

// ---- 任务快照 / 变更摘要（shared/task-realtime*.ts 的消费子集，宽松形状）----

export interface ZCodeTaskSnapshotToolFieldRef {
  toolCallId?: string;
  field?: string;
  [key: string]: unknown;
}

export interface ZCodeTaskSnapshotToolSlice {
  [key: string]: unknown;
}

export interface ZCodeTaskSnapshotBodyRef {
  [key: string]: unknown;
}

export interface ZCodeTimelineMeta {
  [key: string]: unknown;
}

export interface ZCodePromptAttachment {
  [key: string]: unknown;
}

export interface ZCodeAssistantMessageFeedback {
  [key: string]: unknown;
}

export interface ZCodeAssistantMessagePart {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

export interface ZCodeFileChangeSnapshot {
  path: string;
  beforeContent: string | null;
  afterContent: string;
  writeCount: number;
  [key: string]: unknown;
}

export interface ZCodePersistedFileChange {
  turnIndex: number;
  snapshots: ZCodeFileChangeSnapshot[];
  [key: string]: unknown;
}

export interface ZCodeTaskChangedFileSummary {
  path: string;
  originalContent?: string | null;
  finalContent?: string | null;
  writeCount?: number;
  lastTurnIndex?: number;
  added?: number;
  removed?: number;
}

export interface ZCodeTaskChangeSummary {
  files: ZCodeTaskChangedFileSummary[];
  added?: number;
  removed?: number;
  [key: string]: unknown;
}

export interface ZCodeTaskMeta {
  changeSummary?: ZCodeTaskChangeSummary;
  [key: string]: unknown;
}

// ---- 测试锚点（shared/test-ids.ts 子集）----

export const TID_PREVIEW_PANE = "preview-pane";
export const TID_TOOL_SUMMARY_TRIGGER = "tool-summary-trigger";

export function testId(base: string, suffix: string): string {
  return `${base}:${suffix}`;
}
