/**
 * conversationModel —— 纯状态机：聊天消息状态 + 事件应用。
 *
 * 设计约束（S2 硬要求）：
 *   - **无 React、无 DOM、无副作用**：只有纯函数，输入旧 state 返回新 state。
 *   - 这样 UI 组件无法在无头环境验证，但这一层可以：用 faux 事件流驱动，
 *     就能把「流式累积是否正确」变成可自动化断言的东西。
 *
 * 事件语义与 `scripts/smoke.mjs` 的 consumeStream 保持一致，尤其是：
 *   **正文只能从 `text_delta` 的 `ev.delta` 累积，绝不能读 `ev.partial`**
 *   （`partial` 是共享的实时响应对象，不是事件时刻的快照）。
 *
 * 类型定义见同目录 `conversationModel.d.ts`。
 */

import { diagnoseError, isAbortReason } from "./errors.js";

/** @returns {import("./conversationModel").ChatState} */
export function initialState() {
  return { messages: [], status: "idle", error: undefined, nextMessageSeq: 0 };
}

/**
 * 恢复指定消息列表的状态机（切换会话时使用）。
 * @param {import("./conversationModel").TimelineEntry[]} messages
 * @returns {import("./conversationModel").ChatState}
 */
export function restoreState(messages) {
  const list = Array.isArray(messages) ? messages : [];
  // 恢复时消毒残留的「进行中」状态：流式/执行中的条目一旦经历重启或切换，
  // 其执行早已中断——标记为 stopped 并补 endedAt（用当前时间），
  // 否则统计里会按「开始到现在」累计出数小时的假耗时，状态条也会永远显示工作中。
  const now = Date.now();
  const sanitized = list.map((m) => {
    if (!m || typeof m !== "object") return m;
    if (m.status === "streaming" || m.status === "running") {
      return { ...m, status: "stopped", endedAt: m.endedAt ?? now };
    }
    return m;
  });
  return {
    messages: sanitized,
    status: "idle",
    error: undefined,
    nextMessageSeq: sanitized.length,
  };
}

/**
 * 取下一条消息序号（用于生成**唯一** id `m${seq}`）。
 *
 * 为什么不再用 `m${messages.length}`：那种写法的唯一性依赖「数组只增不减」，
 * 一旦将来引入删除片段 / 重新生成 / 截断历史，就会产出重复的 React key，
 * 表现为消息错乱且极难定位。改为随 state 走的单调计数器（只增不减，
 * 即便剪枝也不会把序号退回去）。
 *
 * 缺省回退到 `messages.length`：允许调用方以对象字面量手造 ChatState（测试里
 * 直接构造喂给 `toApiMessages`），无计数器字段时也不会算出 NaN。
 *
 * @param {import("./conversationModel").ChatState} state
 * @returns {number}
 */
function nextSeq(state) {
  return typeof state.nextMessageSeq === "number" ? state.nextMessageSeq : state.messages.length;
}

/**
 * 追加一条用户消息。允许在 idle / error 之后调用（error 会被清空）。
 * @param {import("./conversationModel").ChatState} state
 * @param {string} text
 */
export function appendUser(state, text) {
  const seq = nextSeq(state);
  const message = {
    id: `m${seq}`,
    role: "user",
    text,
    thinking: "",
    status: "done",
  };
  return {
    messages: [...state.messages, message],
    status: "idle",
    error: undefined,
    nextMessageSeq: seq + 1,
  };
}

/**
 * 开始一条助手消息（进入 streaming）。若已在 streaming 则视为非法，原样返回。
 * @param {import("./conversationModel").ChatState} state
 * @param {number=} nowMs 当前时间戳（回合工时打点起点；缺省取系统时钟）
 */
