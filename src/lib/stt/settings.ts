/**
 * STT（语音输入）设置：类型、默认值、校验、读写。
 * 移植自 LiveAgent settings/index.ts 的 STT 部分 + stt.rs 的 validate_provider 规则。
 * 存储走本应用 settings.json 的 "stt" 键（tauri-plugin-store）。
 */

import type { SttProviderId, SttProviderSettings, SttSettings } from "./types";

export type { SttProviderId, SttProviderSettings, SttSettings };

export const STT_PROVIDER_IDS: readonly SttProviderId[] = [
  "tencent_cloud",
  "volcengine_seed_v3",
  "volcengine_v2",
  "aliyun_dashscope",
  "baidu_cloud",
];

const PROVIDER_DEFAULTS: Partial<Record<SttProviderId, Partial<SttProviderSettings>>> = {
  aliyun_dashscope: {
    websocketUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/inference/",
    model: "paraformer-realtime-v2",
  },
  volcengine_seed_v3: {
    websocketUrl: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
  },
  volcengine_v2: {
    websocketUrl: "wss://openspeech.bytedance.com/api/v2/asr",
  },
  baidu_cloud: {
    websocketUrl: "wss://vop.baidu.com/realtime_asr",
  },
};

export function defaultSttProvider(id: SttProviderId): SttProviderSettings {
  return {
    id,
    configured: false,
    websocketUrl: "",
    model: "",
    apiKey: "",
    appId: "",
    secretId: "",
    secretKey: "",
    accessToken: "",
    cluster: "",
    resourceId: "",
    engineModelType: "16k_zh",
    baiduAppId: "",
    baiduApiKey: "",
    devPid: "",
    ...(PROVIDER_DEFAULTS[id] ?? {}),
  };
}

export function getDefaultSttSettings(): SttSettings {
  return {
    enabled: false,
    provider: null,
    providers: Object.fromEntries(
      STT_PROVIDER_IDS.map((id) => [id, defaultSttProvider(id)]),
    ) as Record<SttProviderId, SttProviderSettings>,
  };
}

/** 密钥族字段（clearSecrets 一次性清空的目标）。 */
const SECRET_FIELDS = ["apiKey", "secretId", "secretKey", "accessToken", "baiduApiKey"] as const;

export function normalizeSttSettings(input: unknown): SttSettings {
  const defaults = getDefaultSttSettings();
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const provider = STT_PROVIDER_IDS.includes(obj.provider as SttProviderId)
    ? (obj.provider as SttProviderId)
    : null;
  const rawProviders =
    obj.providers && typeof obj.providers === "object"
      ? (obj.providers as Record<string, unknown>)
      : {};
  const providers = Object.fromEntries(
    STT_PROVIDER_IDS.map((id) => {
      const raw =
        rawProviders[id] && typeof rawProviders[id] === "object"
          ? (rawProviders[id] as Record<string, unknown>)
          : {};
      const merged = { ...defaults.providers[id] } as Record<string, unknown>;
      for (const key of Object.keys(merged)) {
        const value = raw[key];
        if (typeof value === "string") merged[key] = value;
      }
      merged.id = id;
      merged.configured = isProviderConfigured(id, merged as unknown as SttProviderSettings);
      // 一次性清密钥指令：消费即移除，不落盘
      if (raw.clearSecrets === true) {
        for (const field of SECRET_FIELDS) merged[field] = "";
      }
      return [id, merged as unknown as SttProviderSettings];
    }),
  ) as Record<SttProviderId, SttProviderSettings>;
  return { enabled: obj.enabled === true, provider, providers };
}

// ---------- 读写（settings.json 的 "stt" 键） ----------

const SETTINGS_FILE = "settings.json";
const STT_KEY = "stt";

export async function loadSttSettings(): Promise<SttSettings> {
  try {
    const mod = await import("@tauri-apps/plugin-store");
    const store = await mod.load(SETTINGS_FILE, { autoSave: true });
    return normalizeSttSettings(await store.get(STT_KEY));
  } catch (err) {
    console.warn("[stt] settings load failed:", err);
    return getDefaultSttSettings();
  }
}

