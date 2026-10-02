/**
 * SttSection —— 设置 ▸ 语音输入（结构移植自 LiveAgent SttSection.tsx，样式对齐本方设置页）。
 *
 * 总开关 + 供应商选择 + 每家表单 + 连接测试（真连云一次，六态反馈）。
 * 保存走 loadSttSettings/saveSttSettings（settings.json "stt" 键）；clearSecrets
 * 一次性清密钥：勾选后保存时清空密钥族字段并自动移除标记。
 */

import { useEffect, useState } from "react";
import { Loader2, Mic } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "../../i18n";
import { Button } from "../lw/ui/button";
import { Input } from "../lw/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../lw/ui/select";
import {
  STT_PROVIDER_IDS,
  defaultSttProvider,
  isProviderConfigured,
  loadSttSettings,
  runtimeConfig,
  saveSttSettings,
  validateProvider,
  type SttProviderId,
  type SttProviderSettings,
  type SttSettings,
} from "../../lib/stt/settings";
import type { SttConnectionTestResult } from "../../lib/stt/types";

const PROVIDER_LABELS: Record<SttProviderId, string> = {
  tencent_cloud: "腾讯云",
  volcengine_seed_v3: "火山引擎 Seed v3（豆包）",
  volcengine_v2: "火山引擎 v2",
  aliyun_dashscope: "阿里云 DashScope",
  baidu_cloud: "百度云",
};

/** 各供应商表单字段（label/占位/key）。 */
const PROVIDER_FIELDS: Record<SttProviderId, Array<{ key: keyof SttProviderSettings; label: string; placeholder?: string; secret?: boolean }>> = {
  tencent_cloud: [
    { key: "appId", label: "AppId", placeholder: "腾讯云 AppId（数字）" },
    { key: "engineModelType", label: "引擎模型", placeholder: "16k_zh" },
    { key: "secretId", label: "SecretId", placeholder: "腾讯云 SecretId", secret: true },
    { key: "secretKey", label: "SecretKey", placeholder: "腾讯云 SecretKey", secret: true },
  ],
  volcengine_seed_v3: [
    { key: "appId", label: "App ID", placeholder: "火山 App ID" },
    { key: "accessToken", label: "Access Token", placeholder: "火山 Access Token", secret: true },
    { key: "resourceId", label: "Resource ID", placeholder: "volcengine.megavoice 等资源 ID" },
  ],
  volcengine_v2: [
    { key: "appId", label: "App ID", placeholder: "火山 v2 App ID" },
    { key: "cluster", label: "Cluster", placeholder: "volcengine_streaming" },
    { key: "accessToken", label: "Access Token", placeholder: "火山 v2 Access Token", secret: true },
  ],
  aliyun_dashscope: [
    { key: "apiKey", label: "API Key", placeholder: "DashScope API Key", secret: true },
    { key: "model", label: "模型", placeholder: "paraformer-realtime-v2" },
  ],
  baidu_cloud: [
    { key: "baiduAppId", label: "App ID", placeholder: "百度 App ID（数字）" },
    { key: "baiduApiKey", label: "API Key", placeholder: "百度 API Key", secret: true },
    { key: "devPid", label: "dev_pid", placeholder: "1537（普通话模型）" },
  ],
};

const TEST_RESULT_LABELS: Record<SttConnectionTestResult, { label: string; cls: string }> = {
  connected: { label: "已连接", cls: "text-emerald-600 dark:text-emerald-400" },
  connected_no_speech: { label: "已连接（未识别到有效语音）", cls: "text-emerald-600 dark:text-emerald-400" },
  authentication_failed: { label: "鉴权失败", cls: "text-red-500" },
  protocol_failed: { label: "协议失败", cls: "text-red-500" },
  network_failed: { label: "网络失败", cls: "text-red-500" },
  timeout: { label: "超时", cls: "text-amber-500" },
};