export function beginAssistant(state, nowMs) {
  if (state.status === "streaming") return state;
  const seq = nextSeq(state);
  const message = {
    id: `m${seq}`,
    role: "assistant",
    text: "",
    thinking: "",
    status: "streaming",
    // 回合工时打点：仅展示用，绝不参与 toApiMessages。
    startedAt: typeof nowMs === "number" ? nowMs : Date.now(),
  };
  return {
    messages: [...state.messages, message],
    status: "streaming",
    error: undefined,
    nextMessageSeq: seq + 1,
  };
}

/** 找到最后一条助手消息的下标，没有则返回 -1。 */
function lastAssistantIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "assistant") return i;
  }
  return -1;
}

/** 对最后一条助手消息做浅合并 patch。 */
function patchLastAssistant(state, patch) {
  const index = lastAssistantIndex(state.messages);
  if (index === -1) return state;
  const messages = state.messages.slice();
  messages[index] = { ...messages[index], ...patch };
  return { ...state, messages };
}

/** 从权威 AssistantMessage 抽取纯文本（text 块拼接）。 */
function textOfMessage(message) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block && block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** 从权威 AssistantMessage 抽取思考文本（thinking 块拼接）。 */
function thinkingOfMessage(message) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block && block.type === "thinking")
    .map((block) => block.thinking)
    .join("");
}

/**
 * 应用一个 AssistantMessageEvent（处理全部 12 类）。
 * 若当前不在 streaming 状态，视为非法转移，原样返回（不抛异常，容忍乱序/重复事件）。
 *
 * @param {import("./conversationModel").ChatState} state
 * @param {import("@earendil-works/pi-ai").AssistantMessageEvent} ev
 */
export function applyEvent(state, ev, nowMs) {
  if (state.status !== "streaming") return state;
  const at = typeof nowMs === "number" ? nowMs : Date.now();

  switch (ev.type) {
    case "start":
      return patchLastAssistant(state, { status: "streaming" });

    case "text_start":
      return state;

    case "text_delta": {
      const index = lastAssistantIndex(state.messages);
      if (index === -1) return state;
      const messages = state.messages.slice();
      // 关键：累积必须用 ev.delta，绝不能用 ev.partial。
      const entry = { ...messages[index], text: messages[index].text + ev.delta };
      // 思考时长冻结：首个正文增量到达即封口思考跨度（仅首个思考段计）。
      if (entry.thinkingDurationMs === undefined && entry.thinkingStartedAt !== undefined) {
        entry.thinkingDurationMs = Math.max(0, at - entry.thinkingStartedAt);
      }
      messages[index] = entry;
      return { ...state, messages };
    }

    case "text_end":
      // 权威文本块到达，但正文已由 text_delta 累积完成，这里无需修改。
      return state;

    case "thinking_start":
      return state;

    case "thinking_delta": {
      const index = lastAssistantIndex(state.messages);
      if (index === -1) return state;
      const messages = state.messages.slice();
      const entry = { ...messages[index] };
      // 思考起点打点：首个思考增量到达时记录（仅首个思考段）。
      if (entry.thinkingStartedAt === undefined) {
        entry.thinkingStartedAt = at;
      }
      // 思考累积到独立字段：渲染由 ThinkingBlock 负责。
      entry.thinking = entry.thinking + ev.delta;
      messages[index] = entry;
      return { ...state, messages };
    }

    case "thinking_end": {
      const index = lastAssistantIndex(state.messages);
      if (index === -1) return state;
      const entry = state.messages[index];
      // 思考结束即封口时长（正文可能迟迟不来或根本不来）。
      if (entry.thinkingStartedAt !== undefined && entry.thinkingDurationMs === undefined) {
        const messages = state.messages.slice();
        messages[index] = {
          ...entry,
          thinkingDurationMs: Math.max(0, at - entry.thinkingStartedAt),
        };
        return { ...state, messages };
      }
      return state;
    }

    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
      // S2 不做工具调用，忽略（不丢弃状态，仅不参与渲染）。
      return state;

    case "done":
      return finish(state, ev.message);

    case "error":
      // 关键：把「用户主动中止」与「真正的错误」区分开。
      // pi-ai 中止时也是以 error 事件下发，但 reason === "aborted"。
      if (isAbortReason(ev.reason)) {
        return finishAborted(state);
      }
      return finish(state, undefined, ev.error && ev.error.errorMessage ? ev.error.errorMessage : "请求失败");

    default:
      // 未预期事件：忽略。
      return state;
  }
}

