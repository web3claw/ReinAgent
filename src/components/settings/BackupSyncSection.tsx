/**
 * BackupSyncSection —— 设置 ▸ 备份与同步（WebDAV 配置备份）。
 *
 * 功能面：
 *  - 同步配置表单（服务器地址 / 用户名 / 密码掩码 / 远端目录 / profile / 自动同步开关）；
 *  - 测试连接（用盘上已保存的配置，前端须先保存再测试）；
 *  - 立即上传 / 从远端恢复（恢复前拉远端摘要弹确认框，展示来源设备/时间/各域条目数）；
 *  - 自动同步状态横幅（last_sync_at + last_error，随 backup-sync-status-updated 事件刷新）。
 *
 * 密码交互采用 passwordTouched 语义：输入框仅在用户实际改动时提交新密码，
 * 否则后端沿用盘上旧值（掩码占位符不会覆盖真实密码）。
 */

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { CloudUpload, Download, Loader2, PlugZap, AlertCircle, CheckCircle2, Cloud } from "lucide-react";
import { useTranslation } from "../../i18n";
import { Button } from "../lw/ui/button";
import { Input } from "../lw/ui/input";
import { toast } from "../lw/ui/toast";
import { useConfirmDialog } from "../ui/ConfirmDialog";
import {
  backupDownload,
  backupFetchRemoteInfo,
  backupTestConnection,
  backupUpload,
  loadBackupSyncConfig,
  saveBackupSyncConfig,
  type BackupRemoteInfo,
  type BackupSyncConfigView,
} from "../../lib/backup/backupSync";

const PASSWORD_PLACEHOLDER = "••••••••";

