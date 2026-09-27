/**
 * conversationController —— 聊天「编排」的**纯逻辑层**（无 React / 无 DOM / 无副作用）。
 *
 * 从 `useConversation` 抽出，目的有二：
 *   1. 让「忙判定 / 中止 / 陈旧流的隔离」这些容易出竞态的编排逻辑，可以在
 *      `node --test` 里被**直接驱动**（无需渲染 React hook）。
 *   2. 依赖（状态读写、runAgentTurn、AbortController 工厂、时钟）全部注入，
 *      测试里可替换为假实现或真实 faux 核心。
 *
 * 本文件只依赖 `conversationModel.js`（同为纯逻辑），因此可以被 Node 直接加载。
 * 类型声明见同目录 `conversationController.d.ts`。
 *
 * S7-5：**循环来源改为 `runAgentTurn`**（库内部多轮循环）。
 *   本层不再 `await streamChat` + `for await` 逐事件消费 —— 那段整体替换为**一次**
 *   `await runAgentTurn({...})`。库事件经 `onEvent` 交给**新鲜的** `applyLibraryEvent`；
 *   收敛点仍只有一个（`agent_end`），本层**不**再造第二个。
 *
 * 竞态要点（S4 二轮修复 A-1；循环搬进库后，以下结论**一字未变**）：
 *   - **忙判定一律来自「状态派生」**（`getState().status === "streaming"`），
 *     **绝不**用 `abortRef` 是否非空来判定。因为 `stop()` 只做 `abort()` + 收敛状态，
 *     并**不**立刻清空 `abortRef`（清空发生在上一轮 IIFE 的 `finally`）。若用
 *     `abortRef` 判忙，在 `stop()` 到 `finally` 之间会出现一个窗口：状态已 `idle`
 *     （发送按钮已可用），但 `abortRef` 仍非空 → 新发送被**静默吞掉**。
 *   - **不能用「在 `stop()` 里清空 `abortRef`」来修**：上一轮 IIFE 的 `finally`
 *     随后仍会执行，若无条件执行 `abortRef = null`，会把**新一轮刚设好的** controller
 *     一并清掉，问题从「吞输入」演变为更难查的「新流的信号被摘掉」。
 *   - **陈旧流的隔离**：每轮持有自己的 `controller`；事件与终态在写回前校验
 *     `abortRef === controller`（`isStale()`）。若已被新一轮取代，则整体丢弃，
 *     避免上一轮的中止事件污染新一轮的状态。搬到库后这一点更重要：`runTurn`
 *     的 `onEvent` 由库在整段循环期间反复回调，陈旧轮次的事件必须在**回调处**就被拦下。
 */

import {
  appendUser,
  applyLibraryEvent,
  beginAssistant,
  finish,
  finishAborted,
  initialState,
  restoreState,
  noteMaxSteps,
  toApiMessages,
  withPendingApproval,
} from "./conversationModel.js";
import { isRetryableError } from "../chat/errors.js";
import { pushRetryAttempt } from "./conversationModel.js";
import { markTurnEntrance } from "./entranceOnce.js";

/**
 * 展开 Error 的 cause 链为「主消息 ← 原因 ← …」的完整描述。
 * OpenAI SDK 的连接错误 message 只有 "Connection error."，真实原因（URL、
 * 对端重置等）在 cause 链上——不解开就只剩一句空话（对齐 LiveAgent 的原文展示）。
 * @param {unknown} err
 * @returns {string}
 */
function describeErrorChain(err) {
  const parts = [];
  let current = err;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const msg =
      typeof current.message === "string" && current.message
        ? current.message
        : String(current);
    if (!parts.includes(msg)) parts.push(msg);
    current = current.cause;
  }
  if (parts.length === 0) parts.push(String(err));
  return parts.join(" ← ");
}

/**
 * 创建一个会话编排器。
 *
 * @param {{
 *   getState: () => import("./conversationModel").ChatState,
 *   setState: (updater: (prev: import("./conversationModel").ChatState) => import("./conversationModel").ChatState) => void,
 *   runAgentTurn: (params: { source: string, config: unknown, messages: unknown[], systemPrompt?: string, signal?: AbortSignal, onEvent: (ev: unknown, signal?: AbortSignal) => void | Promise<void> }) => Promise<any>,
 *   getOptions: () => { source: string, config: unknown, systemPrompt: string },
 *   createAbortController?: () => AbortController,
   *   now?: () => number,
   *   taskId?: string,                     // 本会话归属的任务 id（检查点上下文来源）
   *   onTurnBegin?: (turnId: string) => void, // 轮边界回调（检查点 begin_turn 打点）
   * }} deps
   * @returns {{
   *   send: (text: string) => boolean,
   *   editResend: (anchorMessageId: string, text: string) => boolean,
   *   stop: () => void,
   *   clear: () => void,
   * }}
   */
