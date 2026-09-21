/**
 * runAgentTurn —— 把「数据源 + 配置」翻译成 `agentRuntime.runTurn` 的入参（S7-5）。
 * =====================================================================
 * 单一职责：**只做翻译**。把 `{ source, config, messages, ... }` 按数据源选出一组
 * `runTurn` 需要的依赖，原样调用并**原样返回**它的结果。
 *
 * 它**不做**任何其它事：
 *   - 不做状态管理（那在 conversationController 的调用方）；
 *   - 不做事件映射（那在 conversationModel.applyLibraryEvent）；
 *   - 不吞错（`runTurn` 会 reject：入口前置校验抛可解释错误，库内部某些路径抛裸异常；
 *     这些都**向上抛出**，交由 conversationController 的 catch 分流）。
 *
 * source → 依赖映射（两条路径都必须经 S7-1 的 createStreamFnAdapter 收窄，**不各写一套**）：
 *   - "deepseek"（真实）：model = `buildModel(config)`（`Model<"openai-completions">`）；
 *       stream = `@earendil-works/pi-ai/api/openai-completions` 的 `stream`；
 *       api = "openai-completions"；label = "deepseek"；getApiKey = () => config.apiKey。
 *   - "faux"（演示）：model/stream/api/label 由 `getFauxAgentSource()` 提供
 *       （需 await —— faux core 是惰性加载的单例）。
 *
 * ⚠️ 与库的分工（别重复做，否则会出错）：
 *   - pi-agent-core 在调用 streamFn 之前**已经**调过 `normalizeContext`（`agent-loop.js:232`）；
 *     ⇒ 适配器**不**再 normalize（S7-1 已固化，本层也不插手）。
 *   - 库会把 `apiKey`（取自 `getApiKey`）与内部 signal 注入 options 后交给 streamFn；
 *     ⇒ 本层**只**经 `getApiKey` 提供 Key（`AgentOptions` **没有** `apiKey` 字段），
 *       **不**自己往 options 里塞 Key / signal。
 *
 * ⚠️ 运行时导入纪律（本项目硬性 #2）：**绝不**从 `@earendil-works/pi-ai` 桶文件做
 *    **运行时**导入（会拖入 `node:fs/promises`，Vite 打包失败且报错指向 aws-sdk）。
 *    类型一律 `import type`；运行时一律走**子路径**动态 `import()`
 *    （如 `@earendil-works/pi-ai/api/openai-completions`），**绝不**走桶文件。
 */

import type { Message } from "@earendil-works/pi-ai";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { runTurn } from "../agent/agentRuntime";
import type { RunTurnResult } from "../agent/agentRuntime";
import { DEFAULT_MAX_STEPS, getTools } from "../agent/tools";
import { buildModel } from "./modelFactory";
import type { ProviderConfig } from "./modelFactory";
import { getFauxAgentSource } from "./fauxSource";

/** 数据源类型（S7-5 起唯一的数据源类型）。 */
export type AgentSource = "deepseek" | "faux";

/**
 * 默认系统提示词（S7-5 收尾自 `streamChat.ts` 迁入；后者作为死代码已删除）。
 * 供 `useConversation`（未显式传 systemPrompt 时）与 `App.tsx` 使用。
 */
export const DEFAULT_SYSTEM_PROMPT = "You are ReinAgent, a concise and helpful desktop assistant.";

/** `runAgentTurn` 入参。 */
export interface RunAgentTurnParams {
  /** 数据源：真实 DeepSeek 或合成 faux。 */
  source: AgentSource;
  /** 供应商运行时配置（真实路径用 `config.apiKey` 作 Key，`buildModel` 作 Model）。 */
  config: ProviderConfig;
  /** 起始转录（**末条不得为 assistant**，由 `runTurn` 前置校验）。 */
  messages: Message[];
  /** system prompt（会成为前导 system 消息）。 */
  systemPrompt?: string;
  /** 外部中止信号（只用于 `runTurn` 的 D1 桥接）。 */
  signal?: AbortSignal;
  /** 库事件回调（原样交给 `runTurn`；上层据此驱动状态机与陈旧流隔离）。 */
  onEvent: (ev: AgentEvent, signal?: AbortSignal) => void | Promise<void>;
}

/**
 * 真实 provider 模块的惰性导入（带缓存）。
 * 子路径而非桶导入：只引入 openai-completions 所需的最小闭包。
 */
let completionsModule: Promise<typeof import("@earendil-works/pi-ai/api/openai-completions")> | null = null;

function loadCompletionsModule() {
  if (completionsModule === null) {
    completionsModule = import("@earendil-works/pi-ai/api/openai-completions");
  }
  return completionsModule;
}

/**
 * 运行一个用户回合：按数据源组装 `runTurn` 依赖，原样转发并原样返回其结果。
 *
 * @param {RunAgentTurnParams} params 数据源、配置、转录、system prompt、signal 与事件回调。
 * @returns {Promise<RunTurnResult>} `runTurn` 的返回值（转录快照 + 运行如何结束的事实）。
 * @throws {TypeError} `runTurn` 的入参形状不合法时（如实上抛）。
 * @throws {Error} `runTurn` 前置校验失败（messages 为空 / 末条 assistant）或库内部抛裸异常时（如实上抛）。
 */
export async function runAgentTurn(params: RunAgentTurnParams): Promise<RunTurnResult> {
  const { source, config, messages, systemPrompt, signal, onEvent } = params;

  const base = {
    systemPrompt,
    messages,
    tools: getTools(),
    maxSteps: DEFAULT_MAX_STEPS,
    signal,
    onEvent,
  };

  if (source === "faux") {
    const faux = await getFauxAgentSource();
    return runTurn({
      model: faux.model,
      stream: faux.stream,
      api: faux.api,
      label: faux.label,
      ...base,
    });
  }

  // 真实路径：模型来自 config；provider 级 stream 走子路径动态导入。
  const { stream } = await loadCompletionsModule();
  const model = buildModel(config);
  return runTurn({
    model,
    stream,
    api: "openai-completions",
    label: "deepseek",
    // Key 只能从 getApiKey 进（AgentOptions 无 apiKey 字段）；库会把 provider 传入。
    // ★ 在此 trim：config.apiKey 是用户实时输入的值（useSettings.update 不做 trim，
    //   normalizeSettings 只在读写持久化时 trim）。若从网页复制来的 Key 带首尾空白，
    //   未 trim 会原样进入请求头 → 必然 401。这里是 Key 进入网络的唯一入口，故在此兜底。
    getApiKey: () => config.apiKey.trim(),
    ...base,
  });
}
