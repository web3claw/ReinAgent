/**
 * IM 渠道接入状态（ReinBot 工牌三图标，2026-10-31）：
 * QQ（OneBot 11）/ 微信（iLink 个人号 Bot）/ 飞书（自定义机器人）的
 * 配置 + 真实连通状态，kv `reinagent-reinbot-im-channels` 持久化。
 *
 * 铁律：status === "connected" 只能由真实连通测试（Rust im_* 命令）通过后写入；
 * 失败时保留原始错误原文（error 字段），弹窗如实展示，绝不静默清掉或伪装成功。
 */
import { create } from "zustand";
import { kvGetJSON, kvSetJSON } from "../lib/storage/db";

export const IM_CHANNELS_KV_KEY = "reinagent-reinbot-im-channels";

export type ImPlatform = "qq" | "wechat" | "feishu";

export type ImChannelStatus = "not_configured" | "connected" | "error";

export interface ImChannelConfig {
  status: ImChannelStatus;
  /** 最近一次真实连通成功时间（ISO 字符串）。 */
  connectedAt?: string;
  /** 最近一次测试失败的原始错误（如实展示，No-Fallback）。 */
  error?: string;
  // ---- QQ（官方机器人开放平台 q.qq.com/qqbot；OneBot 个人号模式已移除） ----
  /** 官方平台 AppID。 */
  appId?: string;
  /** 官方平台 AppSecret（机器人密钥）。access_token 不落盘。 */
  appSecret?: string;
  /** 测试成功时的机器人用户名（/users/@me）。 */
  botUsername?: string;
  // ---- 微信（iLink） ----
  botToken?: string;
  baseUrl?: string;
  /** 扫码人的 iLink 用户 ID（confirmed 轮询返回，getconfig 必需）。 */
  ilinkUserId?: string;
  // ---- 飞书（应用机器人，webhook 自定义机器人模式已移除）——复用上方 appId/appSecret/botUsername ----
}

const emptyConfig: ImChannelConfig = { status: "not_configured" };

interface ImChannelsState {
  channels: Record<ImPlatform, ImChannelConfig>;
  /** QQ 官方网关（qqbot_gateway.rs）运行态：在线 = 凭据有效 + WS 已连接。 */
  qqGatewayOnline: boolean;
  /** 微信 iLink 网关（wechat_gateway.rs）运行态。 */
  wechatGatewayOnline: boolean;
  /** 飞书应用机器人网关（feishu_gateway.rs）运行态。 */
  feishuGatewayOnline: boolean;
  /** 最近一次消息管道错误（运行时，不落盘）。 */
  qqGatewayLastError?: string;
  /** 保存（覆盖）某平台配置与状态并落盘。 */
  setChannel: (platform: ImPlatform, config: ImChannelConfig) => void;
  /** 清空某平台（断开连接）。 */
  clearChannel: (platform: ImPlatform) => void;
  setQqGatewayOnline: (online: boolean) => void;
  setWechatGatewayOnline: (online: boolean) => void;
  setFeishuGatewayOnline: (online: boolean) => void;
  setQqGatewayLastError: (err?: string) => void;
  /**
   * 从 kv 缓存重读渠道配置。模块求值时 kv 缓存尚未由 main.tsx 的
   * initStorage 水合（同 hubSettingsStore 陷阱），必须在 App 挂载后调用。
   */
  rehydrate: () => void;
}

function loadInitial(): Record<ImPlatform, ImChannelConfig> {
  const saved = kvGetJSON<Partial<Record<ImPlatform, ImChannelConfig>>>(IM_CHANNELS_KV_KEY);
  return {
    qq: saved?.qq ?? emptyConfig,
    wechat: saved?.wechat ?? emptyConfig,
    feishu: saved?.feishu ?? emptyConfig,
  };
}

function persist(channels: Record<ImPlatform, ImChannelConfig>) {
  kvSetJSON(IM_CHANNELS_KV_KEY, channels);
}

export const useImChannelsStore = create<ImChannelsState>((set, get) => ({
  channels: loadInitial(),
  qqGatewayOnline: false,
  wechatGatewayOnline: false,
  feishuGatewayOnline: false,

  setChannel: (platform, config) => {
    const next = { ...get().channels, [platform]: config };
    persist(next);
    set({ channels: next });
  },

  clearChannel: (platform) => {
    const next = { ...get().channels, [platform]: emptyConfig };
    persist(next);
    set({ channels: next, ...(platform === "qq" ? { qqGatewayOnline: false } : {}), ...(platform === "wechat" ? { wechatGatewayOnline: false } : {}), ...(platform === "feishu" ? { feishuGatewayOnline: false } : {}) });
  },

  setQqGatewayOnline: (online) => set({ qqGatewayOnline: online }),
  setWechatGatewayOnline: (online) => set({ wechatGatewayOnline: online }),
  setFeishuGatewayOnline: (online) => set({ feishuGatewayOnline: online }),
  setQqGatewayLastError: (err) => set({ qqGatewayLastError: err }),

  rehydrate: () => {
    const saved = kvGetJSON<Partial<Record<ImPlatform, ImChannelConfig>>>(IM_CHANNELS_KV_KEY);
    set({
      channels: {
        qq: saved?.qq ?? get().channels.qq,
        wechat: saved?.wechat ?? get().channels.wechat,
        feishu: saved?.feishu ?? get().channels.feishu,
      },
    });
  },
}));

export function isChannelConnected(config: ImChannelConfig | undefined): boolean {
  return config?.status === "connected";
}