/**
 * 收敛到终态。
 * - 有 error → 先经 `diagnoseError` 映射为可读文案，再进入 error 状态。
 * - 有 finalMessage → 用其权威内容覆盖助手消息文本，回到 idle。
 * 若当前不在 streaming，视为非法转移，原样返回。
 *
 * @param {import("./conversationModel").ChatState} state
 * @param {import("@earendil-works/pi-ai").AssistantMessage=} finalMessage
 * @param {string=} error 原始错误文本（会经 diagnoseError 映射）
 */
export function finish(state, finalMessage, error, nowMs) {
  if (state.status !== "streaming") return state;
  const at = typeof nowMs === "number" ? nowMs : Date.now();

  if (error !== undefined) {
    const readable = diagnoseError(error);
    return {
      ...patchLastAssistant(state, { status: "error", error: readable, endedAt: at }),
      status: "error",
      error: readable,
    };
  }

  const patch = { status: "done", endedAt: at };
  if (finalMessage) {
    patch.text = textOfMessage(finalMessage);
    patch.thinking = thinkingOfMessage(finalMessage);
    patch.apiMessage = finalMessage;
  }
  return { ...patchLastAssistant(state, patch), status: "idle", error: undefined };
}

/**
 * 用户主动中止：回到 idle，**保留已生成的文本**，在该条消息上标注「已停止」，
 * **不进入 error 状态**、不产生错误文案。
 * 若当前不在 streaming，视为非法转移，原样返回。
 *
 * @param {import("./conversationModel").ChatState} state
 * @returns {import("./conversationModel").ChatState}
 */
export function finishAborted(state, nowMs) {
  if (state.status !== "streaming") return state;
  const at = typeof nowMs === "number" ? nowMs : Date.now();
  return {
    ...patchLastAssistant(state, { status: "stopped", endedAt: at }),
    status: "idle",
    error: undefined,
  };
}

/**
 * 「已达最大步数」标注：在最后一条助手条目上打一个**纯展示**字段。
 *
 * ⚠️ 只能新增展示字段，**绝对不许**改 `status`。原因（不是洁癖，是会炸）：
 *   `toApiMessages` 的 R13（:488-500）会剔除「末尾且 status !== "done"」的 assistant。
 *   触顶时最后一条 assistant 之后紧跟**配对的** toolResult，一旦把它的 status 改成
 *   非 "done"，它就会在下一轮被剔除 ⇒ 留下孤儿 toolResult ⇒ 下一次请求 400。
 *   而 B-2 的配对补全（:455-486）在剪枝**之前**执行，救不了这个。
 *
 * 幂等：重复调用结果等价；无助手条目时返回**同一个 state 对象**。
 *
 * @param {import("./conversationModel").ChatState} state
 * @returns {import("./conversationModel").ChatState}
 */
export function noteMaxSteps(state) {
  const index = lastAssistantIndex(state.messages);
  if (index === -1) return state;
  const messages = state.messages.slice();
  messages[index] = { ...messages[index], truncatedBy: "maxSteps" };
  return { ...state, messages };
}

/** 最后一条助手消息（没有则 undefined）。 */
export function lastAssistant(state) {
  const index = lastAssistantIndex(state.messages);
  return index === -1 ? undefined : state.messages[index];
}

/** 是否处于流式中。 */
export function isStreaming(state) {
  return state.status === "streaming";
}

