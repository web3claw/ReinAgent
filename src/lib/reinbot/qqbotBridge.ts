/**
 * IM 消息管道桥（2026-11-01）：QQ 官方网关（qqbot_gateway.rs）+ 微信 iLink 网关
 * （wechat_gateway.rs）→ 注入 ReinBot 会话 → 回发对应平台。
 *
 * - `qqbot-status` / `wechat-status` {online, detail} → store 在线态（图标点亮语义）；
 * - `qqbot-message` / `wechat-message` → 串行（promise 链）注入 ReinBot 会话
 *   （与 ReinBotPage 同 kv 历史、系统提示词），runAgentTurn 生成回复后
 *   渐进分段回发（平台无消息编辑接口，做不到真·流式）。
 * - **模型严格模式（用户拍板，零回退）**：只用 ReinBot 模型胶囊选中项，
 *   未选择/不可用 → 错误如实回显 IM 与页面。
 * - **页面实时同步**：每阶段经 CustomEvent `reinbot-qq-messages` 推完整列表。
 * - 失败如实 console.error + store lastErr，不静默吞掉（No-Fallback）。
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { kvGet, kvGetJSON, kvSetJSON } from "../storage/db";
import { useImChannelsStore, isChannelConnected } from "../../store/useImChannelsStore";
import { useAppStore } from "../../store/useAppStore";
import { runAgentTurn } from "../providers/runAgentTurn";
import { createReinBotTaskTool } from "./reinBotTools";
import { createClipTools } from "./clipTools";
import { parseModelKey } from "./modelKeyResolver";
import { loadProvidersConfigFromDisk } from "../../components/settings/model-provider/types";
import type { ProviderConfig } from "../providers/modelFactory";
import type { Message } from "@earendil-works/pi-ai";

const KV_REINBOT_MESSAGES_KEY = "reinagent-reinbot-messages";
const KV_REINBOT_MODEL_KEY = "reinagent-reinbot-selected-model";
const REINBOT_WORKSPACE_SUBDIR = "ReinBot";

/** 桥 → ReinBotPage 的实时同步事件名（载荷为完整消息列表）。 */
export const REINBOT_QQ_MESSAGES_EVENT = "reinbot-qq-messages";

type ImPlatform = "qq" | "wechat" | "feishu";

/** 与 ReinBotPage 的 ReinBotMessage 保持兼容的子集（via 标记来源渠道）。 */
interface BridgeMessage {
  id: string;
  sender: "user" | "bot";
  text: string;
  time: number;
  via?: ImPlatform;
}

/** Rust qqbot-message 事件负载。 */
interface QqBotIncomingMessage {
  source: string;
  groupOpenid?: string;
  userOpenid: string;
  messageId: string;
  content: string;
}

/** Rust wechat-message 事件负载。 */
interface WechatIncomingMessage {
  fromUserId: string;
  content: string;
  contextToken: string;
}

/** Rust feishu-message 事件负载。 */
interface FeishuIncomingMessage {
  messageId: string;
  chatType: string;
  chatId: string;
  senderOpenId: string;
  content: string;
}

let initialized = false;
let unlisteners: UnlistenFn[] = [];
let chain: Promise<void> = Promise.resolve();
let cachedWorkspaceRoot = "";