export function BackupSyncSection() {
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  const [config, setConfig] = useState<BackupSyncConfigView | null>(null);
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [passwordDraft, setPasswordDraft] = useState("");
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [remoteDir, setRemoteDir] = useState("ReinAgent");
  const [profile, setProfile] = useState("default");
  const [autoSync, setAutoSync] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = () => {
    void loadBackupSyncConfig()
      .then((view) => {
        setConfig(view);
        setUrl(view.url);
        setUsername(view.username);
        setPasswordDraft("");
        setPasswordTouched(false);
        setRemoteDir(view.remoteDir);
        setProfile(view.profile);
        setAutoSync(view.autoSync);
      })
      .catch((err) => toast.error(formatError(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
    // 自动同步后台结果（成败横幅）实时刷新 last_sync_at / last_error。
    const un = listen<{ lastSyncAt: number | null; lastError: string | null }>(
      "backup-sync-status-updated",
      () => {
        void loadBackupSyncConfig()
          .then((view) => setConfig(view))
          .catch(() => undefined);
      },
    );
    return () => {
      void un.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = async () => {
    setSaving(true);
    try {
      const view = await saveBackupSyncConfig({
        url,
        username,
        password: passwordTouched ? passwordDraft : "",
        passwordTouched,
        remoteDir,
        profile,
        autoSync,
      });
      setConfig(view);
      setPasswordDraft("");
      setPasswordTouched(false);
      toast.success(t("backupSaved"));
    } catch (err) {
      toast.error(formatError(err));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      await backupTestConnection();
      toast.success(t("backupTestOk"));
    } catch (err) {
      toast.error(formatError(err), { duration: 6000 });
    } finally {
      setTesting(false);
    }
  };

  const upload = async () => {
    setUploading(true);
    try {
      await backupUpload();
      toast.success(t("backupUploadOk"));
      void loadBackupSyncConfig()
        .then((view) => setConfig(view))
        .catch(() => undefined);
    } catch (err) {
      toast.error(formatError(err), { duration: 6000 });
    } finally {
      setUploading(false);
    }
  };

  const download = async (info: BackupRemoteInfo) => {
    setDownloading(true);
    try {
      const outcome = await backupDownload();
      const counts = outcome.applied;
      toast.success(
        t("backupDownloadOk")
          .replace("{providers}", String(counts.providers))
          .replace("{mcp}", String(counts.mcp))
          .replace("{assistants}", String(counts.assistants))
          .replace("{skills}", String(counts.skillsSelection))
          .replace("{system}", String(counts.system)),
        { duration: 6000 },
      );
      void info;
    } catch (err) {
      toast.error(formatError(err), { duration: 8000 });
    } finally {
      setDownloading(false);
    }
  };

  const fetchRemoteInfo = async () => {
    try {
      const info = await backupFetchRemoteInfo();
      if (!info) {
        toast.error(t("backupRemoteEmpty"), { duration: 5000 });
        return;
      }
      const confirmed = await confirm({
        title: t("backupRestoreConfirmTitle"),
        description: (
          <div className="space-y-1.5 text-sm">
            <p>
              <span className="text-[var(--text-secondary)]">{t("backupRemoteDevice")}</span>{" "}
              {info.manifest.deviceName}
            </p>
            <p>
              <span className="text-[var(--text-secondary)]">{t("backupRemoteTime")}</span>{" "}
              {new Date(info.manifest.createdAt).toLocaleString()}
            </p>
            <p>
              <span className="text-[var(--text-secondary)]">{t("backupRemoteDomains")}</span>{" "}
              {t("backupDomainProviders").replace("{n}", String(info.manifest.domains.providers))} ·{" "}
              {t("backupDomainMcp").replace("{n}", String(info.manifest.domains.mcp))} ·{" "}
              {t("backupDomainAssistants").replace("{n}", String(info.manifest.domains.assistants))} ·{" "}
              {t("backupDomainSkills").replace("{n}", String(info.manifest.domains.skillsSelection))} ·{" "}
              {t("backupDomainSystem").replace("{n}", String(info.manifest.domains.system))}
            </p>
            <p className="whitespace-pre-line text-[11px] text-[var(--text-secondary)]">
              {t("backupRestoreWarning")}
            </p>
          </div>
        ),
        confirmLabel: t("backupRestoreConfirmYes"),
        cancelLabel: t("cancel"),
      });
      if (confirmed) void download(info);
    } catch (err) {
      toast.error(formatError(err), { duration: 6000 });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-[var(--text-dim)]">
        <Loader2 className="size-4 animate-spin" />
        {t("backupLoading")}
      </div>
    );
  }

  const lastError = config?.lastError ?? null;

  return (
    <div className="space-y-5">
      {/* 自动同步状态横幅 */}
      {lastError ? (
        <div className="flex items-start gap-2 rounded-xl border border-[var(--status-warn,var(--border))] bg-[var(--bg-elev)] p-3 text-sm">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-[var(--status-warn,var(--text-dim))]" />
          <div className="min-w-0">
            <p className="font-medium">{t("backupAutoErrorTitle")}</p>
            <p className="break-all text-[11px] text-[var(--text-dim)]">{lastError}</p>
          </div>
        </div>
      ) : config?.lastSyncAt ? (
        <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-3 text-sm">
          <CheckCircle2 className="size-4 shrink-0 text-[var(--status-ok)]" />
          <span>
            {t("backupLastSync").replace("{time}", new Date(config.lastSyncAt).toLocaleString())}
          </span>
        </div>
      ) : null}

      {/* 连接配置 */}
      <div className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-4">
        <div className="flex items-center gap-2">
          <Cloud className="size-4 text-[var(--brand)]" />
          <span className="text-sm font-semibold">{t("backupConnTitle")}</span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t("backupUrl")} hint={t("backupUrlHint")}>
            <Input
              value={url}
              onChange={(e) => setUrl(e.currentTarget.value)}
              placeholder="https://dav.jianguoyun.com/dav/"
              className="w-full"
            />
          </Field>
          <Field label={t("backupUsername")}>
            <Input value={username} onChange={(e) => setUsername(e.currentTarget.value)} className="w-full" />
          </Field>
          <Field label={t("backupPassword")} hint={t("backupPasswordHint")}>
            <Input
              type="password"
              value={passwordDraft}
              placeholder={config?.hasPassword ? PASSWORD_PLACEHOLDER : ""}
              onChange={(e) => {
                setPasswordDraft(e.currentTarget.value);
                setPasswordTouched(true);
              }}
              className="w-full"
            />
          </Field>
          <Field label={t("backupProfile")} hint={t("backupProfileHint")}>
            <Input value={profile} onChange={(e) => setProfile(e.currentTarget.value)} className="w-full" />
          </Field>
          <Field label={t("backupRemoteDir")} hint={t("backupRemoteDirHint")} className="sm:col-span-2">
            <Input value={remoteDir} onChange={(e) => setRemoteDir(e.currentTarget.value)} className="w-full" />
          </Field>
        </div>
        <label className="flex items-center justify-between cursor-pointer">
          <span>
            <span className="text-sm font-medium">{t("backupAutoSync")}</span>
            <p className="text-[11px] text-[var(--text-dim)]">{t("backupAutoSyncHint")}</p>
          </span>
          <input
            type="checkbox"
            checked={autoSync}
            onChange={(e) => setAutoSync(e.target.checked)}
            className="size-4 accent-[var(--brand)]"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void persist()} disabled={saving}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t("backupSaveConfig")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void test()} disabled={testing}>
            {testing ? <Loader2 className="size-3.5 animate-spin" /> : <PlugZap className="size-3.5" />}
            {t("backupTestConn")}
          </Button>
        </div>
        <p className="text-[11px] text-[var(--text-dim)]">{t("backupTestNeedsSave")}</p>
      </div>

      {/* 手动操作 */}
      <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-4">
        <span className="text-sm font-semibold">{t("backupManualTitle")}</span>
        <p className="text-[11px] text-[var(--text-dim)]">{t("backupManualHint")}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void upload()} disabled={uploading}>
            {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <CloudUpload className="size-3.5" />}
            {t("backupUploadNow")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void fetchRemoteInfo()} disabled={downloading}>
            {downloading ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
            {t("backupRestore")}
          </Button>
        </div>
      </div>

      {dialog}
    </div>
  );
}

function formatError(err: unknown): string {
  return String(err instanceof Error ? err.message : err).slice(0, 300);
}

function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <label className="text-xs text-[var(--text-dim)]">{label}</label>
      {children}
      {hint ? <p className="text-[11px] text-[var(--text-dim)]">{hint}</p> : null}
    </div>
  );
}
