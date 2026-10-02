/**
 * RemoteAccessSection —— 设置 ▸ 远程访问（局域网 Web 型手机远控）。
 *
 * 开关 / 端口 / 连接 URL（完整带 token）+ 二维码扫码即开 / 重置 token /
 * 已连接设备数 / 安全说明。状态经 remote-server:status 事件实时刷新。
 */

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "../../i18n";
import { Button } from "../lw/ui/button";
import { Input } from "../lw/ui/input";
import { toast } from "../lw/ui/toast";

interface RemoteStatus {
  enabled: boolean;
  port: number;
  token: string;
  url: string;
  connectedClients: number;
}

export function RemoteAccessSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [portDraft, setPortDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const qrRef = useRef<HTMLCanvasElement>(null);

  const refresh = () => {
    void invoke<RemoteStatus>("remote_server_status")
      .then((s) => {
        setStatus(s);
        setPortDraft(String(s.port));
      })
      .catch((err) => toast.error(String(err).slice(0, 160)));
  };

  useEffect(() => {
    refresh();
    const un = listen<{ enabled?: boolean; port?: number; connectedClients?: number; url?: string }>(
      "remote-server:status",
      () => refresh(),
    );
    return () => {
      void un.then((fn) => fn());
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

  const apply = async (patch: { enabled?: boolean; port?: number; resetToken?: boolean }) => {
    setSaving(true);
    try {
      const next = await invoke<RemoteStatus>("remote_server_config", {
        args: {
          enabled: patch.enabled ?? status?.enabled ?? false,
          port: patch.port ?? status?.port,
          resetToken: patch.resetToken ?? false,
        },
      });
      setStatus(next);
      setPortDraft(String(next.port));
      if (patch.resetToken) toast.success(t("remoteTokenReset"));
    } catch (err) {
      toast.error(String(err).slice(0, 160));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <h2 className="mb-6 text-xl font-semibold">{t("remoteTitle")}</h2>

      {/* 开关 */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-4">
        <label className="flex items-center justify-between">
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
          {/* URL + 二维码 */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-4">
            <p className="mb-3 text-xs font-medium">{t("remoteScanHint")}</p>
            <div className="flex items-center gap-4">
              <canvas ref={qrRef} className="rounded-lg border border-[var(--border)]" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="space-y-1">
                  <label className="text-[11px] text-[var(--text-dim)]">{t("remoteUrlLabel")}</label>
                  <p className="break-all font-mono text-[11px] text-[var(--text)]">{status.url}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const fail = () => toast.error(t("remoteCopyFailed"));
                      void navigator.clipboard
                        .writeText(status.url)
                        .then(() => toast.success(t("remoteCopied")))
                        .catch(() => {
                          // WebView2 剪贴板权限拒绝时的兜底：选中文本让用户手动 Ctrl+C
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
                    }}
                  >
                    {t("remoteCopyUrl")}
                  </Button>
                  <Button size="sm" variant="outline" disabled={saving} onClick={() => void apply({ resetToken: true })}>
                    {t("remoteResetToken")}
                  </Button>
                </div>
              </div>
            </div>
          </div>

          {/* 端口 + 设备数 */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <label className="text-xs font-medium text-[var(--text-dim)]">{t("remotePort")}</label>
              <div className="flex items-center gap-2">
                <Input
                  variant="plain"
                  className="w-24"
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
              <span className="tabular-nums font-medium">{status.connectedClients}</span>
            </div>
          </div>
        </>
      ) : null}

      <p className="text-[11px] leading-relaxed text-[var(--text-dim)]">{t("remoteSecurityHint")}</p>
    </div>
  );
}