/** 应用启动即调用（幂等）：rehydrate 配置 → 自启已配置的网关 → 挂监听。 */
export async function initQqBotBridge(): Promise<void> {
  if (initialized || typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return;
  }
  initialized = true;

  // 模块求值期 kv 缓存可能尚未水合（hubSettingsStore 同款陷阱）——先重读再判断
  useImChannelsStore.getState().rehydrate();

  unlisteners.push(
    await listen<{ online: boolean; detail?: string }>("qqbot-status", (ev) => {
      useImChannelsStore.getState().setQqGatewayOnline(Boolean(ev.payload?.online));
    }),
  );
  unlisteners.push(
    await listen<{ online: boolean; detail?: string }>("wechat-status", (ev) => {
      useImChannelsStore.getState().setWechatGatewayOnline(Boolean(ev.payload?.online));
    }),
  );
  unlisteners.push(
    await listen<QqBotIncomingMessage>("qqbot-message", (ev) => {
      if (ev.payload?.messageId) {
        enqueue(handleQqIncoming(ev.payload));
      }
    }),
  );
  unlisteners.push(
    await listen<WechatIncomingMessage>("wechat-message", (ev) => {
      if (ev.payload?.fromUserId) {
        enqueue(handleWechatIncoming(ev.payload));
      }
    }),
  );
  unlisteners.push(
    await listen<{ online: boolean; detail?: string }>("feishu-status", (ev) => {
      useImChannelsStore.getState().setFeishuGatewayOnline(Boolean(ev.payload?.online));
    }),
  );
  unlisteners.push(
    await listen<FeishuIncomingMessage>("feishu-message", (ev) => {
      if (ev.payload?.messageId) {
        enqueue(handleFeishuIncoming(ev.payload));
      }
    }),
  );

  // 已配置的渠道 → 自动拉起网关（应用重启后自愈）
  const { channels } = useImChannelsStore.getState();
  const qq = channels.qq;
  if (isChannelConnected(qq) && qq.appId && qq.appSecret) {
    void startQqBotGateway(qq.appId, qq.appSecret).catch((err) =>
      console.error("[im-bridge] QQ 网关自启失败：", err),
    );
  }
  const wechat = channels.wechat;
  if (isChannelConnected(wechat) && wechat.botToken) {
    void startWechatGateway(wechat.botToken, wechat.baseUrl).catch((err) =>
      console.error("[im-bridge] 微信网关自启失败：", err),
    );
  }
  const feishu = channels.feishu;
  if (isChannelConnected(feishu) && feishu.appId && feishu.appSecret) {
    void startFeishuGateway(feishu.appId, feishu.appSecret).catch((err) =>
      console.error("[im-bridge] 飞书网关自启失败：", err),
    );
  }
}

export async function startQqBotGateway(appId: string, appSecret: string): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  await invoke("qqbot_gateway_start", { args: { app_id: appId, app_secret: appSecret } });
}

export async function stopQqBotGateway(): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  try {
    await invoke("qqbot_gateway_stop");
  } catch (err) {
    console.error("[im-bridge] 停止 QQ 网关失败：", err);
  }
}

export async function startWechatGateway(botToken: string, baseUrl?: string): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  await invoke("wechat_gateway_start", { args: { bot_token: botToken, base_url: baseUrl ?? null } });
}

export async function stopWechatGateway(): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  try {
    await invoke("wechat_gateway_stop");
  } catch (err) {
    console.error("[im-bridge] 停止微信网关失败：", err);
  }
}

export async function startFeishuGateway(appId: string, appSecret: string): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  await invoke("feishu_gateway_start", { args: { app_id: appId, app_secret: appSecret } });
}

export async function stopFeishuGateway(): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  try {
    await invoke("feishu_gateway_stop");
  } catch (err) {
    console.error("[im-bridge] 停止飞书网关失败：", err);
  }
}

function enqueue(task: Promise<void>) {
  chain = chain
    .then(() => task)
    .catch((err) => {
      console.error("[im-bridge] 消息处理失败：", err);
      useImChannelsStore.getState().setQqGatewayLastError(String(err));
    });
}

async function resolveWorkspaceRoot(): Promise<string> {
  if (cachedWorkspaceRoot) return cachedWorkspaceRoot;
  try {
    const home = await invoke<string>("path_home_dir");
    cachedWorkspaceRoot = `${home.replace(/[\\/]+$/, "")}/.ReinAgent/${REINBOT_WORKSPACE_SUBDIR}`;
  } catch {
    cachedWorkspaceRoot = `~/.ReinAgent/${REINBOT_WORKSPACE_SUBDIR}`;
  }
  return cachedWorkspaceRoot;
}

/**
 * 模型解析（严格模式，用户拍板：无任何回退）——
 * 只用 ReinBot 工作台模型胶囊选中的模型；未选择/供应商未启用/模型不存在都如实抛错。
 */