export function SttSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<SttSettings | null>(null);
  const [clearSecrets, setClearSecrets] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ result: SttConnectionTestResult; message?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void loadSttSettings().then((loaded) => {
        if (!cancelled) setSettings(loaded);
      });
    };
    refresh();
    window.addEventListener("reinagent-stt-settings-changed", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("reinagent-stt-settings-changed", refresh);
    };
  }, []);

  if (!settings) {
    return (
      <div className="flex items-center justify-center py-16 text-xs text-[var(--text-dim)]">
        <Loader2 className="mr-2 size-4 animate-spin" />
        {t("sttLoading")}
      </div>
    );
  }

  const provider = settings.provider;
  const providerSettings = provider ? settings.providers[provider] : null;

  const patchProvider = (patch: Partial<SttProviderSettings>) => {
    if (!provider) return;
    setSettings((prev) =>
      prev
        ? {
            ...prev,
            providers: {
              ...prev.providers,
              [provider]: { ...prev.providers[provider], ...patch },
            },
          }
        : prev,
    );
  };

  const handleSave = async () => {
    if (!settings) return;
    setError(null);
    // 保存前按 LiveAgent 规则校验当前选中供应商
    if (settings.provider) {
      const problem = validateProvider(settings.provider, settings.providers[settings.provider]);
      if (problem) {
        setError(problem);
        return;
      }
    }
    setSaving(true);
    try {
      const next: SttSettings = {
        ...settings,
        providers: Object.fromEntries(
          Object.entries(settings.providers).map(([id, p]) => [
            id,
            clearSecrets && id === settings.provider
              ? { ...p, apiKey: "", secretId: "", secretKey: "", accessToken: "", baiduApiKey: "" }
              : p,
          ]),
        ) as Record<SttProviderId, SttProviderSettings>,
      };
      const saved = await saveSttSettings(next);
      setSettings(saved);
      setClearSecrets(false);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err).slice(0, 200));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!provider || !providerSettings) return;
    const problem = validateProvider(provider, providerSettings);
    if (problem) {
      setTestResult({ result: "protocol_failed", message: problem });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await invoke<{ result: SttConnectionTestResult; message?: string }>("settings_test_stt", {
        provider,
        config: runtimeConfig(providerSettings),
      });
      setTestResult(res);
    } catch (err) {
      setTestResult({ result: "protocol_failed", message: String(err instanceof Error ? err.message : err).slice(0, 240) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-5">
      <h2 className="mb-6 text-xl font-semibold">{t("sttTitle")}</h2>

      {/* 总开关 + 供应商 */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-4 space-y-4">
        <label className="flex items-center justify-between">
          <span className="text-sm font-medium">{t("sttEnabled")}</span>
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
            className="size-4 accent-[var(--brand)]"
          />
        </label>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-[var(--text-dim)]">{t("sttProvider")}</label>
          <Select
            value={provider ?? "none"}
            onValueChange={(v) =>
              setSettings({
                ...settings,
                provider: v === "none" ? null : (v as SttProviderId),
                providers: v !== "none" && !settings.providers[v as SttProviderId]
                  ? { ...settings.providers, [v as SttProviderId]: defaultSttProvider(v as SttProviderId) }
                  : settings.providers,
              })
            }
          >
            <SelectTrigger className="h-9 w-72 rounded-lg px-3 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t("sttProviderNone")}</SelectItem>
              {STT_PROVIDER_IDS.map((id) => (
                <SelectItem key={id} value={id}>
                  {PROVIDER_LABELS[id]}
                  {isProviderConfigured(id, settings.providers[id]) ? " ✓" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* 供应商表单 */}
      {provider && providerSettings ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-4 space-y-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Mic className="size-4 text-[var(--text-dim)]" />
            {PROVIDER_LABELS[provider]}
            <span className={`text-[11px] font-normal ${isProviderConfigured(provider, providerSettings) ? "text-emerald-600 dark:text-emerald-400" : "text-[var(--text-dim)]"}`}>
              {isProviderConfigured(provider, providerSettings) ? t("sttConfigured") : t("sttNotConfigured")}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {PROVIDER_FIELDS[provider].map((field) => (
              <div key={String(field.key)} className="space-y-1.5">
                <label className="text-xs font-medium text-[var(--text-dim)]">{field.label}</label>
                <Input
                  variant="plain"
                  type={field.secret ? "password" : "text"}
                  value={String(providerSettings[field.key] ?? "")}
                  placeholder={field.placeholder}
                  onChange={(e) => patchProvider({ [field.key]: e.currentTarget.value } as Partial<SttProviderSettings>)}
                />
              </div>
            ))}
          </div>
          {/* 高级：WebSocket 端点（有默认值，一般无需改动） */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[var(--text-dim)]">{t("sttWebsocketUrl")}</label>
            <Input
              variant="plain"
              value={providerSettings.websocketUrl}
              placeholder="wss://"
              onChange={(e) => patchProvider({ websocketUrl: e.currentTarget.value })}
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-[var(--text-dim)]">
            <input
              type="checkbox"
              checked={clearSecrets}
              onChange={(e) => setClearSecrets(e.target.checked)}
              className="size-3.5 accent-[var(--brand)]"
            />
            {t("sttClearSecrets")}
          </label>
        </div>
      ) : null}

      {/* 保存 / 连接测试 */}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={saving} onClick={() => void handleSave()}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {t("sttSave")}
        </Button>
        <Button size="sm" variant="outline" disabled={testing || !provider} onClick={() => void handleTest()}>
          {testing ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {t("sttTest")}
        </Button>
        {testResult ? (
          <span className={`text-xs ${TEST_RESULT_LABELS[testResult.result].cls}`}>
            {TEST_RESULT_LABELS[testResult.result].label}
            {testResult.message ? `：${testResult.message}` : ""}
          </span>
        ) : null}
        {error ? <span className="text-xs text-red-500">{error}</span> : null}
      </div>

      <p className="text-[11px] leading-relaxed text-[var(--text-dim)]">{t("sttHint")}</p>
    </div>
  );
}