// ===========================================================================
// S7：库事件（pi-agent-core `AgentEvent`）→ 时间线映射
// ---------------------------------------------------------------------------
// 与既有 `applyEvent`（pi-ai 协议事件）是**两条独立通道**：
//   - `applyEvent` 只处理 AssistantMessageEvent（正文/思考增量）；
//   - `applyLibraryEvent` 处理 AgentEvent（生命周期 + 工具执行），
//     其中 `message_update` 会把内层的 `assistantMessageEvent` **原样委托**给 `applyEvent`。
//
// ★ 顺序硬事实（读 `pi-agent-core/dist/agent-loop.js`）：
//   `tool_execution_start` → `tool_execution_end` → `message_start/end(toolResult)`
//   → `turn_end { message, toolResults }` → …… → `agent_end`。
//   因此：
//     1. 工具条目先在 `tool_execution_start` 建起来，权威 `ToolResultMessage`
//        要到 `turn_end.toolResults` 才拿得到（按 `toolCallId` 配对）；
//     2. **收敛点只能是 `agent_end`**：中间任何 `turn_end` / `tool_execution_end`
//        都不得把 `state.status` 变成 `idle`，否则发送按钮会在多步循环中途提前解禁。
// ===========================================================================

/** 在 messages 中按 `toolCallId` 找工具条目下标，找不到返回 -1。 */
function toolIndexOf(messages, toolCallId) {
  if (typeof toolCallId !== "string") return -1;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message && message.role === "tool" && message.toolCallId === toolCallId) return i;
  }
  return -1;
}

/**
 * 从「带 content 数组」的对象拼出文本：既适配 `tool_execution_end.result`
 * （`{ content, details }`），也适配 `ToolResultMessage`（两者都有 `content`）。
 */