async function resolveModelConfigStrict(): Promise<ProviderConfig> {
  const providers = await loadProvidersConfigFromDisk().catch((err) => {
    throw new Error(`读取供应商配置失败：${err instanceof Error ? err.message : String(err)}`);
  });
  const selectedKey = (kvGet(KV_REINBOT_MODEL_KEY) || "").trim();
  if (!selectedKey) {
    throw new Error("未选择模型：请在 ReinBot 工作台的模型胶囊中选择后再次发消息（IM 回复严格使用所选模型，不做回退）");
  }
  const parsed = parseModelKey(selectedKey);
  if (!parsed) {
    throw new Error(`模型选择无效（${selectedKey}），请重新在模型胶囊中选择`);
  }
  const provider = providers.find((x) => x.id === parsed.providerId);
  if (!provider || !provider.enabled) {
    throw new Error(`所选模型的供应商未启用：${parsed.providerId}，请在模型胶囊中重新选择`);
  }
  const model = provider.models.find((m) => m.id === parsed.modelId);
  if (!model) {
    throw new Error(`所选模型不存在于供应商中：${parsed.modelId}，请在模型胶囊中重新选择`);
  }
  return {
    provider: provider.id as ProviderConfig["provider"],
    apiKey: provider.apiKey,
    modelId: model.id,
    baseUrl: provider.baseUrl,
    apiFormat: provider.apiFormat,
    supportsImage: model.supportsImage ?? null,
    contextWindow: model.contextWindow ?? null,
    maxOutputTokens: model.maxOutputTokens ?? null,
  };
}

/** 把完整消息列表实时推给 ReinBotPage。 */
function emitMessages(messages: BridgeMessage[]): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(REINBOT_QQ_MESSAGES_EVENT, { detail: { messages } }));
}

