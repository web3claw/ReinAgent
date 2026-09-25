/**
 * agentRuntime —— `@earendil-works/pi-agent-core` 的 `Agent` 薄封装（S7-2）。
 * =====================================================================
 * 唯一职责：把「建 Agent → 订阅事件 → `continue()` → 收尾」收敛为一次
 * `runTurn(deps)` 调用，并把**外部 AbortSignal** 桥接进库（D1），
 * 让「用户停止」这一唯一真相源能真正中止库内部的运行。
 *
 * 与库的分工（务必遵守）：
 *   - 循环、多轮、工具执行**全部交给库**；本模块**不**在外部再套循环。
 *   - `agent.continue()` **一次调用内部就是完整多轮循环**（内层 while），
 *     本模块只调**一次**，绝不在外部反复调用。
 *   - 收敛点**只能是 `agent_end`**；中间 `turn_end` 不收敛（由上层状态机保证）。
 *   - `agent.state.messages` 的 getter 返回**内部同一个数组引用**（未拷贝），
 *     故要快照**必须 `.slice()`**。
 *
 * ★ D1（本步核心）：库有**两套** AbortSignal。
 *   pi-agent-core 每轮**自建** AbortController（`agent.js:339`），循环内全部
 *   中止检查读的都是**库自建那一个**；`agent.abort()`（`agent.js:211-212`）
 *   只 abort 它。因此「外部 signal」若不桥接：
 *     - 中止于「等模型」→ 能生效（外部 signal 掐断 pi-ai 的 HTTP）；
 *     - 中止于「工具执行中」→ **不生效**（工具 terminate 由返回值决定，我们没设）。
 *   桥接方式：把外部 signal 的 `abort` 事件转发到 `agent.abort()`，
 *   并在 `finally` **撤销监听**（否则旧轮监听器泄漏到新一轮）。
 *   ⚠️ 刻意**不**把 `agent.abort()` 暴露给调用方 —— 那会变成「两个停止入口」，
 *   是本项目纪律 #9 判定过的错解。`runTurn(deps)` 的签名因此保持不变。
 *
 * 前置条件防呆：`continue()` 要求转录末条为 user / toolResult。若末条为
 * assistant，`Agent.continue()` 会抛 `"Cannot continue from message role: assistant"`
 *   且**不产生正常事件序列**。本模块在入口处**主动前置校验并抛出信息量足够的
 *   Error**，避免调用方去猜一个「空文本失败」。
 *
 * 运行时导入纪律（本项目硬性 #2）：只从包根做**运行时**导入 `Agent`
 * （包根 `dist/index.js` 仅 `export * from "./agent.js" / "./agent-loop.js"`，
 * 实测打包安全）；绝不从 pi-ai / pi-agent-core 的**桶文件**做运行时导入
 * （会拖入 `node:fs/promises`，Vite 打包失败且报错指向 aws-sdk，极难定位）。
 *
 * 本模块**纯逻辑**：不含 React / DOM，不直调 `Date.now()`，全部依赖注入。
 * 类型声明见同目录 `agentRuntime.d.ts`；自动化验证见 `agentRuntime.test.mjs`。
 */

import { Agent } from "@earendil-works/pi-agent-core";
import { createStreamFnAdapter } from "./streamFnAdapter.js";

/**
 * 判断是否「非空字符串」。用于 systemPrompt 等可选字段的规范化。
 * @param {unknown} value 待判定值。
 * @returns {boolean} 非空字符串则 true。
 */
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * 从转录快照里取**末条 assistant 消息**的 `stopReason`（无则 undefined）。
 * 只读取，不改写；用于把「本次运行如何结束」作为可断言事实返回给上层。
 * @param {Array<any>} messages 转录快照。
 * @returns {string | undefined} 末条 assistant 的 stopReason。
 */
function lastAssistantStopReason(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message !== null && typeof message === "object" && message.role === "assistant") {
      return message.stopReason;
    }
  }
  return undefined;
}