function textOfToolContent(source) {
  if (!source || !Array.isArray(source.content)) return "";
  return source.content
    .filter((block) => block && block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** 该消息 content 里的 toolCall 块列表（非数组则空）。 */
function toolCallBlocks(message) {
  if (!message || !Array.isArray(message.content)) return [];
  return message.content.filter((block) => block && block.type === "toolCall");
}

/**
 * 应用一个**库事件**（pi-agent-core `AgentEvent`），把它映射到时间线。
 *
 * 纯函数：输入旧 state 返回新 state，绝不抛错（容忍乱序 / 重复 / 未知事件，
 * 与既有 `applyEvent` 的容忍风格一致）。
 *
 * @param {import("./conversationModel").ChatState} state
 * @param {import("@earendil-works/pi-agent-core").AgentEvent} ev
 * @returns {import("./conversationModel").ChatState}
 */
export function applyLibraryEvent(state, ev, nowMs) {
  if (ev === null || typeof ev !== "object") return state;
  const at = typeof nowMs === "number" ? nowMs : Date.now();

  switch (ev.type) {
    case "agent_start":
    case "turn_start":
    case "message_end":
    case "tool_execution_update":
      // 生命周期起止 / 中间结果：本层不改变时间线（S7 不渲染工具中间结果）。
      return state;

    case "message_start": {
      const message = ev.message;
      // 只对 assistant 建条目；toolResult 会由 tool_execution_* + turn_end 覆盖，其它 role 忽略。
      if (!message || message.role !== "assistant") return state;
      const last = lastAssistant(state);
      // 兼容：上层已调过 beginAssistant（最后一条 assistant 正在 streaming）→ 不重复追加。
      if (last && last.status === "streaming") return state;
      const seq = nextSeq(state);
      const entry = {
        id: `m${seq}`,
        role: "assistant",
        text: "",
        thinking: "",
        status: "streaming",
        startedAt: at,
      };
      // 同时把顶层状态推进到 streaming，使随后的 `applyEvent` 能生效。
      return {
        messages: [...state.messages, entry],
        status: "streaming",
        error: undefined,
        nextMessageSeq: seq + 1,
      };
    }

    case "message_update": {
      // ★ 关键：pi-ai 事件被包在 `assistantMessageEvent` 里，**顶层没有 delta**。
      // 原样委托给 `applyEvent`，让「从 text_delta 的 ev.delta 累积」的既有逻辑继续生效。
      const inner = ev.assistantMessageEvent;
      if (!inner || typeof inner !== "object") return state;
      return applyEvent(state, inner, at);
    }

    case "tool_execution_start": {
      const index = toolIndexOf(state.messages, ev.toolCallId);
      if (index !== -1) {
        // 乱序 / 重复：原地更新，不重复追加条目。
        const messages = state.messages.slice();
        messages[index] = { ...messages[index], toolName: ev.toolName, args: ev.args };
        return { ...state, messages };
      }
      const entry = {
        id: `tool:${ev.toolCallId}`,
        role: "tool",
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        // 库已把参数解析为对象，原样保存（不要自己拼 JSON）。
        args: ev.args,
        status: "running",
        resultText: "",
        isError: false,
        details: undefined,
        // 工具耗时打点（仅展示用）。
        startedAt: at,
        // ★ 权威 ToolResultMessage 在 turn_end 才拿得到（见下）。
        apiMessage: undefined,
      };
      return { ...state, messages: [...state.messages, entry] };
    }

    case "tool_execution_end": {
      const index = toolIndexOf(state.messages, ev.toolCallId);
      // 找不到条目（乱序：end 先于 start）：容忍，不抛错、不新建。
      if (index === -1) return state;
      const result = ev.result;
      const messages = state.messages.slice();
      messages[index] = {
        ...messages[index],
        status: ev.isError ? "error" : "done",
        resultText: textOfToolContent(result),
        isError: Boolean(ev.isError),
        details: result && typeof result === "object" ? result.details : undefined,
        endedAt: at,
      };
      return { ...state, messages };
    }

    case "turn_end": {
      let next = state;
      const message = ev.message;
      // ① 本轮 assistant 的权威落地（仅在确实是 assistant 时）。
      if (message && message.role === "assistant") {
        // 注意：`patchLastAssistant` 是**浅合并**，因此这里落的 `apiMessage`
        // 不会在随后的 `finish()`（同样只 patch `status`）时被冲掉。
        next = patchLastAssistant(next, {
          status: "done",
          text: textOfMessage(message),
          thinking: thinkingOfMessage(message),
          apiMessage: message,
          endedAt: at,
        });
      }
      // ② 用权威 ToolResultMessage 回填对应工具条目（按 toolCallId 配对）。
      const toolResults = Array.isArray(ev.toolResults) ? ev.toolResults : [];
      if (toolResults.length > 0) {
        const messages = next.messages.slice();
        let changed = false;
        for (const toolResult of toolResults) {
          if (!toolResult || typeof toolResult.toolCallId !== "string") continue;
          const index = toolIndexOf(messages, toolResult.toolCallId);
          if (index === -1) continue;
          messages[index] = {
            ...messages[index],
            status: toolResult.isError ? "error" : "done",
            resultText: textOfToolContent(toolResult),
            isError: Boolean(toolResult.isError),
            details: toolResult.details,
            apiMessage: toolResult,
          };
          changed = true;
        }
        if (changed) next = { ...next, messages };
      }
      // ③ ★ 绝不在此收敛：多步循环中途不得回到 idle。收敛只在 agent_end。
      return next;
    }

    case "agent_end": {
      // ★ 唯一收敛点。
      const messages = Array.isArray(ev.messages) ? ev.messages : [];
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant") {
        if (last.stopReason === "aborted") return finishAborted(state, at);
        if (last.stopReason === "error") {
          return finish(state, undefined, last.errorMessage ? last.errorMessage : "请求失败", at);
        }
      }
      // 正常结束：收敛为 idle，保留已累积文本与 turn_end 落地的 apiMessage。
      return finish(state, undefined, undefined, at);
    }

    default:
      // 未知事件：忽略（不抛错）。
      return state;
  }
}

/**
 * 把内存态消息历史转成 pi-ai 的 `Message[]`，供下一次请求使用。
 * - 用户消息 → UserMessage。
 * - 助手消息 → 复用其权威 `apiMessage`（finish / turn_end 时保存），保证是合法的 AssistantMessage。
 * - 工具条目 → 复用其权威 `apiMessage`（即 `turn_end.toolResults` 里的 ToolResultMessage 原件）。
 * 没有 apiMessage 的消息（如错误中断）会被跳过。
 *
 * ★ 两处「正确性兜底」（`Agent.continue()` 对末条 assistant 会直接 reject）：
 *   - **B-2**：为「最后一个含工具调用的 assistant」补齐未被覆盖的 toolResult
 *     （合成 `isError` 条目，覆盖「用户中止时工具未执行完成」这一场景）；
 *   - **R13**：剔除末尾「非完成态」的 assistant（stopped / error / streaming），
 *     使末条不可能是「半截」assistant。**完成态（done）的 assistant 一律保留**，
 *     这是既有行为（纯文本单轮 → `[user, assistant]`），不得回归。
 *
 * @param {import("./conversationModel").ChatState} state
 * @returns {import("@earendil-works/pi-ai").Message[]}
 */
export function toApiMessages(state) {
  /** @type {Array<any>} */
  const out = [];
  // 与 out 平行：assistant 条目的**源状态**（其它位置为 undefined），供 R13 判定。
  /** @type {Array<string | undefined>} */
  const sourceStatus = [];
  let timestamp = 1;

  for (const message of state.messages) {
    if (message.role === "user") {
      if (message.text.length > 0) {
        out.push({ role: "user", content: message.text, timestamp });
        sourceStatus.push(undefined);
        timestamp += 1;
      }
    } else if (message.role === "tool") {
      if (message.apiMessage) {
        out.push(message.apiMessage);
        sourceStatus.push(undefined);
        timestamp += 1;
      }
    } else if (message.apiMessage) {
      out.push(message.apiMessage);
      sourceStatus.push(message.status);
      timestamp += 1;
    }
  }

  // ---- B-2：补齐未被覆盖的工具结果 ----------------------------------------
  // 取「最后一个非 toolResult 条目」；若它是 assistant 且含 toolCall 块，
  // 则为每个「其后没有对应 toolResult」的 toolCall 追加一条合成结果。
  let lastNonToolResult = -1;
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (!(out[i] && out[i].role === "toolResult")) {
      lastNonToolResult = i;
      break;
    }
  }
  if (lastNonToolResult !== -1 && out[lastNonToolResult].role === "assistant") {
    const assistant = out[lastNonToolResult];
    const callBlocks = toolCallBlocks(assistant);
    if (callBlocks.length > 0) {
      const covered = new Set();
      for (let i = lastNonToolResult + 1; i < out.length; i += 1) {
        const entry = out[i];
        if (entry && entry.role === "toolResult" && typeof entry.toolCallId === "string") {
          covered.add(entry.toolCallId);
        }
      }
      for (const block of callBlocks) {
        if (typeof block.id !== "string" || covered.has(block.id)) continue;
        out.push({
          role: "toolResult",
          toolCallId: block.id,
          toolName: typeof block.name === "string" ? block.name : "",
          content: [{ type: "text", text: "用户已中止，该工具未执行完成。" }],
          isError: true,
          timestamp,
        });
        sourceStatus.push(undefined);
        timestamp += 1;
      }
    }
  }

  // ---- R13：绝不返回以「非完成态 assistant」结尾的转录 --------------------
  // 完成态（"done"）的 assistant 是正常答案，保留（既有行为）；
  // 仅剔除末尾的 stopped / error / streaming assistant，使末条不可能是「半截」assistant。
  while (out.length > 0) {
    const last = out[out.length - 1];
    const status = sourceStatus[sourceStatus.length - 1];
    if (last && last.role === "assistant" && status !== "done") {
      out.pop();
      sourceStatus.pop();
    } else {
      break;
    }
  }

  return out;
}