/** 平台无关的 IM 回合管道：注入会话 → LLM → 渐进分段回发 + 页面实时同步。 */
async function runImTurn(params: {
  platform: ImPlatform;
  userText: string;
  /** 平台发送三件套：notify=中间态回执（不占额度或平台允许）；send=被动回复；quotaLeft=剩余额度。 */
  im: {
    notify: (text: string) => Promise<void>;
    send: (content: string) => Promise<void>;
    quotaLeft: () => number;
  };
  /** 发送模式：progressive=流式分段（QQ）；single=整条一次（微信——context_token 疑似一次性，多条复用会失败）。 */
  sendMode: "progressive" | "single";
}): Promise<void> {
  const { platform, userText, im, sendMode } = params;
  const store = useImChannelsStore.getState();
  const reinBotName = useAppStore.getState().reinBotName || "ReinBot";
  const workspaceRoot = await resolveWorkspaceRoot();

  const history = kvGetJSON<BridgeMessage[]>(KV_REINBOT_MESSAGES_KEY) ?? [];
  const userMsg: BridgeMessage = {
    id: `im-${platform}-${Date.now()}`,
    sender: "user",
    text: userText,
    time: Date.now(),
    via: platform,
  };
  const botMsgId = `im-bot-${platform}-${Date.now() + 1}`;
  const publish = (botText: string): BridgeMessage[] => {
    const list: BridgeMessage[] = [
      ...history,
      userMsg,
      { id: botMsgId, sender: "bot", text: botText, time: Date.now() + 1 },
    ];
    kvSetJSON(KV_REINBOT_MESSAGES_KEY, list);
    emitMessages(list);
    return list;
  };
  publish("");

  let config: ProviderConfig;
  try {
    config = await resolveModelConfigStrict();
  } catch (err) {
    const errText = `⚠️ ${err instanceof Error ? err.message : String(err)}`;
    publish(errText);
    await im.send(errText.slice(0, 450));
    store.setQqGatewayLastError(errText);
    return;
  }

  // —— 确定性预抓取（2026-11-02 用户反馈修复）——
  // 模型有时跳过 fetch_article 直接凭记忆编造内容（实测发生过：链接是 Skill/MCP 那篇，
  // 总结成 FlashAttention）。**当整条消息只是一条 URL 时，由程序直接抓取**，
  // 把真实正文注入上下文；模型只负责总结，无编造空间。
  let prefetched: { url: string; title: string; text: string; site: string } | null = null;
  {
    const bare = userText.trim();
    const urlMatch = bare.match(/^https?:\/\/\S+$/);
    const urlInSentence = bare.match(/https?:\/\/\S+/);
    const looksLikeClipIntent =
      !!urlMatch ||
      (/收藏|归档|总结|分析|看一?下|clip/i.test(bare) && !!urlInSentence);
    if (looksLikeClipIntent && urlInSentence) {
      const targetUrl = urlInSentence[0].replace(/[，。；、！？）)】\]]+$/, "");
      try {
        const article = await invoke<{
          title: string;
          site: string;
          text: string;
          charCount: number;
        }>("im_article_fetch", { args: { url: targetUrl } });
        prefetched = {
          url: targetUrl,
          title: article.title,
          text: article.text,
          site: article.site,
        };
      } catch (err) {
        // 抓取失败如实告知（绝不编造）；把错误注入上下文让模型照实回执
        prefetched = null;
        const reason = err instanceof Error ? err.message : String(err);
        publish(`⚠️ 抓取失败：${reason}`);
        await im.send(`⚠️ 抓取失败：${reason.slice(0, 400)}`);
        store.setQqGatewayLastError(reason);
        return;
      }
    }
  }

  const systemPrompt = [
    `你叫 ${reinBotName}，是 ReinAgent 桌面端内的专属本地主动型自主智能体（Chief of Staff / 研发总管）。`,
    "你的使命与职责：",
    "1. 协助用户规划、拆解工程任务，分析本地代码，审阅 PR，解答技术疑问与统筹交付产物；",
    `2. 你的默认专属独立工作区与工作产物路径均为：${workspaceRoot}。生成的代码方案、分析报告、调研文档等产物统一存放于该目录下；`,
    "3. 遇到代码编写、Bug 排查或长程工程任务，先梳理出清晰的执行规划，给出专业见解；",
    "4. 你拥有创建新任务的专属工具 create_task。当用户要求新建、规划、创建或派发新任务时，请主动调用 create_task 工具创建任务，并在回复中使用 @任务[任务名] 格式汇报；",
    "5. 始终使用与用户相同的语言（默认中文），语气亲切可靠、专业干练。",
    "6. 当前消息来自 IM 渠道（QQ 或微信），回复会被原样发回：请精炼作答（避免超长输出），不要输出无法在 IM 呈现的复杂排版。",
    "7. 链接收藏能力：用户单独发来网页链接（或明确要求收藏/总结某链接）时，先调用 fetch_article 抓取正文，基于正文总结（核心观点/关键要点/可行动项，简洁 markdown），再调用 save_clip 落盘（tags 按内容自拟 2-4 个），最后回执：总结要点 + 保存路径。链接只是回答问题的参考资料时，按普通问题处理，不必落盘。",
    "8. 工具调用失败时（如网页抓取失败），必须如实告知用户失败原因，严禁声称已成功、严禁编造正文内容。",
    prefetched
      ? `\n【已抓取的文章正文】（用户消息里的链接由系统预先抓取，以下是真实内容，请严格基于它总结，禁止使用你记忆中的任何其他文章内容）\n标题：${prefetched.title}\n来源：${prefetched.url}\n\n${prefetched.text}`
      : "",
    prefetched
      ? "9. 上面已提供真实正文：请直接基于它写总结（核心观点/关键要点/可行动项），然后立刻调用 save_clip 落盘（title 用上面给的标题、source_url 用上面给的来源），最后如实回执保存路径。不要再调用 fetch_article。"
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const agentMessages: Message[] = [...history, userMsg].map((m) =>
    m.sender === "user"
      ? { role: "user", content: m.text, timestamp: m.time }
      : {
          role: "assistant",
          content: [{ type: "text", text: m.text }],
          api: "openai",
          provider: config.provider,
          model: config.modelId,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: m.time,
        } as Message,
  );

  let finalText = "";
  let didSendContent = false;
  // —— 渐进分段发送：平台无消息编辑接口，做不到真·流式；
  // 流式中每逢换行且累积 ≥80 字即发一条（每平台 ≤maxChunks 条 × ≤450 字）。
  const REPLY_CHARS = 450;
  const FLUSH_MIN_CHARS = 80;
  let sentChars = 0;
  let sendChain: Promise<void> = Promise.resolve();
  const sendPieceOrdered = (content: string): Promise<void> => {
    if (im.quotaLeft() <= 0 || !content.trim()) return sendChain;
    didSendContent = true;
    sendChain = sendChain.then(async () => {
      try {
        await im.send(content);
        // 轻微间隔，降低连续触发平台频控的风险
        await new Promise((r) => setTimeout(r, 300));
      } catch (err) {
        console.error("[im-bridge] 回复发送失败：", err);
        store.setQqGatewayLastError(String(err));
      }
    });
    return sendChain;
  };
  const flushParagraphs = () => {
    if (sendMode !== "progressive") return;
    if (im.quotaLeft() <= 0) return;
    const pendingText = finalText.slice(sentChars);
    const nl = pendingText.lastIndexOf("\n");
    if (nl >= FLUSH_MIN_CHARS) {
      const flushLen = Math.min(nl, REPLY_CHARS);
      void sendPieceOrdered(pendingText.slice(0, flushLen));
      sentChars += flushLen + (pendingText[flushLen] === "\n" ? 1 : 0);
    }
  };

  try {
    await runAgentTurn({
      source: config.provider as never,
      config,
      messages: agentMessages,
      systemPrompt,
      workspaceRoot,
      extraTools: [
        createReinBotTaskTool({
          defaultProject: workspaceRoot,
          providerId: config.provider,
          modelId: config.modelId,
          onTaskCreated: () => {},
          onDispatchTask: () => {},
        }),
        ...createClipTools({ notify: im.notify, channel: platform }),
      ],
      signal: new AbortController().signal,
      onEvent: (ev) => {
        if (ev.type === "message_update" && ev.message) {
          const raw = (ev.message as { content?: unknown }).content;
          const text = Array.isArray(raw)
            ? raw
                .filter((c) => (c as { type?: string; text?: unknown }).type === "text")
                .map((c) => String((c as { text?: unknown }).text ?? ""))
                .join("")
            : typeof raw === "string"
              ? raw
              : "";
          if (text) {
            finalText = text;
            // 流式实时推给 ReinBotPage（与桌面端打字效果同步）
            publish(finalText);
            flushParagraphs();
          }
        }
      },
    });

    if (!finalText.trim()) {
      throw new Error("模型未返回文本回复");
    }
  } catch (err) {
    // LLM 失败/中断：错误如实进页面气泡；IM 侧——一条都没发出去才发错误提示，
    // 已渐进发出部分内容的不再补发错误（避免打断已收到的分段）。
    const errText = `⚠️ ${err instanceof Error ? err.message : String(err)}`;
    publish(errText);
    if (!didSendContent) {
      await sendPieceOrdered(errText.slice(0, REPLY_CHARS));
      await sendChain;
    }
    store.setQqGatewayLastError(errText);
    return;
  }

  // 最终落盘 + 推送（含本次 IM 交互）
  publish(finalText);

  if (sendMode === "single") {
    // 微信：context_token 疑似一次性（同一 token 复用多条会失败），整条一次发送
    let full = finalText.slice(sentChars);
    if (full.length > 2000) {
      full = full.slice(0, 2000) + "\n…（后续内容已省略）";
    }
    if (full.trim()) {
      await im.send(full);
    }
    return;
  }

  // 发送剩余部分（最后一条装不下则截断标注）
  let remaining = finalText.slice(sentChars);
  while (remaining.trim() && im.quotaLeft() > 0) {
    const isLastAllowed = im.quotaLeft() === 1;
    let piece = remaining.slice(0, REPLY_CHARS);
    remaining = remaining.slice(REPLY_CHARS);
    if (isLastAllowed && remaining.length > 0) {
      piece += `\n…（后续内容已省略）`;
      remaining = "";
    }
    await sendPieceOrdered(piece);
  }
  await sendChain;
}

