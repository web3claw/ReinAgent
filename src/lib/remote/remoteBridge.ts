/**
 * remoteBridge —— 远程访问服务 ↔ 会话运行时的桥（webview 侧常驻监听器）。
 *
 * 架构对齐 LiveAgent「桌面事件唤醒 webview」模式：Rust remote_server 收到手机
 * 的 WS 请求后 emit 事件到这里，本模块调用 webview 内权威的会话运行时
 * （conversationPool / useAppStore），再把结果经命令推回 Rust 广播给手机端。
 *
 * - 桌面为唯一权威：审批决策走 resolveApproval（与本地审批卡同源）；
 * - 状态推送：订阅池通知 → 任务消息变化即向 Rust 推 remote_bridge_state；
 * - 快照：任务列表（task_list 命令缓存 + store）与单任务消息（池序列化）。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getTaskListCached } from "../storage/db";
import { getEntrySnapshot, subscribeTask, serializeEntry } from "../chat/conversationPool";

let started = false;
const unlisteners: UnlistenFn[] = [];
/** 每任务最近推送的 revision（节流：相同序列不重发）。 */
const pushedRevisions = new Map<string, number>();
let seq = 0;
/** 每任务 200ms 节流定时器（对齐池 notify 的微任务合并节奏）。 */
const pendingPush = new Map<string, number>();

function nextRevision(taskId: string): number {
  const current = pushedRevisions.get(taskId) ?? 0;
  const next = current + 1;
  pushedRevisions.set(taskId, next);
  return next;
}

/** 单任务当前消息序列（池 TimelineEntry → 精简 JSON；手机端渲染用）。 */
function collectTaskMessages(taskId: string): { messages: unknown; running: boolean } | null {
  const state = getEntrySnapshot(taskId);
  // 池未加载（从未打开过该任务）时返回 null：订阅应答会如实告知手机端「无数据」
  if (!state.messages.length && !state.status) return null;
  const messages = state.messages.map((entry, index) => {
    const row = serializeEntry(entry, index);
    return {
      role: row.role,
      text: row.parts.find((p) => p.kind === "text")?.payload
        ? (JSON.parse(row.parts.find((p) => p.kind === "text")!.payload) as { text?: string }).text ?? ""
        : "",
      thinking: row.parts.find((p) => p.kind === "thinking")
        ? (JSON.parse(row.parts.find((p) => p.kind === "thinking")!.payload) as { thinking?: string }).thinking ?? ""
        : "",
      toolName: row.tool_name ?? undefined,
      isError: row.is_error ?? undefined,
      resultText:
        row.parts.find((p) => p.kind === "tool_result")?.payload
          ? (JSON.parse(row.parts.find((p) => p.kind === "tool_result")!.payload) as { resultText?: string }).resultText ?? ""
          : undefined,
      status: row.status,
    };
  });
  const running =
    state.status === "streaming" ||
    state.messages.some((m) => m.status === "streaming" || m.status === "running" || m.status === "pending");
  return { messages, running };
}

function pushTaskState(taskId: string, force = false): void {
  if (!force && pendingPush.has(taskId)) return; // 已排程
  const timer = window.setTimeout(() => {
    pendingPush.delete(taskId);
    const collected = collectTaskMessages(taskId);
    if (!collected) return;
    void invoke("remote_bridge_state", {
      args: {
        taskId,
        revision: nextRevision(taskId),
        messages: collected.messages,
        running: collected.running,
      },
    }).catch(() => undefined);
  }, 200);
  pendingPush.set(taskId, timer);
}