export async function saveSttSettings(settings: SttSettings): Promise<SttSettings> {
  const normalized = normalizeSttSettings(settings);
  const mod = await import("@tauri-apps/plugin-store");
  const store = await mod.load(SETTINGS_FILE, { autoSave: true });
  await store.set(STT_KEY, normalized);
  window.dispatchEvent(new CustomEvent("reinagent-stt-settings-changed"));
  return normalized;
}

// ---------- 校验（镜像 Rust validate_provider；传入前端表单即时反馈） ----------

export function validateProvider(
  providerId: SttProviderId | "",
  provider: SttProviderSettings,
): string | null {
  const text = (field: keyof SttProviderSettings) => String(provider[field] ?? "").trim();
  const requireText = (field: keyof SttProviderSettings, label: string): string | null =>
    text(field) ? null : `${label} 不能为空`;
  const requirePositiveInteger = (field: keyof SttProviderSettings, label: string): string | null => {
    const value = text(field);
    if (!/^\d+$/.test(value) || BigInt(value) <= 0n) return `${label} 必须是正整数`;
    return null;
  };
  const validateWebsocketUrl = (): string | null => {
    const endpoint = text("websocketUrl");
    if (!endpoint) return "WebSocket 地址 不能为空";
    try {
      const url = new URL(endpoint);
      if (url.protocol !== "wss:" || !url.host || url.username || url.password) {
        return "WebSocket 地址必须是完整的 wss:// 地址";
      }
      return null;
    } catch {
      return "WebSocket 地址必须是完整的 wss:// 地址";
    }
  };
  switch (providerId) {
    case "aliyun_dashscope": {
      for (const err of [validateWebsocketUrl(), requireText("model", "模型名称"), requireText("apiKey", "API Key")]) {
        if (err) return err;
      }
      return null;
    }
    case "tencent_cloud": {
      for (const err of [
        requirePositiveInteger("appId", "腾讯 AppId"),
        requireText("engineModelType", "腾讯引擎模型"),
        requireText("secretId", "腾讯 SecretId"),
        requireText("secretKey", "腾讯 SecretKey"),
      ]) {
        if (err) return err;
      }
      return null;
    }
    case "volcengine_v2": {
      for (const err of [
        validateWebsocketUrl(),
        requireText("appId", "火山 v2 App ID"),
        requireText("cluster", "火山 v2 Cluster"),
        requireText("accessToken", "火山 v2 Access Token"),
      ]) {
        if (err) return err;
      }
      return null;
    }
    case "volcengine_seed_v3": {
      for (const err of [
        validateWebsocketUrl(),
        requireText("appId", "火山 Seed v3 App ID"),
        requireText("accessToken", "火山 Seed v3 Access Token"),
        requireText("resourceId", "火山 Seed v3 Resource ID"),
      ]) {
        if (err) return err;
      }
      return null;
    }
    case "baidu_cloud": {
      for (const err of [
        validateWebsocketUrl(),
        requirePositiveInteger("baiduAppId", "百度 App ID"),
        requirePositiveInteger("devPid", "百度 dev_pid"),
        requireText("baiduApiKey", "百度 API Key"),
      ]) {
        if (err) return err;
      }
      return null;
    }
    default:
      return "未知 STT 供应商";
  }
}

export function isProviderConfigured(
  providerId: SttProviderId | null,
  provider: SttProviderSettings | null,
): boolean {
  if (!providerId || !provider) return false;
  return validateProvider(providerId, provider) === null;
}

/** 传给 Rust 的运行时配置（剥掉 UI 专用字段）。 */
export function runtimeConfig(provider: SttProviderSettings): Record<string, string> {
  return {
    websocketUrl: String(provider.websocketUrl ?? ""),
    model: String(provider.model ?? ""),
    apiKey: String(provider.apiKey ?? ""),
    appId: String(provider.appId ?? ""),
    secretId: String(provider.secretId ?? ""),
    secretKey: String(provider.secretKey ?? ""),
    accessToken: String(provider.accessToken ?? ""),
    cluster: String(provider.cluster ?? ""),
    resourceId: String(provider.resourceId ?? ""),
    engineModelType: String(provider.engineModelType ?? ""),
    baiduAppId: String(provider.baiduAppId ?? ""),
    baiduApiKey: String(provider.baiduApiKey ?? ""),
    devPid: String(provider.devPid ?? ""),
  };
}