async function handleQqIncoming(msg: QqBotIncomingMessage): Promise<void> {
  const qq = useImChannelsStore.getState().channels.qq;
  if (!qq.appId || !qq.appSecret) {
    throw new Error("QQ 凭据缺失，无法回复");
  }
  // 被动回复额度：每条 msg_id 最多 5 条（notify 也占额度）
  const QQ_MAX = 5;
  let used = 0;
  const sendWithSeq = async (content: string) => {
    const seq = used + 1;
    used = seq;
    await invoke("im_qqbot_send", {
      args: {
        app_id: qq.appId,
        app_secret: qq.appSecret,
        target: msg.source,
        target_openid: msg.source === "group" ? msg.groupOpenid ?? "" : msg.userOpenid,
        msg_id: msg.messageId,
        msg_seq: seq,
        content,
      },
    });
  };
  await runImTurn({
    platform: "qq",
    userText: msg.content,
    sendMode: "progressive",
    im: {
      notify: async (text) => {
        if (used >= QQ_MAX) return;
        await sendWithSeq(text);
      },
      send: async (content) => {
        if (used >= QQ_MAX) return;
        await sendWithSeq(content);
      },
      quotaLeft: () => QQ_MAX - used,
    },
  });
}

/** 微信不渲染 markdown：发送前转为纯文本（对齐 openclaw-weixin 的处理）。 */
function wechatPlainText(text: string): string {
  let r = text;
  r = r.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim());
  r = r.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  r = r.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  r = r.replace(/^\|[\s:|-]+\|$/gm, "");
  r = r.replace(/^\|(.+)\|$/gm, (_, inner: string) =>
    inner.split("|").map((c: string) => c.trim()).join("  "),
  );
  r = r.replace(/\*\*([^*]+)\*\*/g, "$1");
  return r;
}

