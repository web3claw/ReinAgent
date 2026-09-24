/**
 * fauxSource —— 合成数据源（演示模式）。
 *
 * 使用 pi-ai 的 faux provider 产生**真实形态**的事件流（内部会分块 push
 * `start → text_start → 多个 text_delta → text_end → done`；工具轮还会 push
 * `toolcall_start/delta/end`），因此 UI 的流式渲染路径与真实调用完全一致，
 * 只是数据来自脚本。
 *
 * S7-5 起唯一对外入口是 `getFauxAgentSource()`：它返回一个**provider 级 `stream`**，
 * 供 pi-agent-core 的 `Agent` 循环按需调用（`runAgentTurn` → `agentRuntime.runTurn`）。
 * 一次性入口 `streamFaux` 与旧的 `streamChat` 已于 S7-5 收尾时删除（无人调用）。
 */

import type { Message, Model, TranscriptContext } from "@earendil-works/pi-ai";
import type { ProviderStreamFn } from "../agent/streamFnAdapter";

type FauxModule = typeof import("@earendil-works/pi-ai/providers/faux");
type FauxCore = ReturnType<FauxModule["createFauxCore"]>;

/**
 * 演示流的节奏：调低 tokensPerSecond、调细 tokenSize，
 * 让界面能明显看到「逐字」效果。
 */
const FAUX_TOKENS_PER_SECOND = 50;
const FAUX_TOKEN_SIZE = { min: 1, max: 4 };

/** 演示工具调用的固定 id（确定性：每轮脚本不依赖随机/时间）。 */
const FAUX_TOOL_CALL_ID = "faux-call-1";

/** 演示模式下调用的工具名（与 `tools.js` 注册的 `get_current_time` 对齐）。 */
const FAUX_TOOL_NAME = "list_dir";

let fauxModule: Promise<FauxModule> | null = null;
let fauxCore: Promise<FauxCore> | null = null;

function loadFauxModule(): Promise<FauxModule> {
  if (fauxModule === null) {
    fauxModule = import("@earendil-works/pi-ai/providers/faux");
  }
  return fauxModule;
}

/**
 * 单例 faux core。
 * 显式传 `api: "faux"`，使其与 `fauxAssistantMessage()` 内置的 DEFAULT_API 对齐，
 * 保证 `core.api === model.api === message.api`（S1 已实测确认这一 seam）。
 */
function loadFauxCore(): Promise<FauxCore> {
  if (fauxCore === null) {
    fauxCore = loadFauxModule().then((faux) =>
      faux.createFauxCore({
        api: "faux",
        tokensPerSecond: FAUX_TOKENS_PER_SECOND,
        tokenSize: FAUX_TOKEN_SIZE,
      }),
    );
  }
  return fauxCore;
}

/** 取最后一条用户消息的纯文本。 */
function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "user") {
      return typeof message.content === "string" ? message.content : "";
    }
  }
  return "";
}

/** 传入的转录里是否已经存在工具结果。 */
function hasToolResult(messages: Message[]): boolean {
  return messages.some((message) => message !== null && typeof message === "object" && message.role === "toolResult");
}

/** 构造演示回复（刻意写明「合成数据」，避免被误认成真实能力）。 */
function buildDemoReply(prompt: string): string {
  const question = prompt.trim().length > 0 ? prompt.trim() : "（空消息）";
  return (
    `[演示模式 · 合成数据] 你刚才说：「${question}」。\n` +
    "这条回复由 pi-ai 的 faux provider 合成，没有连接任何真实模型，也不会产生费用。\n" +
    "在顶部的输入框填入 DeepSeek API Key 后，这里会换成真实模型的流式输出。"
  );
}

/** S7：agent 循环所需的 faux 数据源形状（与 `runAgentTurn` 的 faux 分支一一对应）。 */
export interface FauxAgentSource {
  /** faux core 的当前模型（`Model<string>`，其 `api === "faux"`，与 S7-1 适配器期望对齐）。 */
  model: Model<string>;
  /** provider 级 stream（**已规范化**的 TranscriptContext 直接透传，本函数不再 normalize）。 */
  stream: ProviderStreamFn;
  /** 该 provider 级 stream 期望的 api 字符串（`"faux"`）。 */
  api: string;
  /** 出错信息里的来源标识。 */
  label: string;
}

/**
 * 为 S7 的 agent 循环提供 faux 数据源（S7-5）。
 *
 * 本函数返回一个 **provider 级 `stream`**，供 pi-agent-core 的循环**按需多次**调用
 * （多步工具循环每轮都会调一次）。因此合成回复在 `stream` **每次调用时**按传入
 * context 重设，**不依赖跨调用的残留状态**（确定性）。
 *
 * ★ 演示模式「首轮先调工具、次轮再回文本」（S7-5 收尾）：
 *   此前无 Key 的演示模式永远只回文本 ⇒ S7 的**工具闭环在界面上完全不可见**
 *   （S7-6 的工具卡片没法手动验、用户也看不到这条能力）。改成：
 *     - 若 `context.messages` 里**已存在 `role === "toolResult"`** 的消息
 *       （即本轮工具已执行完）→ 返回**文本**回复（`buildDemoReply(末条 user 文本)`，文案逐字不变）；
 *     - **否则** → 返回一条**带 `toolCall` 的 assistant**（`get_current_time`、`{}`、
 *       固定 id `"faux-call-1"`）并配一小段 thinking。
 *   这样一次用户回合就是「工具调用 → 工具结果 → 文本答案」的完整闭环，
 *   同时给了 `runAgentTurn` 一个**可脚本化**的工具测试缝。
 *
 * ⚠️ 传给这里的 `context` 已由 pi-agent-core 规范化（内含首条 system 消息），
 *    故**不再调用** `normalizeContext`（重复规范化是明确禁止的）。
 *
 * @returns {Promise<FauxAgentSource>} 供 `runTurn` 使用的 model / stream / api / label。
 */
export async function getFauxAgentSource(): Promise<FauxAgentSource> {
  const faux = await loadFauxModule();
  const core = await loadFauxCore();

  const stream: ProviderStreamFn = (model, context: TranscriptContext, options) => {
    // 每次都重设脚本（确定性：不读上一次调用的残留响应队列）。
    const prompt = lastUserText(context.messages);

    if (hasToolResult(context.messages)) {
      // 次轮：工具已执行完 → 给出文本答案（文案与既有演示回复逐字一致）。
      core.setResponses([
        faux.fauxAssistantMessage([
          faux.fauxThinking("（演示模式）我正在合成一段回复，内容不来自真实模型。"),
          faux.fauxText(buildDemoReply(prompt)),
        ]),
      ]);
    } else {
      // 首轮：先发起一次工具调用，让工具闭环在演示模式下真的可见。
      core.setResponses([
        faux.fauxAssistantMessage([
          faux.fauxThinking("（演示模式）我先调用一个工具获取信息，再据此作答。"),
          faux.fauxToolCall(FAUX_TOOL_NAME, {}, { id: FAUX_TOOL_CALL_ID }),
        ]),
      ]);
    }

    // context 已是 TranscriptContext → 原样透传（不 normalize、不改 options）。
    return core.stream(model, context, options);
  };

  return { model: core.getModel(), stream, api: core.api, label: "faux" };
}
