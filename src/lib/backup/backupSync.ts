/**
 * backupSync —— WebDAV 配置备份同步的前端辅助层。
 *
 * 职责：
 *  - `markBackupDirty`：配置保存动作完成后标脏（Rust 侧防抖合并成一次自动上传，
 *    仅在开启自动同步且凭据齐全时才真的上传；未启用时为后端空操作）；
 *  - `loadBackupSyncConfig` / `saveBackupSyncConfig`：同步配置读写（密码视图分离）；
 *  - `backupUpload` / `backupDownload` / `backupFetchRemoteInfo` / `backupTestConnection`：
 *    手动命令薄封装。
 *
 * 五个标脏点（与 Rust 快照域一一对应）：provider_config.json 保存、mcp_servers.json
 * 保存、助手文档保存/删除、技能启用集变化（hubSettings.skills.selected）、系统默认
 * 模型（settings.json settings 键）变更。标脏失败静默忽略 —— 自动同步是尽力而为的
 * 后台动作，不应打扰主流程。
 */

const invoke = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
  const m = await import("@tauri-apps/api/core");
  return m.invoke<T>(cmd, args);
};

/** 标脏：配置已变更，自动同步任务将在防抖窗口后上传。 */
export function markBackupDirty(): void {
  void invoke("backup_mark_dirty").catch(() => undefined);
}

export interface BackupSyncConfigView {
  url: string;
  username: string;
  hasPassword: boolean;
  remoteDir: string;
  profile: string;
  autoSync: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
}

export interface BackupSyncConfigRequest {
  url: string;
  username: string;
  password: string;
  /** 用户是否实际改动了密码框（false = 后端沿用盘上旧值，防掩码占位符写库）。 */
  passwordTouched: boolean;
  remoteDir: string;
  profile: string;
  autoSync: boolean;
}

export interface BackupManifestView {
  protocolVersion: number;
  schemaVersion: number;
  snapshotId: string;
  createdAt: string;
  deviceName: string;
  appVersion: string;
  encryption: string;
  domains: {
    providers: number;
    mcp: number;
    assistants: number;
    skillsSelection: number;
    system: number;
  };
}

export interface BackupRemoteInfo {
  manifest: BackupManifestView;
  size: number;
  sha256: string;
}

export interface BackupApplyOutcome {
  applied: BackupManifestView["domains"];
  backupPath: string | null;
}

export async function loadBackupSyncConfig(): Promise<BackupSyncConfigView> {
  return invoke<BackupSyncConfigView>("backup_load_sync_config");
}

export async function saveBackupSyncConfig(request: BackupSyncConfigRequest): Promise<BackupSyncConfigView> {
  return invoke<BackupSyncConfigView>("backup_save_sync_config", { config: request });
}

export async function backupTestConnection(): Promise<void> {
  return invoke("backup_test_sync_connection");
}

export async function backupFetchRemoteInfo(): Promise<BackupRemoteInfo | null> {
  return invoke<BackupRemoteInfo | null>("backup_fetch_remote_info");
}

export async function backupUpload(): Promise<number> {
  return invoke<number>("backup_upload");
}

export async function backupDownload(): Promise<BackupApplyOutcome> {
  return invoke<BackupApplyOutcome>("backup_download");
}

/** 弹系统保存对话框选导出路径；取消返回 null。 */
export async function pickSavePath(defaultFileName: string): Promise<string | null> {
  return invoke<string | null>("fs_pick_save_path", {
    defaultFileName,
    filterName: "JSON",
    filterExtensions: ["json"],
  });
}

/** 弹系统打开对话框选导入文件；取消返回 null。 */
export async function pickOpenFile(): Promise<string | null> {
  return invoke<string | null>("fs_pick_open_file", {
    filterName: "JSON",
    filterExtensions: ["json"],
  });
}

/** 导出到本地文件（路径已选定），返回 manifest 供摘要展示。 */
export async function backupExportToFile(path: string): Promise<BackupManifestView> {
  return invoke<BackupManifestView>("backup_export_to_file", { path });
}

/** 导入预览：解析+校验（不写盘），返回 manifest 供确认框展示。失败抛错。 */
export async function backupImportPreview(path: string): Promise<BackupRemoteInfo> {
  return invoke<BackupRemoteInfo>("backup_import_preview", { path });
}

/** 从本地文件导入应用（确认后调用），走 backup:applied 重载链。 */
export async function backupImportFromFile(path: string): Promise<BackupApplyOutcome> {
  return invoke<BackupApplyOutcome>("backup_import_from_file", { path });
}