async function handleFeishuIncoming(msg: FeishuIncomingMessage): Promise<void> {
  const feishu = useImChannelsStore.getState().channels.feishu;
  if (!feishu.appId || !feishu.appSecret) {
    throw new Error("飞书 AppID/AppSecret 缺失，无法回复");
  }
  const replyFeishu = async (content: string) => {
    await invoke("im_feishu_reply", {
      args: {
        app_id: feishu.appId ?? "",
        app_secret: feishu.appSecret ?? "",
        message_id: msg.messageId,
        content,
      },
    });
  };
  await runImTurn({
    platform: "feishu",
    userText: msg.content,
    sendMode: "single",
    im: {
      // 中间态 = 直接回一条「正在处理」（reply API 无每消息条数上限）
      notify: async (text) => {
        await replyFeishu(text).catch((err) =>
          console.warn("[im-bridge] 飞书中间态回执失败（忽略）：", err),
        );
      },
      send: async (content) => {
        await replyFeishu(content);
      },
      quotaLeft: () => 999,
    },
  });
}

async function handleWechatIncoming(msg: WechatIncomingMessage): Promise<void> {
  const wechat = useImChannelsStore.getState().channels.wechat;
  if (!wechat.botToken) {
    throw new Error("微信 bot_token 缺失，无法回复");
  }
  await runImTurn({
    platform: "wechat",
    userText: msg.content,
    sendMode: "single",
    im: {
      // 中间态 = 「对方正在输入」指示（不占被动回复额度，失败尽力忽略）
      notify: async () => {
        const ilinkUserId = useImChannelsStore.getState().channels.wechat.ilinkUserId ?? "";
        if (!ilinkUserId) return;
        await invoke("wechat_typing_notify", {
          args: {
            bot_token: wechat.botToken ?? "",
            base_url: wechat.baseUrl ?? null,
            ilink_user_id: ilinkUserId,
          },
        }).catch((err) => console.warn("[im-bridge] 微信 typing 失败（忽略）：", err));
      },
      send: async (content) => {
        await invoke("im_wechat_send", {
          args: {
            bot_token: wechat.botToken ?? "",
            base_url: wechat.baseUrl ?? null,
            to_user_id: msg.fromUserId,
            context_token: msg.contextToken,
            content: wechatPlainText(content),
          },
        });
      },
      quotaLeft: () => 1,
    },
  });
}