export function createConversationController(deps) {
  const { getState, setState, runAgentTurn, getOptions } = deps;
  const createAbortController = deps.createAbortController ?? (() => new AbortController());
  const now = deps.now ?? (() => Date.now());

  /** 当前轮次持有的中止句柄（仅用于 stop/clear 与陈旧判定，**不**用于忙判定）。 */
  let abortRef = null;

  /**
   * 当前挂起的审批（{ resolve } 为决策回执句柄）。
   * requestApproval 挂起 → UI 调 resolveApproval 决策 → 挂起解除。
   * stop/clear 时以 reject 收场（先于 abort，让钩子里的等待有确定终值）。
   */
  let pendingApprovalRef = null;

  /** 审批协调器的 request 实现：写状态（渲染审批卡）+ 挂起等决策。 */
  function requestApproval(req) {
    return new Promise((resolve) => {
      pendingApprovalRef = { resolve };
      setState((prev) => withPendingApproval(prev, req));
    });
  }

  /** 解决当前挂起的审批（decision: "allow" | "always" | "reject"）。无挂起时静默。 */
  function resolveApproval(decision) {
    const pending = pendingApprovalRef;
    if (pending === null) return;
    pendingApprovalRef = null;
    setState((prev) => withPendingApproval(prev, null));
    pending.resolve(decision);
  }

  /** 用户主动停止：中断当前轮次并立即收敛为「已停止」。 */
  function stop() {
    // 先解除审批挂起（拒绝语义），再中止轮次——顺序保证钩子等待先有终值。
    resolveApproval("reject");
    const controller = abortRef;
    if (controller === null) return;
    controller.abort();
    // 立即收敛为「已停止」：保留已生成文本、回 idle、不进入 error。
    // （随后 aborted 事件会再次命中 finishAborted，但此时已非 streaming，会被安全忽略。）
    setState((prev) => finishAborted(prev, now()));
  }

  /** 清空会话：中断在途轮次并重置状态。 */
  function clear() {
    resolveApproval("reject");
    if (abortRef !== null) abortRef.abort();
    abortRef = null;
    setState(() => initialState());
  }

  /** 加载或切换会话：中断在途轮次并置入目标消息列表。 */
  function loadState(messages) {
    if (abortRef !== null) abortRef.abort();
    abortRef = null;
    setState(() => restoreState(messages));
  }

  /**
   * 是否为「内容承载」事件（对齐 LiveAgent withStreamRetry 的 committed 判定）：
   * 正文/思考增量或工具调用已开始。已提交内容后的失败不再自动重试——
   * 部分内容已到达用户屏幕，重发会造成重复。
   */
  function isContentBearingEvent(ev) {
    if (!ev || typeof ev !== "object") return false;
    if (ev.type === "tool_execution_start") return true;
    if (ev.type === "message_update") {
      const inner = ev.assistantMessageEvent;
      if (!inner || typeof inner !== "object") return false;
      return (
        inner.type === "text_delta" ||
        inner.type === "thinking_delta" ||
        inner.type === "toolcall_start" ||
        inner.type === "toolcall_delta"
      );
    }
    return false;
  }

  /**
   * 启动一轮 Agent 循环（send 与 editResend 共用的流水线）。
   * @param {string} turnId 本轮用户消息的稳定 id（检查点边界与重试归因使用）。
   */
  function launchTurn(turnId) {
    const controller = createAbortController();
    abortRef = controller;
    /** 本轮的写回是否已过期（已被新一轮取代 / 被清空）。 */
    const isStale = () => abortRef !== controller;

    void (async () => {
      try {
        // ★ 一次 `runAgentTurn` = 完整多轮循环（循环在库里）。库事件经 onEvent 交给
        //   状态机；该回调由库在整段循环期间反复调用，故陈旧轮次必须**在此处**拦截。
        //
        // 自动重试（对齐 LiveAgent withStreamRetry）：**关键覆盖点**——可重试错误
        // 不止从 throw 冒出：pi-ai 把 HTTP 错误（如网关 502）作为 stopReason:"error"
        // 的失败消息返回（result.errorMessage），只 catch throw 会完全漏掉这类失败。
        // 因此 throw 与 errorMessage 两条路径都进同一个重试裁决 + 指数抖动退避。
        // 另一条 LiveAgent 语义：**已提交内容（正文/思考/工具调用已开始）后的失败
        // 不重试**，直接收敛为错误行。重试期间失败尝试的空错误行不留在时间线
        // （失败详情进重试记录，等耗尽后才随最终错误一并输出）。
        const MAX_AUTO_RETRIES = 10;
        const RETRY_BASE_MS = 200;
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        let result;
        let attempt = 0; // 已消耗的重试次数
        setState((prev) => ({ ...prev, retrying: false, retryAttempts: [] }));
        while (true) {
          // 每次尝试重建历史：当前 user 条目（含图片块 apiMessage）已在时间线中，
          // toApiMessages 会带上它；失败/中止的 assistant 及其后随 toolResult 会被剔除。
          const history = toApiMessages(getState());
          let contentCommitted = false;
          let errorMessage; // 本次尝试的失败原因（throw 或 errorMessage 两路归一）
          try {
            const options = getOptions();
            result = await runAgentTurn({
              source: options.source,
              config: options.config,
              messages: history,
              systemPrompt: options.systemPrompt,
              maxSteps: options.maxSteps,
              workspaceRoot: options.workspaceRoot,
              signal: controller.signal,
              thinkingLevel: options.thinkingLevel,
              approvalMode: options.approvalMode,
              approval: options.approval,
              // 检查点上下文：本轮写文件前捕获前像（回退本轮代码改动的数据源）
              checkpoint:
                deps.taskId && turnId
                  ? { conversationId: deps.taskId, turnId }
                  : undefined,
              onEvent: (ev) => {
                if (isStale()) return;
                if (!contentCommitted && isContentBearingEvent(ev)) {
                  contentCommitted = true;
                  // 对齐 LiveAgent onRetryRecovered：新尝试产出**首个内容**才撤下
                  // 「重新连接中」副行——重试的整个连接+等待过程保持显示。
                  if (getState().retrying) setState((prev) => ({ ...prev, retrying: false }));
                }
                setState((prev) => applyLibraryEvent(prev, ev, now()));
              },
            });
            // ★ 失败判定：result.errorMessage 非空 = 本次尝试失败（含 HTTP 502 等网关错误）。
            // 连接类错误（pi-ai 只透出 "Connection error."）追加端点，帮助定位是哪个网关失败。
            if (result && result.errorMessage) {
              errorMessage = result.errorMessage;
              if (options.config && typeof options.config.baseUrl === "string" && options.config.baseUrl && /connection|fetch|network/i.test(errorMessage)) {
                errorMessage += ` (Endpoint: ${options.config.baseUrl})`;
              }
            } else {
              break; // 正常完成
            }
          } catch (err) {
            if (isStale()) return;
            const aborted =
              controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
            if (aborted) {
              setState((prev) => finishAborted(prev, now()));
              return;
            }
            errorMessage = describeErrorChain(err);
            console.warn("[retry] inner catch raw =", JSON.stringify(errorMessage), "retryable =", isRetryableError(errorMessage), "attempt =", attempt);
          }

          // ---- 失败裁决：用户已中止 → 直接收敛（中止优先于一切重试/错误）----
          if (controller.signal.aborted) {
            setState((prev) => finishAborted(prev, now()));
            break;
          }
          console.warn("[retry] adjudication errorMessage =", JSON.stringify(errorMessage), "retryable =", isRetryableError(errorMessage), "attempt =", attempt, "MAX =", MAX_AUTO_RETRIES);
          if (!isRetryableError(errorMessage) || attempt >= MAX_AUTO_RETRIES || contentCommitted) {
            // 重试耗尽 / 不可重试 / 内容已提交：收敛为最终 error 行
            // finish 保持 state.retryAttempts（轮次级字段），但要把记录固化到 assistant 条目上
            setState((prev) => {
              const finished = finish(prev, undefined, errorMessage, now());
              const records = finished.retryAttempts;
              if (!records || records.length === 0) return finished;
              // 固化到最后一条 assistant 条目
              const messages = finished.messages.slice();
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === "assistant") {
                  messages[i] = { ...messages[i], retryAttempts: records };
                  break;
                }
              }
              return { ...finished, messages };
            });
            break;
          }
          attempt += 1;
          console.warn("[retry] retrying, attempt =", attempt);
          const backoff = Math.round(RETRY_BASE_MS * 2 ** (attempt - 1) * (0.9 + Math.random() * 0.2));
          // 记录重试 + 退避。对齐 LiveAgent：失败尝试的错误行不留在时间线（失败详情
          // 进重试记录），并确保时间线以一条空流式助手行收尾——「重新连接中… N/10」
          // 副行由此持续显示（retrying 直到新尝试产出首个内容才撤下，见 onEvent），
          // 退避/连接等待期间轮保持 live，stop() 也有正确的 patch 目标。
          setState((prev) => {
            const last = prev.messages[prev.messages.length - 1];
            let messages = prev.messages.slice();
            let seq = typeof prev.nextMessageSeq === "number" ? prev.nextMessageSeq : messages.length;
            // 继承本轮最初的工作起始时间：轮工时必须跨重试累加，不能每次重建行都从零计时。
            let carriedStartedAt;
            if (last && last.role === "assistant" && last.status === "error") {
              carriedStartedAt = last.startedAt;
              messages = messages.slice(0, -1);
            }
            const tail = messages[messages.length - 1];
            if (!(tail && tail.role === "assistant" && tail.status === "streaming")) {
              messages.push({
                id: `m${seq}`,
                role: "assistant",
                text: "",
                thinking: "",
                status: "streaming",
                startedAt: carriedStartedAt ?? now(),
              });
              seq += 1;
            } else if (carriedStartedAt !== undefined && tail.startedAt === undefined) {
              // 空流式行被复用但缺打点（理论不可达）：补上继承值。
              tail.startedAt = carriedStartedAt;
            }
            const base = {
              ...prev,
              messages,
              status: "streaming",
              error: undefined,
              retrying: true,
              nextMessageSeq: seq,
            };
            return pushRetryAttempt(base, {
              attempt,
              maxAttempts: MAX_AUTO_RETRIES,
              errorMessage,
              plannedDelayMs: backoff,
            });
          });
          await sleep(backoff);
          if (isStale()) return;
          // 退避期间用户已停止：立即收敛为「已停止」，不再把下一次（注定失败的）
          // 请求发出去——否则停止后还会等一个完整的连接超时才安静下来。
          if (controller.signal.aborted) {
            setState((prev) => finishAborted(prev, now()));
            break;
          }
        }

        // ★ 保险：正常路径下 agent_end 经 onEvent → applyLibraryEvent → finish 收敛，
        //   那是**唯一**的收敛点，这里不另造。但**绝不能依赖「事件一定到达」**：
        //   若本次运行未订阅到 agent_end（reachedAgentEnd === false），此处兜底收敛，
        //   避免状态永久卡在 streaming（发送按钮永久禁用）。（finish 幂等：非 streaming
        //   时原样返回，重复收敛无害。）
        if (isStale()) return;
        if (result && result.reachedAgentEnd === false) {
          if (result.aborted || result.stopReason === "aborted") {
            setState((prev) => finishAborted(prev, now()));
          } else if (result.errorMessage) {
            setState((prev) => finish(prev, undefined, result.errorMessage, now()));
          } else {
            setState((prev) => finish(prev, undefined, undefined, now()));
          }
        }

        // ★ S7：步数硬闸触顶的**可见终止说明**（规格 §6 / §7.1 / 决策 D / 风险 R9 / D12）。
        //   触顶是**正常结束**：agent_end 会到达、状态已被 finish 收敛为 idle，因此它
        //   **不在**上面那条「保险收敛（reachedAgentEnd === false）」分支里 —— 那条分支
        //   在触顶时**永远不会执行**。这里必须是 await 之后一条**独立**的条件处理：
        //   仅给末条助手条目打一个**纯展示**标注（**不改** status，理由见 noteMaxSteps）。
        //   陈旧流守卫沿用上面的 isStale()（此处无 await，check 与写入同 tick，不会被取代）。
        if (result && result.maxStepsReached === true) {
          setState((prev) => noteMaxSteps(prev));
        }
      } catch (err) {
        console.warn("[retry] OUTER catch:", describeErrorChain(err).slice(0, 200));
        if (isStale()) return;
        // 中止不是错误：不发红字提示，只收敛为「已停止」。
        // （`runTurn` 会 reject：入口前置校验抛可解释错误，库内部某些路径抛裸异常。）
        const aborted =
          controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
        if (aborted) {
          setState((prev) => finishAborted(prev, now()));
        } else {
          const message = describeErrorChain(err);
          setState((prev) => finish(prev, undefined, message, now()));
        }
      } finally {
        // 仅当自己仍是当前轮次（未被新一轮取代）时才清空，避免覆盖新一轮的句柄。
        if (abortRef === controller) {
          // 异常路径兜底：轮次已结束但审批仍挂起（未被 stop/clear 解除）→ 以 reject 收场，
          // 防止审批卡悬挂、钩子 Promise 永不 settle。
          if (pendingApprovalRef !== null) {
            const pending = pendingApprovalRef;
            pendingApprovalRef = null;
            setState((prev) => withPendingApproval(prev, null));
            pending.resolve("reject");
          }
          abortRef = null;
        }
      }
    })();

    return true;
  }

  /**
   * 发送一条用户消息并启动一轮流式。
   * @param {string} rawText
   * @returns {boolean} **本次是否被受理**（true=已开始/无需处理；false=空文本或忙）。
   *   调用方（Composer）应只在返回 true 时清空输入框，避免竞态下静默丢用户输入。
   */
  function send(rawText) {
    const text = typeof rawText === "string" ? rawText.trim() : "";
    if (text.length === 0) return false;
    // 忙判定来自状态派生（唯一真相），而非 abortRef。
    if (getState().status === "streaming") return false;

    const { images, userAttachments } = getOptions();

    // 图片附件：转成 pi-ai 原生 image content block（对齐 LiveAgent 原生内联策略）
    const userMessage = images && images.length > 0
      ? {
          role: "user",
          content: [
            { type: "text", text },
            ...images.map((img) => ({ type: "image", data: img.base64, mimeType: img.mimeType })),
          ],
          timestamp: now(),
        }
      : { role: "user", content: text, timestamp: now() };

    // 轮 id = 即将生成的 user 条目 id（appendUser 用同一公式）；先打检查点轮边界。
    const prev = getState();
    const turnId = `m${typeof prev.nextMessageSeq === "number" ? prev.nextMessageSeq : prev.messages.length}`;
    setState((current) =>
      beginAssistant(appendUser(current, text, userAttachments, userMessage), now()),
    );
    deps.onTurnBegin?.(turnId);
    launchTurn(turnId);
    return true;
  }

  /**
   * 编辑重发（对齐 LiveAgent 编辑重发 = 硬截断）：把锚点 user 消息原位替换为新文本，
   * 其后的全部旧分支（旧回复/工具调用）一并移除，随后作为全新一轮重跑。
   * 任何一步不受理时原历史保持不变。
   * @param {string} anchorMessageId 锚点 user 消息 id（切点只能是用户消息 ⇒ 天然无孤儿 toolResult）。
   * @param {string} rawText 替换后的新文本（调用方已把保留的文件附件折算进文本）。
   * @returns {boolean} 是否被受理。
   */
  function editResend(anchorMessageId, rawText) {
    if (getState().status === "streaming") return false;
    const text = typeof rawText === "string" ? rawText.trim() : "";
    const { images, userAttachments } = getOptions();
    if (text.length === 0 && !(Array.isArray(images) && images.length > 0)) return false;

    const current = getState();
    const anchorIndex = current.messages.findIndex(
      (m) => m && m.id === anchorMessageId && m.role === "user",
    );
    if (anchorIndex === -1) return false;

    const seq = typeof current.nextMessageSeq === "number" ? current.nextMessageSeq : current.messages.length;
    const turnId = `m${seq}`;
    const userMessage = images && images.length > 0
      ? {
          role: "user",
          content: [
            { type: "text", text },
            ...images.map((img) => ({ type: "image", data: img.base64, mimeType: img.mimeType })),
          ],
          timestamp: now(),
        }
      : { role: "user", content: text, timestamp: now() };

    const replacement = {
      id: turnId,
      role: "user",
      text,
      thinking: "",
      status: "done",
      ...(Array.isArray(userAttachments) && userAttachments.length > 0 ? { attachments: userAttachments } : {}),
      apiMessage: userMessage,
    };
    setState((prev) => {
      const truncated = {
        ...prev,
        messages: [...prev.messages.slice(0, anchorIndex), replacement],
        status: "idle",
        error: undefined,
        retrying: false,
        retryAttempts: [],
        nextMessageSeq: seq + 1,
        pendingApproval: null,
      };
      // 与 send 同构：同步建流式助手行——忙判定（状态派生）即刻生效，消除
      // 「截断后到库 message_start 之间」的发送竞态空窗；库的 message_start
      // 见末条 assistant 正在 streaming 会自动跳过重复建行。
      return beginAssistant(truncated, now());
    });
    markTurnEntrance(turnId);
    deps.onTurnBegin?.(turnId);
    launchTurn(turnId);
    return true;
  }

  return { send, editResend, stop, clear, loadState, requestApproval, resolveApproval };
}