/** 推送任务列表快照（列表变化 / hello 应答）。 */
function pushTaskList(): void {
  const tasks = getTaskListCached().map((row) => {
    try {
      const task = JSON.parse(row.payload) as { title?: string; createdAt?: number; updatedAt?: number };
      const state = getEntrySnapshot(row.id);
      const running =
        state.status === "streaming" ||
        state.messages.some((m) => m.status === "streaming" || m.status === "running" || m.status === "pending");
      return {
        id: row.id,
        title: task.title ?? "未命名任务",
        createdAt: task.createdAt,
        updatedAt: task.updatedAt ?? row.updated_at,
        running,
      };
    } catch {
      return { id: row.id, title: "未命名任务", updatedAt: row.updated_at };
    }
  });
  void invoke("remote_bridge_answer_snapshot", { tasks }).catch(() => undefined);
}

export function startRemoteBridge(): void {
  if (started) return;
  started = true;

  // 1. 手机请求快照（hello / list_tasks）
  void listen("remote-bridge:need-snapshot", () => {
    // pushTaskList 内部即调 answer（带真实列表）+ 广播
    pushTaskList();
  }).then((un) => unlisteners.push(un));

  // 2. 手机订阅单任务 → 立即推一次当前状态
  void listen<{ taskId: string }>("remote-bridge:need-state", (event) => {
    const taskId = event.payload.taskId;
    const collected = collectTaskMessages(taskId);
    if (!collected) {
      // 池未加载：回空状态（手机端显示「暂无消息」；桌面激活该任务时会推真实数据）
      void invoke("remote_bridge_answer_state", {
        args: { taskId, revision: nextRevision(taskId), messages: [], running: false },
      }).catch(() => undefined);
      return;
    }
    void invoke("remote_bridge_answer_state", {
      args: { taskId, revision: nextRevision(taskId), messages: collected.messages, running: collected.running },
    }).catch(() => undefined);
  }).then((un) => unlisteners.push(un));

  // 3. 手机发送消息 → App 暴露的远程发送桥（buildTurnOptions 同一闭包，选项与本地完全一致）
  void listen<{ taskId: string; text: string }>("remote-bridge:send", (event) => {
    const { taskId, text } = event.payload;
    const bridge = (window as unknown as Record<string, unknown>).__reinagentRemoteSend as
      | ((taskId: string, text: string) => boolean)
      | undefined;
    if (typeof bridge === "function") {
      const accepted = bridge(taskId, text);
      if (!accepted) {
        void invoke("remote_bridge_send_rejected", { taskId }).catch(() => undefined);
      }
    }
  }).then((un) => unlisteners.push(un));

  // 4. 手机审批应答 → resolveApproval（桌面权威）
  void listen<{ taskId: string; decision: unknown }>("remote-bridge:resolve", (event) => {
    void (async () => {
      const { resolveApproval } = await import("../chat/conversationPool");
      resolveApproval(event.payload.taskId, event.payload.decision as never);
    })();
  }).then((un) => unlisteners.push(un));

  // 5. 手机停止 → controller stop（与本地停止按钮同源）
  void listen<{ taskId: string }>("remote-bridge:stop", (event) => {
    void (async () => {
      const { stop } = await import("../chat/conversationPool");
      stop(event.payload.taskId);
    })();
  }).then((un) => unlisteners.push(un));

  // 6. 任务列表变化 → 重推快照
  void listen("remote-bridge:tasks-changed", () => pushTaskList()).then((un) => unlisteners.push(un));

  // 7. 订阅池：激活任务的消息变化实时推送（手机已订阅的任务）
  //    对未激活任务无法逐条订阅（池按需加载）——订阅请求到达时 ensureEntry
  //    会加载历史，之后 subscribeTask 生效。
  const watchTask = (taskId: string) => {
    subscribeTask(taskId, () => pushTaskState(taskId));
  };
  // 当前活动任务 + 已订阅任务都在 subscribe 应答时挂监听（need-state 处理器里顺带做）
  void listen<{ taskId: string }>("remote-bridge:need-state", (event) => {
    watchTask(event.payload.taskId);
  }).then((un) => unlisteners.push(un));

  seq += 1; // 防未用告警基准
}