/**
 * 运行一个用户回合：新建一个 Agent、订阅并转发事件、`continue()` 到底、收尾。
 *
 * 一次 `runTurn` = 一次完整的（可能多轮的）agent 运行。返回时保证：
 *   - `messages` 是**快照**（`agent.state.messages.slice()`），与库内部不是同一引用；
 *   - `aborted` 表示「外部 signal 在本次运行期间触发过中止桥接」（即已调用
 *     `agent.abort()`）；
 *   - `reachedAgentEnd` 表示订阅到过 `agent_end`（收敛信号）；
 *   - `maxStepsReached` 表示「本次运行因**我们的** `maxSteps` 硬闸触顶而停」——
 *     这是**我们自己**判定的事实（库不提供步数概念）；触顶时库给的 `stopReason`
 *     仍是**模型值**（通常是 `"toolUse"`），绝不能用 `stopReason` 反推触顶。
 *
 * @param {object} deps 依赖（全部注入，纯逻辑）。
 * @param {any} deps.model pi-ai 的 `Model<any>` **对象**（必填；注意不是 provider+modelId 字符串）。
 * @param {(model: any, context: any, options?: any) => any} [deps.stream]
 *   provider 级 stream 函数。与 `deps.api` / `deps.label` 一起经 S7-1 工厂造 `StreamFn`。
 * @param {string} [deps.api] `deps.stream` 期望的 api 字符串（如 `"faux"` / `"openai-completions"`）。
 * @param {string} [deps.label] 出错信息里的来源标识（如 `"deepseek"` / `"faux"`）。
 * @param {(model: any, context: any, options?: any) => any} [deps.streamFn]
 *   已建好的 `StreamFn`。提供时优先使用，忽略 `deps.stream` / `deps.api` / `deps.label`。
 * @param {(provider: string) => (string | undefined | Promise<string | undefined>)} [deps.getApiKey]
 *   API Key 解析器。Key **只能**从这里进（`AgentOptions` 没有 `apiKey` 字段）。
 * @param {string} [deps.systemPrompt] 起始 system prompt（会成为前导 system 消息）。
 * @param {Array<any>} deps.messages 起始转录（**末条不得为 assistant**）。
 * @param {Array<any>} [deps.tools] 工具体（本步可为空）。
 * @param {AbortSignal} [deps.signal] 外部中止信号（**只用于 D1 桥接**）。
 * @param {(event: any, signal?: AbortSignal) => (void | Promise<void>)} deps.onEvent
 *   事件转发回调：把库事件连同**外部 signal** 交给上层（供 S7-4 状态机消费与陈旧流隔离）。
 * @param {number} [deps.maxSteps] 可选步数硬闸（按完成的 turn 数计）。
 * @param {(context: any, signal?: AbortSignal) => (boolean | Promise<boolean>)} [deps.shouldStopAfterTurn]
 *   可选的自定义停止判据（与 `maxSteps` 同时给出时，两者任一为真即停）。
 * @returns {Promise<{messages: Array<any>, aborted: boolean, reachedAgentEnd: boolean, stopReason: string | undefined, errorMessage: string | undefined, maxStepsReached: boolean}>}
 *   快照与「本次运行如何结束」的可断言事实。
 * @throws {TypeError} deps / model / onEvent / messages / streamFn 的形状不合法时。
 * @throws {Error} `deps.messages` 为空，或末条为 assistant 时（前置校验，见文件头）。
 */
