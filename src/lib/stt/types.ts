/**
 * STT 运行时类型（移植自 LiveAgent agent-ui/src/lib/stt/types.ts）。
 * 与 LiveAgent 的差异：open 时随参传供应商配置（桌面单用户，配置在前端）。
 */

export type SttProviderId =
  | "aliyun_dashscope"
  | "tencent_cloud"
  | "volcengine_v2"
  | "volcengine_seed_v3"
  | "baidu_cloud";

export type SttProviderSettings = {
  id: SttProviderId;
  configured: boolean;
  websocketUrl: string;
  model: string;
  apiKey: string;
  appId: string;
  secretId: string;
  secretKey: string;
  accessToken: string;
  cluster: string;
  resourceId: string;
  engineModelType: string;
  baiduAppId: string;
  baiduApiKey: string;
  devPid: string;
  /** 一次性清密钥指令；保存端消费后必须移除，不得进入公开快照。 */
  clearSecrets?: boolean;
};

export type SttSettings = {
  enabled: boolean;
  provider: SttProviderId | null;
  providers: Record<SttProviderId, SttProviderSettings>;
};

export type SttUiState =
  | "idle"
  | "requesting-permission"
  | "buffering"
  | "recognizing"
  | "stopping"
  | "error";

export type SttRuntimeEvent =
  | { type: "ready"; sessionId: string }
  | { type: "partial"; sessionId: string; text: string }
  | { type: "final"; sessionId: string; text: string }
  | { type: "error"; sessionId: string; code: string; message: string }
  | { type: "closed"; sessionId: string };

export type SttTransportOpenOptions = {
  sessionId: string;
  provider: SttProviderId;
  /** 供应商运行时配置（settings.ts 的 runtimeConfig 产物）。 */
  config: Record<string, string>;
  onEvent: (event: SttRuntimeEvent) => void;
};

export interface SttTransport {
  requestPermission?: () => Promise<void>;
  open: (options: SttTransportOpenOptions) => Promise<void>;
  sendAudio: (sessionId: string, sequence: number, pcm: Uint8Array) => Promise<void>;
  stop: (sessionId: string) => Promise<void>;
  cancel: (sessionId: string) => Promise<void>;
  dispose?: () => void;
}

export type SttConnectionTestResult =
  | "connected"
  | "connected_no_speech"
  | "authentication_failed"
  | "protocol_failed"
  | "network_failed"
  | "timeout";

export type SttConnectionTestResponse = {
  result: SttConnectionTestResult;
  message?: string;
};

export type SttSecretField = Extract<
  keyof SttProviderSettings,
  "apiKey" | "secretId" | "secretKey" | "accessToken" | "baiduApiKey"
>;

export interface SttSettingsService {
  get: () => Promise<SttSettings>;
  update: (settings: SttSettings) => Promise<SttSettings>;
  test: (
    provider: SttProviderId,
    config: Record<string, string>,
  ) => Promise<SttConnectionTestResponse>;
}

