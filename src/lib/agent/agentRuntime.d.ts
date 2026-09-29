/**
 * agentRuntime 的类型声明（实现见同目录 `agentRuntime.js`）。
 *
 * 沿用本项目「纯 `.js` 逻辑 + 手写 `.d.ts`」模式（参考
 * `src/lib/chat/conversationModel.d.ts` 与 `src/lib/agent/streamFnAdapter.d.ts`）：
 *   - Node（`node --test`）直接加载 `.js`；
 *   - TS/Vite 取本 `.d.ts` 做类型检查；
 * 无需任何预编译步骤。
 *
 * 运行时导入纪律（本项目硬性 #2）：`agentRuntime.js` 的**运行时**导入只有两处 ——
 *   1. `Agent`（从 pi-agent-core **包根**，允许，实测打包安全）；
 *   2. `createStreamFnAdapter`（同目录，纯 JS，无运行时 import）。
 * 本文件里的 import **全部是 `import type`**（编译期即被擦除），从桶文件取类型允许且安全。
 */

import type { AgentEvent, AgentMessage, AgentTool, BeforeToolCallContext, ShouldStopAfterTurnContext, StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { ProviderStreamFn } from "./streamFnAdapter";

/** `runTurn` 的依赖（全部注入，纯逻辑）。 */
export interface RunTurnDeps {
  /** pi-ai 的 `Model<any>` **对象**（必填；注意不是 provider+modelId 字符串）。 */
  model: Model<any>;
  /**
   * 已建好的 `StreamFn`。提供时**优先使用**，忽略 `stream` / `api` / `label`。
   * 用于调用方已经持有适配器、或测试需要直接注入的场景。
   */
  streamFn?: StreamFn;
  /**
   * provider 级 stream 函数。与 `api` / `label` 一起，经 S7-1 的
   * `createStreamFnAdapter` 造出库需要的 `StreamFn`（唯一收窄处）。
   */
  stream?: ProviderStreamFn;
  /** `stream` 期望的 api 字符串（如 `"faux"` / `"openai-completions"`）。 */
  api?: string;
  /** 出错信息里的来源标识（如 `"deepseek"` / `"faux"`）；缺省回退为 `api`。 */
  label?: string;
  /**
   * API Key 解析器。Key **只能**从这里进（`AgentOptions` 没有 `apiKey` 字段）。
   * 库会把 `model.provider` 作为参数传入。
   */
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
  /** 起始 system prompt（会成为前导 system 消息）。 */
  systemPrompt?: string;
  /** 起始转录（**末条不得为 assistant**）。 */
  messages: AgentMessage[];
  /** 工具体（本步可为空）。 */
  tools?: AgentTool<any>[];
  /** 外部中止信号（**只用于 D1 桥接**）。 */
  signal?: AbortSignal;
  /** 事件转发回调：把库事件连同**外部 signal** 交给上层。 */
  onEvent: (event: AgentEvent, signal?: AbortSignal) => void | Promise<void>;
  /** 可选步数硬闸（按完成的 turn 数计）。 */
  maxSteps?: number;
  /** 可选的推理/思考等级。 */
  thinkingLevel?: "off" | "default" | "low" | "medium" | "high" | "max" | "minimal" | "xhigh";
  /** 可选的自定义停止判据（与 `maxSteps` 同时给出时，两者任一为真即停）。 */
  shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext, signal?: AbortSignal) => boolean | Promise<boolean>;
  /**
   * 可选的工具执行前钩子（直通 pi-agent-core `AgentOptions.beforeToolCall`）。
   * 在参数校验后、执行前调用；可 await（循环挂起等待，不中止）；返回
   * `{ block: true, reason? }` 会产生错误工具结果。钩子需自行尊重 abort signal。
   */
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<{ block?: boolean; reason?: string; terminate?: boolean } | undefined>;
  /**
   * 可选的工具执行后钩子（直通 pi-agent-core `AgentOptions.afterToolCall`）。
   * P2-G2 hooks 的 PostToolUse 事件挂点；可改写结果 content / 标记错误。
   */
  afterToolCall?: (
    context: import("@earendil-works/pi-agent-core").AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<import("@earendil-works/pi-agent-core").AfterToolCallResult | undefined>;
}

/** `runTurn` 的返回值：转录快照 + 本次运行如何结束的可断言事实。 */
export interface RunTurnResult {
  /** 转录**快照**（`agent.state.messages.slice()`），与库内部不是同一引用。 */
  messages: AgentMessage[];
  /** 外部 signal 在本次运行期间触发过中止桥接（即已调用 `agent.abort()`）。 */
  aborted: boolean;
  /** 是否订阅到 `agent_end`（收敛信号）。 */
  reachedAgentEnd: boolean;
  /**
   * 是否因**我们的** `maxSteps` 硬闸触顶而停。
   *
   * 为 `true` **仅当**本次运行因 `maxSteps` 触顶而停止；未传 `maxSteps`、或循环自行
   * 结束（`shouldStopAfterTurn` 命中 / 模型自然结束）时为 `false`。
   * ★ 与 `stopReason` **无关**：后者是库给的「末条 assistant 的 stopReason」；库**不**
   *   提供步数概念，触顶时它仍是模型值（通常是 `"toolUse"`）。判别触顶只能用本字段。
   */
  maxStepsReached: boolean;
  /** 末条 assistant 消息的 `stopReason`（无则 undefined）。 */
  stopReason?: string;
  /** 库内部最近一次失败/中止的 errorMessage（无则 undefined）。 */
  errorMessage?: string;
}

/**
 * 运行一个用户回合：新建 Agent、订阅转发事件、`continue()` 到底、收尾。
 *
 * @throws {TypeError} deps / model / onEvent / messages / streamFn 形状不合法时。
 * @throws {Error} `deps.messages` 为空，或末条为 assistant 时（前置校验）。
 */
export function runTurn(deps: RunTurnDeps): Promise<RunTurnResult>;