export async function runTurn(deps) {
  if (deps === null || typeof deps !== "object") {
    throw new TypeError("agentRuntime.runTurn: deps 必须是对象（含 model / messages / onEvent）。");
  }

  const {
    model,
    stream,
    api,
    label,
    streamFn: providedStreamFn,
    getApiKey,
    systemPrompt,
    messages,
    tools,
    signal,
    onEvent,
    maxSteps,
    shouldStopAfterTurn,
    thinkingLevel,
    beforeToolCall,
  } = deps;

  // ---- 入参前置校验（不满足即抛，绝不让它退化成库的静默降级）----
  if (model === null || typeof model !== "object") {
    throw new TypeError("agentRuntime.runTurn: deps.model 必须是 pi-ai 的 Model 对象（不能是字符串）。");
  }
  if (typeof onEvent !== "function") {
    throw new TypeError("agentRuntime.runTurn: deps.onEvent 必须是函数（用于接收库事件）。");
  }
  if (!Array.isArray(messages)) {
    throw new TypeError("agentRuntime.runTurn: deps.messages 必须是数组。");
  }
  if (messages.length === 0) {
    throw new Error(
      "agentRuntime.runTurn: deps.messages 不能为空 —— " +
        "Agent.continue() 需要至少一条非 system 消息（末条为 user 或 toolResult）。",
    );
  }
  const lastMessage = messages[messages.length - 1];
  if (lastMessage !== null && typeof lastMessage === "object" && lastMessage.role === "assistant") {
    throw new Error(
      "agentRuntime.runTurn: deps.messages 的末条不能是 assistant —— " +
        "pi-agent-core 的 continue() 要求末条为 user 或 toolResult；" +
        "否则会抛 \"Cannot continue from message role: assistant\"，无法产生正常事件序列。" +
        "请先追加一条 user（或 toolResult）消息再调用 runTurn。",
    );
  }

  // ---- 解析 StreamFn：已建好的优先；否则用 S7-1 工厂由 provider 级 stream 造（唯一收窄处）----
  let streamFn = providedStreamFn;
  if (streamFn === undefined) {
    if (typeof stream !== "function") {
      throw new TypeError(
        "agentRuntime.runTurn: 需要 deps.streamFn（已建好的 StreamFn），" +
          "或 deps.stream（provider 级 stream 函数）+ deps.api。",
      );
    }
    streamFn = createStreamFnAdapter({ stream, api, label: isNonEmptyString(label) ? label : api });
  }
  if (typeof streamFn !== "function") {
    throw new TypeError("agentRuntime.runTurn: deps.streamFn 必须是函数。");
  }
  // beforeToolCall：可选透传（审批模式的挂起/拦截钩子）。形状不对就抛，绝不静默丢弃。
  if (beforeToolCall !== undefined && typeof beforeToolCall !== "function") {
    throw new TypeError("agentRuntime.runTurn: deps.beforeToolCall 必须是函数或 undefined。");
  }

  // ---- 步数硬闸（可选）：把 maxSteps / shouldStopAfterTurn 组装成一个判据 ----
  let turnCount = 0;
  // ★ 触顶事实：库**不提供**步数概念，故「是否因 maxSteps 触顶而停」只能由**我们**的
  //   计数器判定并**单独外传**（绝不能从库的 stopReason 推导 —— 触顶时末条 assistant
  //   的 stopReason 是模型给的，通常是 "toolUse"）。这里只置位，不改 stopReason 语义。
  let maxStepsReached = false;
  const hasStopPolicy =
    typeof shouldStopAfterTurn === "function" || (typeof maxSteps === "number" && maxSteps > 0);

  /** @type {object} */
  const agentOptions = {
    streamFn,
    // ⚠️ 库默认 "parallel"，会打乱 tool_execution_end 与 tool-result 消息的发出顺序。
    // 显式选 "sequential"，保证顺序确定、易于上层消费。
    toolExecution: "sequential",
    // Key 只能从 getApiKey 进（AgentOptions 无 apiKey 字段）；库会传 provider 进来。
    getApiKey: typeof getApiKey === "function" ? (provider) => getApiKey(provider) : undefined,
    // 审批钩子直通库（AgentOptions.beforeToolCall）：工具执行前调用，返回 {block:true}
    // 产生错误工具结果；钩子可 await（循环挂起等待，不中止）。
    beforeToolCall,
    initialState: {
      model,
      thinkingLevel: thinkingLevel ?? "off",
      ...(isNonEmptyString(systemPrompt) ? { systemPrompt } : {}),
      // 拷贝一份，避免 Agent 反向污染调用方数组（库内部还会再 slice 一次，无副作用）。
      messages: messages.slice(),
      ...(Array.isArray(tools) ? { tools: tools.slice() } : {}),
    },
  };

  if (hasStopPolicy) {
    agentOptions.shouldStopAfterTurn = async (context, runSignal) => {
      turnCount += 1;
      if (typeof shouldStopAfterTurn === "function") {
        if (await shouldStopAfterTurn(context, runSignal)) {
          return true;
        }
      }
      if (typeof maxSteps === "number" && maxSteps > 0 && turnCount >= maxSteps) {
        maxStepsReached = true;
        return true;
      }
      return false;
    };
  }

  // ---- 建 Agent ----
  const agent = new Agent(agentOptions);

  // ---- 本次运行的可断言事实 ----
  let aborted = false;
  let reachedAgentEnd = false;

  // ---- ★ D1：把外部 signal 桥接进库（唯一停止入口的转发）----
  // 外部 signal 触发 => 调 agent.abort() => abort 库**自建**的内部 signal
  // => 循环内的中止检查（等模型 / 工具执行）才真正生效。
  const onAbort = () => {
    aborted = true;
    agent.abort();
  };

  // ---- 订阅并转发：把库事件 + **外部 signal** 交给上层 ----
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "agent_end") {
      reachedAgentEnd = true;
    }
    // 原样返回 onEvent 的返回值：若上层返回 Promise，库会 await（计入本次 run 的 settle）。
    return onEvent(event, signal);
  });

  if (signal !== undefined && signal !== null) {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    // ⚠️ 只调一次：continue() 内部即完整多轮循环。
    await agent.continue();
  } finally {
    // 收尾必须无条件执行：退订 + 撤销 abort 监听（防跨轮泄漏）。
    unsubscribe();
    if (signal !== undefined && signal !== null) {
      signal.removeEventListener("abort", onAbort);
    }
  }

  // ---- 快照 + 事实 ----
  const snapshot = agent.state.messages.slice();
  // ★ 快照必须是**死值**：返回值一经返回就不得再与 Agent 内部状态「同行」。
  //   `messages` 已是 slice() 拷贝；这里再把这个「本次运行如何结束」的事实对象**冻结**，
  //   防止调用方（或将来新增的代码）误写这些事实、使其与真相不一致。
  //   已确认全部调用方（conversationController.js / runAgentTurn.ts）**只读**
  //   aborted / reachedAgentEnd / stopReason / errorMessage / messages / maxStepsReached，
  //   无一处写返回对象。（只冻结外层对象；`messages` 数组本身仍可被有意改写，test 4 依赖此。）
  return Object.freeze({
    messages: snapshot,
    aborted,
    reachedAgentEnd,
    stopReason: lastAssistantStopReason(snapshot),
    errorMessage: agent.state.errorMessage,
    // ★ 我们**自己**判定的事实：库不提供步数概念，触顶时库给的 stopReason 仍是模型值。
    maxStepsReached,
  });
}
