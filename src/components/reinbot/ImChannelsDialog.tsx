/**
 * ImChannelsDialog —— IM 机器人接入配置弹窗（ReinBot 工牌三图标点击弹出）。
 *
 * 三个平台（QQ / 微信 / 飞书）各自的接入表单 + 「测试连接」真实连通测试：
 * - 测试通过 → 自动保存配置并置 status=connected（工牌图标点亮）；
 * - 测试失败 → 配置照存（避免重输）但 status=error 保持灰色，原始错误如实展示（No-Fallback）。
 *
 * 微信走腾讯 iLink 扫码登录流（get_bot_qrcode → 轮询 get_qrcode_status →
 * confirmed 拿 bot_token → getconfig 校验），二维码用 qrcode 包由短链 URL 现场渲染。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import QRCode from "qrcode";
import { Loader2 } from "lucide-react";
import { useTranslation } from "../../i18n";
import {
  useImChannelsStore,
  type ImPlatform,
} from "../../store/useImChannelsStore";
import {
  startQqBotGateway,
  stopQqBotGateway,
  startWechatGateway,
  stopWechatGateway,
  startFeishuGateway,
  stopFeishuGateway,
} from "../../lib/reinbot/qqbotBridge";
import { Button } from "../lw/ui/button";
import { Input } from "../lw/ui/input";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../lw/ui/dialog";
import {
  FeishuBrandIcon,
  QqBrandIcon,
  WechatBrandIcon,
} from "./imBrandIcons";

interface ImChannelsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  platform: ImPlatform;
  onPlatformChange: (platform: ImPlatform) => void;
}

const fmtTemplate = (template: string, params: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => params[key] ?? "");

/** 状态行：测试成功（绿）/ 失败（红，含原始错误）。 */
function StatusLine({ ok, text }: { ok: boolean; text: string }) {
  if (!text) return null;
  return (
    <div
      className={`mt-2 rounded-md border px-2.5 py-1.5 text-xs break-all ${
        ok
          ? "border-[var(--success-border)]/40 bg-[var(--success-bg)]/20 text-[var(--success-text)]"
          : "border-[var(--danger)]/40 bg-[var(--danger)]/10 text-[var(--danger)]"
      }`}
    >
      {text}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 text-xs font-medium text-[var(--text-dim)]">{children}</div>;
}

// ---------------- QQ（官方机器人开放平台 q.qq.com/qqbot） ----------------

function QqPanel() {
  const { t } = useTranslation();
  const channels = useImChannelsStore((s) => s.channels);
  const setChannel = useImChannelsStore((s) => s.setChannel);
  const saved = channels.qq;

  const [appId, setAppId] = useState(saved.appId ?? "");
  const [appSecret, setAppSecret] = useState(saved.appSecret ?? "");
  const [testing, setTesting] = useState(false);
  const [okMsg, setOkMsg] = useState("");
  const [errMsg, setErrMsg] = useState("");

  const handleTest = async () => {
    setTesting(true);
    setOkMsg("");
    setErrMsg("");
    try {
      const username = await invoke<string>("im_qqbot_test", {
        args: { app_id: appId.trim(), app_secret: appSecret.trim() },
      });
      setOkMsg(`${t("reinbotImTestOk")} · ${username}`);
      setChannel("qq", {
        status: "connected",
        connectedAt: new Date().toISOString(),
        appId: appId.trim(),
        appSecret: appSecret.trim(),
        botUsername: username,
      });
      // 凭据有效 → 立即拉起消息网关（收发消息管道）
      void startQqBotGateway(appId.trim(), appSecret.trim()).catch((err) => {
        console.error("[im] 网关拉起失败：", err);
        setErrMsg(String(err));
      });
    } catch (err) {
      const raw = String(err);
      setErrMsg(raw);
      setChannel("qq", {
        status: "error",
        appId: appId.trim(),
        appSecret: appSecret.trim(),
        error: raw,
      });
    } finally {
      setTesting(false);
    }
  };

  const handleDisconnect = async () => {
    await stopQqBotGateway();
    setChannel("qq", { status: "not_configured" });
    setAppId("");
    setAppSecret("");
    setOkMsg("");
    setErrMsg("");
  };

  return (
    <div>
      <div className="mb-3 text-[11px] text-[var(--text-muted)]">{t("reinbotImQqOfficialDesc")}</div>
      <FieldLabel>{t("reinbotImQqAppId")}</FieldLabel>
      <Input value={appId} onChange={(e) => setAppId(e.target.value)} />
      <div className="mt-3 mb-1">
        <FieldLabel>{t("reinbotImQqAppSecret")}</FieldLabel>
        <Input value={appSecret} onChange={(e) => setAppSecret(e.target.value)} type="password" />
      </div>
      <div className="mt-3">
        <Button onClick={() => void handleTest()} disabled={testing || !appId.trim() || !appSecret.trim()}>
          {testing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {testing ? t("reinbotImTesting") : t("reinbotImTest")}
        </Button>
        <span className="ml-2 text-[11px] text-[var(--text-muted)]">{t("reinbotImSaveOnSuccess")}</span>
      </div>
      <StatusLine ok text={okMsg} />
      <StatusLine ok={false} text={errMsg} />
      {saved.status === "connected" && saved.connectedAt && (
        <div className="mt-2 flex items-center justify-between text-[11px]">
          <span className="text-[var(--success-text)]">
            {fmtTemplate(t("reinbotImConnectedAt"), { time: new Date(saved.connectedAt).toLocaleString() })}
            {saved.botUsername ? ` · ${saved.botUsername}` : ""}
          </span>
          <button
            type="button"
            className="text-[var(--danger)] hover:underline"
            onClick={() => void handleDisconnect()}
          >
            {t("reinbotImDisconnect")}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------- 飞书（自定义群机器人） ----------------

function FeishuPanel() {
  const { t } = useTranslation();
  const channels = useImChannelsStore((s) => s.channels);
  const setChannel = useImChannelsStore((s) => s.setChannel);
  const saved = channels.feishu;

  const [appId, setAppId] = useState(saved.appId ?? "");
  const [appSecret, setAppSecret] = useState(saved.appSecret ?? "");
  const [testing, setTesting] = useState(false);
  const [okMsg, setOkMsg] = useState("");
  const [errMsg, setErrMsg] = useState("");

  const handleTest = async () => {
    setTesting(true);
    setOkMsg("");
    setErrMsg("");
    try {
      const botName = await invoke<string>("im_feishu_test", {
        args: { app_id: appId.trim(), app_secret: appSecret.trim() },
      });
      setOkMsg(`${t("reinbotImTestOk")} · ${botName}`);
      setChannel("feishu", {
        status: "connected",
        connectedAt: new Date().toISOString(),
        appId: appId.trim(),
        appSecret: appSecret.trim(),
        botUsername: botName,
      });
      // 凭据有效 → 立即拉起飞书长连接网关（收发消息管道）
      void startFeishuGateway(appId.trim(), appSecret.trim()).catch((err) => {
        console.error("[im] 飞书网关拉起失败：", err);
        setErrMsg(String(err));
      });
    } catch (err) {
      const raw = String(err);
      setErrMsg(raw);
      setChannel("feishu", {
        status: "error",
        appId: appId.trim(),
        appSecret: appSecret.trim(),
        error: raw,
      });
    } finally {
      setTesting(false);
    }
  };

  const handleDisconnect = async () => {
    await stopFeishuGateway();
    setChannel("feishu", { status: "not_configured" });
    setAppId("");
    setAppSecret("");
    setOkMsg("");
    setErrMsg("");
  };

  return (
    <div>
      <div className="mb-3 text-[11px] text-[var(--text-muted)]">{t("reinbotImFeishuAppDesc")}</div>
      <FieldLabel>{t("reinbotImQqAppId")}</FieldLabel>
      <Input value={appId} onChange={(e) => setAppId(e.target.value)} />
      <div className="mt-3 mb-1">
        <FieldLabel>{t("reinbotImQqAppSecret")}</FieldLabel>
        <Input value={appSecret} onChange={(e) => setAppSecret(e.target.value)} type="password" />
      </div>
      <div className="mt-3">
        <Button onClick={() => void handleTest()} disabled={testing || !appId.trim() || !appSecret.trim()}>
          {testing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {testing ? t("reinbotImTesting") : t("reinbotImTest")}
        </Button>
        <span className="ml-2 text-[11px] text-[var(--text-muted)]">{t("reinbotImSaveOnSuccess")}</span>
      </div>
      <StatusLine ok text={okMsg} />
      <StatusLine ok={false} text={errMsg} />
      {saved.status === "connected" && saved.connectedAt && (
        <div className="mt-2 flex items-center justify-between text-[11px]">
          <span className="text-[var(--success-text)]">
            {fmtTemplate(t("reinbotImConnectedAt"), { time: new Date(saved.connectedAt).toLocaleString() })}
            {saved.botUsername ? ` · ${saved.botUsername}` : ""}
          </span>
          <button
            type="button"
            className="text-[var(--danger)] hover:underline"
            onClick={() => void handleDisconnect()}
          >
            {t("reinbotImDisconnect")}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------- 微信（iLink 个人号 Bot） ----------------

type WechatScanPhase = "idle" | "qr_ready" | "polling" | "confirmed";

function WechatPanel() {
  const { t } = useTranslation();
  const channels = useImChannelsStore((s) => s.channels);
  const setChannel = useImChannelsStore((s) => s.setChannel);
  const clearChannel = useImChannelsStore((s) => s.clearChannel);
  const saved = channels.wechat;

  const [phase, setPhase] = useState<WechatScanPhase>("idle");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [scanHint, setScanHint] = useState("");
  const [errMsg, setErrMsg] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [manualToken, setManualToken] = useState("");
  const [baseUrl, setBaseUrl] = useState(saved.baseUrl ?? "");
  const [testing, setTesting] = useState(false);
  const [okMsg, setOkMsg] = useState("");
  const pollingRef = useRef(false);
  const closedRef = useRef(false);

  useEffect(() => {
    closedRef.current = false;
    return () => {
      closedRef.current = true;
      pollingRef.current = false;
    };
  }, []);

  const saveConnected = useCallback(
    (botToken: string, url: string, ilinkUserId?: string) => {
      setChannel("wechat", {
        status: "connected",
        connectedAt: new Date().toISOString(),
        botToken,
        baseUrl: url,
        ilinkUserId,
      });
      setPhase("confirmed");
      setScanHint(t("reinbotImWechatConfirmed"));
      setOkMsg(t("reinbotImWechatConfirmed"));
      // 凭据就绪 → 立即拉起微信消息网关（收发消息管道）
      void startWechatGateway(botToken, url).catch((err) => {
        console.error("[im] 微信网关拉起失败：", err);
        setErrMsg(String(err));
      });
    },
    [setChannel, t],
  );

  const handleGenQr = async () => {
    setErrMsg("");
    setOkMsg("");
    setScanHint("");
    try {
      const res = await invoke<{ qrcode: string; qrcodeImgContent: string }>(
        "im_wechat_qrcode_start",
        { args: { base_url: baseUrl.trim() || null } },
      );
      // 实测 qrcode_img_content 为短链 URL → 前端自渲染二维码图。
      const dataUrl = await QRCode.toDataURL(res.qrcodeImgContent || res.qrcode, {
        margin: 1,
        width: 176,
      });
      if (closedRef.current) return;
      setQrDataUrl(dataUrl);
      setPhase("qr_ready");
      setScanHint(t("reinbotImWechatWaitingScan"));
      pollingRef.current = true;
      setPhase("polling");
      void pollStatus(res.qrcode, baseUrl.trim());
    } catch (err) {
      setErrMsg(String(err));
      setPhase("idle");
    }
  };

  const pollStatus = async (qrcodeId: string, url: string) => {
    for (;;) {
      if (!pollingRef.current || closedRef.current) return;
      await new Promise((r) => setTimeout(r, 1500));
      if (!pollingRef.current || closedRef.current) return;
      try {
        const st = await invoke<{ status: string; botToken?: string; baseurl?: string; ilinkUserId?: string }>(
          "im_wechat_qrcode_poll",
          { args: { base_url: url || null, qrcode: qrcodeId } },
        );
        if (closedRef.current) return;
        if (st.status === "confirmed" && st.botToken) {
          pollingRef.current = false;
          // confirmed = 腾讯已为扫码账号签发真实 bot_token，登录完成（参考实现
          // 语义；getconfig 的 GetTypingTicket RPC 需聊天上下文，不能当校验用）。
          if (closedRef.current) return;
          saveConnected(st.botToken, st.baseurl || url || "", st.ilinkUserId ?? undefined);
          return;
        }
        if (st.status === "expired") {
          pollingRef.current = false;
          setPhase("qr_ready");
          setScanHint(t("reinbotImWechatExpired"));
          return;
        }
        if (st.status === "scanned") {
          setScanHint(t("reinbotImWechatScanned"));
        }
      } catch (err) {
        // 单次轮询失败不终止流程（网络抖动），连续失败由用户手动停止重试。
        if (closedRef.current) return;
        pollingRef.current = false;
        setPhase("qr_ready");
        setErrMsg(String(err));
        return;
      }
    }
  };

  const handleManualVerify = async () => {
    setTesting(true);
    setErrMsg("");
    setOkMsg("");
    try {
      await invoke("im_wechat_verify", {
        args: { base_url: baseUrl.trim() || null, bot_token: manualToken.trim() },
      });
      saveConnected(manualToken.trim(), baseUrl.trim());
    } catch (err) {
      const raw = String(err);
      setErrMsg(raw);
      setChannel("wechat", {
        status: "error",
        botToken: manualToken.trim(),
        baseUrl: baseUrl.trim(),
        error: raw,
      });
    } finally {
      setTesting(false);
    }
  };

  const connected = saved.status === "connected";

  return (
    <div>
      <div className="text-xs font-medium text-[var(--text-dim)]">{t("reinbotImWechatScanTitle")}</div>
      <div className="mt-1 text-[11px] text-[var(--text-muted)]">{t("reinbotImWechatScanDesc")}</div>
      <div className="mt-3 flex flex-col items-center gap-2">
        {qrDataUrl ? (
          <img src={qrDataUrl} alt="WeChat QR" className="w-44 h-44 rounded-lg border border-[var(--border)]" />
        ) : (
          <div className="w-44 h-44 rounded-lg border border-dashed border-[var(--border)] flex items-center justify-center text-[11px] text-[var(--text-muted)]">
            {t("reinbotImWechatScanTitle")}
          </div>
        )}
        <Button onClick={() => void handleGenQr()} variant="secondary">
          {qrDataUrl ? t("reinbotImWechatRefreshQr") : t("reinbotImWechatGenQr")}
        </Button>
        {scanHint && (
          <div className="text-xs text-[var(--text-dim)] flex items-center gap-1.5">
            {phase === "polling" && <Loader2 className="w-3 h-3 animate-spin" />}
            {scanHint}
          </div>
        )}
      </div>

      <button
        type="button"
        className="mt-4 text-[11px] text-[var(--text-muted)] hover:text-[var(--text)] underline underline-offset-2"
        onClick={() => setShowAdvanced((v) => !v)}
      >
        {t("reinbotImWechatAdvanced")}
      </button>
      {showAdvanced && (
        <div className="mt-2 rounded-lg border border-[var(--border)] p-3">
          <FieldLabel>{t("reinbotImWechatToken")}</FieldLabel>
          <Input value={manualToken} onChange={(e) => setManualToken(e.target.value)} type="password" />
          <div className="mt-2">
            <FieldLabel>{t("reinbotImWechatBaseUrl")}</FieldLabel>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </div>
          <div className="mt-3">
            <Button onClick={() => void handleManualVerify()} disabled={testing || !manualToken.trim()}>
              {testing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {testing ? t("reinbotImTesting") : t("reinbotImTest")}
            </Button>
          </div>
        </div>
      )}

      <StatusLine ok text={okMsg} />
      <StatusLine ok={false} text={errMsg} />
      {connected && saved.connectedAt && (
        <div className="mt-2 flex items-center justify-between text-[11px] text-[var(--success-text)]">
          <span>
            {fmtTemplate(t("reinbotImConnectedAt"), { time: new Date(saved.connectedAt).toLocaleString() })}
          </span>
          <button
            type="button"
            className="text-[var(--danger)] hover:underline"
            onClick={() => {
              void stopWechatGateway();
              clearChannel("wechat");
              setPhase("idle");
              setQrDataUrl("");
              setScanHint("");
              setOkMsg("");
              setManualToken("");
            }}
          >
            {t("reinbotImDisconnect")}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------- 弹窗主体 ----------------

const PLATFORM_TABS = [
  { id: "qq", labelKey: "reinbotImQq", colorVar: "var(--im-qq)" },
  { id: "wechat", labelKey: "reinbotImWechat", colorVar: "var(--im-wechat)" },
  { id: "feishu", labelKey: "reinbotImFeishu", colorVar: "var(--im-feishu)" },
] as const;

export function ImChannelsDialog({ open, onOpenChange, platform, onPlatformChange }: ImChannelsDialogProps) {
  const { t } = useTranslation();
  const channels = useImChannelsStore((s) => s.channels);

  const iconFor = (id: ImPlatform, className: string) =>
    id === "qq" ? <QqBrandIcon className={className} /> : id === "wechat" ? <WechatBrandIcon className={className} /> : <FeishuBrandIcon className={className} />;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{t("reinbotImDialogTitle")}</DialogTitle>
          <DialogDescription>{t("reinbotImDialogDesc")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex gap-1.5 mb-4">
            {PLATFORM_TABS.map((tab) => {
              const active = tab.id === platform;
              const connected = channels[tab.id]?.status === "connected";
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => onPlatformChange(tab.id)}
                  className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                    active
                      ? "border-[var(--brand)]/60 bg-[var(--brand)]/10 text-[var(--text)]"
                      : "border-[var(--border)] text-[var(--text-dim)] hover:bg-[var(--bg-hover)]"
                  }`}
                >
                  <span style={connected ? { color: tab.colorVar } : undefined} className="opacity-90">
                    {iconFor(tab.id, "w-3.5 h-3.5")}
                  </span>
                  {t(tab.labelKey)}
                </button>
              );
            })}
          </div>
          {platform === "qq" && <QqPanel />}
          {platform === "wechat" && <WechatPanel />}
          {platform === "feishu" && <FeishuPanel />}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
