/**
 * RemoteAccessSection —— 设置 ▸ 远程访问（局域网 / Cloudflare 免配置公网隧道 / 自定义域名）。
 *
 * 状态机：
 * - 模式切换：lan (局域网) | cloudflare (公网安全隧道) | custom (自定义公网域名)
 * - 实时显示连接状态、动态捕获公网 HTTPS URL、二维码渲染、一键复制、重置凭证与设备统计。
 */

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Globe, Wifi, Cloud, Loader2, Copy, RefreshCw, CheckCircle2, AlertCircle } from "lucide-react";
import { useTranslation } from "../../i18n";
import { Button } from "../lw/ui/button";
import { Input } from "../lw/ui/input";
import { toast } from "../lw/ui/toast";

export type NetworkMode = "lan" | "cloudflare" | "custom";

interface RemoteStatus {
  enabled: boolean;
  port: number;
  token: string;
  url: string;
  connectedClients: number;
  networkMode: NetworkMode;
  customUrl: string;
  tunnelStatus: "stopped" | "starting" | "running" | "error";
  tunnelUrl?: string | null;
  tunnelError?: string | null;
  tunnelProgress?: string | null;
}

export function RemoteAccessSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [portDraft, setPortDraft] = useState("");
  const [customUrlDraft, setCustomUrlDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const qrRef = useRef<HTMLCanvasElement>(null);

  const refresh = () => {
    void invoke<RemoteStatus>("remote_server_status")
      .then((s) => {
        setStatus(s);
        setPortDraft(String(s.port));
        setCustomUrlDraft(s.customUrl || "");
      })
      .catch((err) => toast.error(String(err).slice(0, 160)));
  };

  useEffect(() => {
    refresh();
    const un = listen<{ enabled?: boolean; port?: number; connectedClients?: number; url?: string }>(
      "remote-server:status",
      () => refresh(),
    );
    const unTunnel = listen("remote-server:tunnel-status", () => refresh());
    return () => {
      void un.then((fn) => fn());
      void unTunnel.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 二维码渲染
  useEffect(() => {
    if (!status?.url || !qrRef.current || !status.enabled) return;
    void QRCode.toCanvas(qrRef.current, status.url, {
      width: 160,
      margin: 1,
      color: { dark: "#e8e8ea", light: "#1d1e21" },
    }).catch(() => undefined);
  }, [status?.url, status?.enabled]);

  const apply = async (patch: {
    enabled?: boolean;
    port?: number;
    resetToken?: boolean;
    networkMode?: NetworkMode;
    customUrl?: string;
  }) => {
    setSaving(true);
    try {
      const next = await invoke<RemoteStatus>("remote_server_config", {
        args: {
          enabled: patch.enabled ?? status?.enabled ?? false,
          port: patch.port ?? status?.port,
          resetToken: patch.resetToken ?? false,
          networkMode: patch.networkMode ?? status?.networkMode ?? "lan",
          customUrl: patch.customUrl ?? status?.customUrl ?? "",
        },
      });
      setStatus(next);
      setPortDraft(String(next.port));
      setCustomUrlDraft(next.customUrl || "");
      if (patch.resetToken) toast.success(t("remoteTokenReset"));
    } catch (err) {
      toast.error(String(err).slice(0, 160));
    } finally {
      setSaving(false);
    }
  };

  const copyUrl = () => {
    if (!status?.url) return;
    const fail = () => toast.error(t("remoteCopyFailed"));
    void navigator.clipboard
      .writeText(status.url)
      .then(() => toast.success(t("remoteCopied")))
      .catch(() => {
        const range = document.createRange();
        const urlNode = [...document.querySelectorAll("p")].find((p) => p.textContent === status.url);
        if (urlNode) {
          range.selectNodeContents(urlNode);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
        fail();
      });
  };

  const currentMode: NetworkMode = status?.networkMode ?? "lan";

  return (
    <div className="space-y-5">
      <h2 className="mb-6 text-xl font-semibold">{t("remoteTitle")}</h2>

      {/* 主开关 */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-4">
        <label className="flex items-center justify-between cursor-pointer">
          <span>
            <span className="text-sm font-medium">{t("remoteEnable")}</span>
            <p className="text-[11px] text-[var(--text-dim)]">{t("remoteEnableHint")}</p>
          </span>
          <input
            type="checkbox"
            checked={status?.enabled ?? false}
            disabled={saving}
            onChange={(e) => void apply({ enabled: e.target.checked })}
            className="size-4 accent-[var(--brand)]"
          />
        </label>
      </div>

      {status?.enabled ? (
        <>
          {/* 网络模式选择卡片 */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-4 space-y-3">
            <label className="text-xs font-medium text-[var(--text-dim)]">{t("remoteNetworkMode")}</label>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
              {/* 局域网模式 */}
              <button
                type="button"
                onClick={() => void apply({ networkMode: "lan" })}
                className={`flex flex-col text-left p-3 rounded-lg border transition-all ${
                  currentMode === "lan"
                    ? "border-[var(--brand)] bg-[var(--brand-muted,rgba(59,130,246,0.08))]"
                    : "border-[var(--border)] hover:border-[var(--text-dim)] bg-[var(--bg)]"
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <Wifi className="size-4 text-[var(--brand)]" />
                  <span className="text-xs font-semibold">{t("remoteModeLan")}</span>
                </div>
                <p className="text-[11px] text-[var(--text-dim)] leading-tight">{t("remoteModeLanDesc")}</p>
              </button>

              {/* Cloudflare 免配置隧道模式 */}
              <button
                type="button"
                onClick={() => void apply({ networkMode: "cloudflare" })}
                className={`flex flex-col text-left p-3 rounded-lg border transition-all ${
                  currentMode === "cloudflare"
                    ? "border-[var(--brand)] bg-[var(--brand-muted,rgba(59,130,246,0.08))]"
                    : "border-[var(--border)] hover:border-[var(--text-dim)] bg-[var(--bg)]"
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <Cloud className="size-4 text-[var(--brand)]" />
                  <span className="text-xs font-semibold">{t("remoteModeCloudflare")}</span>
                </div>
                <p className="text-[11px] text-[var(--text-dim)] leading-tight">{t("remoteModeCloudflareDesc")}</p>
              </button>

              {/* 自定义公网域名 */}
              <button
                type="button"
                onClick={() => void apply({ networkMode: "custom" })}
                className={`flex flex-col text-left p-3 rounded-lg border transition-all ${
                  currentMode === "custom"
                    ? "border-[var(--brand)] bg-[var(--brand-muted,rgba(59,130,246,0.08))]"
                    : "border-[var(--border)] hover:border-[var(--text-dim)] bg-[var(--bg)]"
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <Globe className="size-4 text-[var(--brand)]" />
                  <span className="text-xs font-semibold">{t("remoteModeCustom")}</span>
                </div>
                <p className="text-[11px] text-[var(--text-dim)] leading-tight">{t("remoteModeCustomDesc")}</p>
              </button>
            </div>

            {/* 自定义公网域名输入框 */}
            {currentMode === "custom" && (
              <div className="pt-2 border-t border-[var(--border)] mt-2">
                <div className="flex items-center justify-between gap-3">
                  <label className="text-xs font-medium text-[var(--text-dim)] shrink-0">
                    {t("remoteCustomUrlLabel")}
                  </label>
                  <div className="flex items-center gap-2 flex-1 max-w-md">
                    <Input
                      variant="plain"
                      className="w-full text-xs font-mono"
                      placeholder={t("remoteCustomUrlPlaceholder")}
                      value={customUrlDraft}
                      onChange={(e) => setCustomUrlDraft(e.currentTarget.value.trim())}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={saving || customUrlDraft === status.customUrl}
                      onClick={() => void apply({ customUrl: customUrlDraft })}
                    >
                      {t("sttSave")}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 连接状态与二维码卡片 */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-medium">{t("remoteScanHint")}</p>

              {/* 隧道状态提示徽标 */}
              {currentMode === "cloudflare" && (
                <div className="flex items-center gap-1.5 text-xs">
                  {status.tunnelStatus === "starting" && (
                    <span className="inline-flex items-center gap-1 text-[var(--text-dim)]">
                      <Loader2 className="size-3.5 animate-spin text-[var(--brand)]" />
                      <span>{status.tunnelProgress || t("remoteTunnelStarting")}</span>
                    </span>
                  )}
                  {status.tunnelStatus === "running" && (
                    <span className="inline-flex items-center gap-1 text-emerald-500 font-medium">
                      <CheckCircle2 className="size-3.5" />
                      <span>公网加密隧道已连接</span>
                    </span>
                  )}
                  {status.tunnelStatus === "error" && (
                    <span className="inline-flex items-center gap-1.5 text-amber-500">
                      <AlertCircle className="size-3.5" />
                      <span>{status.tunnelError || t("remoteTunnelError")}</span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-xs"
                        onClick={() => void apply({ networkMode: "cloudflare" })}
                      >
                        {t("remoteTunnelRetry")}
                      </Button>
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* 如果正在连接 Cloudflare 且暂无 URL 时显示就位进度 */}
            {currentMode === "cloudflare" && status.tunnelStatus === "starting" && !status.url ? (
              <div className="flex flex-col items-center justify-center p-8 space-y-3 rounded-lg border border-dashed border-[var(--border)]">
                <Loader2 className="size-8 animate-spin text-[var(--brand)]" />
                <p className="text-xs text-[var(--text-dim)] font-medium">
                  {status.tunnelProgress || t("remoteTunnelStarting")}
                </p>
              </div>
            ) : (
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                <canvas ref={qrRef} className="rounded-lg border border-[var(--border)] shrink-0" />
                <div className="min-w-0 flex-1 space-y-2.5">
                  <div className="space-y-1">
                    <label className="text-[11px] text-[var(--text-dim)]">{t("remoteUrlLabel")}</label>
                    <p className="break-all font-mono text-[11px] text-[var(--text)] select-all bg-[var(--bg)] p-2 rounded border border-[var(--border)]">
                      {status.url || "（请稍候，等待生成公网链接...）"}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!status.url}
                      onClick={copyUrl}
                      className="gap-1.5"
                    >
                      <Copy className="size-3.5" />
                      {t("remoteCopyUrl")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={saving}
                      onClick={() => void apply({ resetToken: true })}
                      className="gap-1.5"
                    >
                      <RefreshCw className="size-3.5" />
                      {t("remoteResetToken")}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 端口与设备状态 */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <label className="text-xs font-medium text-[var(--text-dim)]">{t("remotePort")}</label>
              <div className="flex items-center gap-2">
                <Input
                  variant="plain"
                  className="w-24 text-xs font-mono"
                  value={portDraft}
                  onChange={(e) => setPortDraft(e.currentTarget.value.replace(/\D/g, ""))}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saving || !portDraft || Number(portDraft) === status.port}
                  onClick={() => void apply({ port: Number(portDraft) })}
                >
                  {t("sttSave")}
                </Button>
              </div>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-[var(--text-dim)]">{t("remoteConnectedDevices")}</span>
              <span className="tabular-nums font-medium bg-[var(--bg)] px-2 py-0.5 rounded border border-[var(--border)]">
                {status.connectedClients} 台设备在线
              </span>
            </div>
          </div>
        </>
      ) : null}

      <p className="text-[11px] leading-relaxed text-[var(--text-dim)]">{t("remoteSecurityHint")}</p>
    </div>
  );
}
