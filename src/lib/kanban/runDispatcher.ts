/**
 * 看板卡片 headless 执行器（ROADMAP ⑤）：
 * 不自建执行器——复用 conversationPool 的完整能力（无 UI 执行/持久化/审批/
 * 终止/终态事件）；本模块只做「派发 + 事件驱动收敛 + 状态回写」三件事。
 *
 * 与 dispatchAutomationRun 的三处刻意差异（automation 链路不能直接复用）：
 * 1. **不抢前台**：createTask 会劫持 activeTaskId，这里保存并恢复；
 * 2. **事件驱动收敛**：订阅 subscribeTaskTerminal（含 awaitingDecision），
 *    替代 automation 的 5s 轮询——ask_user 挂起时 status 仍是 streaming，
 *    轮询永远等不到，而终态事件会带 awaitingDecision=true；
 * 3. **配置来自卡片**：provider/model 走卡片字段 + F20 同源解析；审批强制
 *    full（无人值守，用户拍板）；maxSteps 0（无上限）。
 */

import { invoke } from "@tauri-apps/api/core";
import { send as poolSend, resolveApproval, subscribeTaskTerminal } from "../chat/conversationPool";
import { useAppStore } from "../../store/useAppStore";
import { loadProvidersConfigFromDisk, providerAllowsMissingApiKey, type ProviderItem } from "../../components/settings/model-provider/types";
import { DEFAULT_SYSTEM_PROMPT } from "../providers/runAgentTurn";
import { resolveWorkspaceRoot } from "../agent/workspace";
import { buildCardBrief, resolveRunVerdict, type KanbanColumn } from "./model";
import { toast } from "../../components/lw/ui/toast";
import { pushNotification } from "../inbox/api";

export interface KanbanCardDto {
  cardId: string;
  title: string;
  description: string;
  column: KanbanColumn;
  priority: string;
  workspacePath: string;
  providerId: string;
  modelId: string;
  taskId: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface KanbanCommentDto {
  id: number;
  cardId: string;
  author: "user" | "agent" | "system";
  body: string;
  createdAt: number;
}

export interface KanbanRunDto {
  runId: string;
  cardId: string;
  taskId: string;
  trigger: string;
  status: string;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

const cards = new Map<string, KanbanCardDto>([
  // 运行时字段：卡片 → 当前 run（事件收敛时用来定位要结束哪个 run）
]);

function rememberCard(card: KanbanCardDto) {
  cards.set(card.cardId, card);
}

export async function kanbanListCards(): Promise<KanbanCardDto[]> {
  const list = await invoke<KanbanCardDto[]>("kanban_card_list");
  for (const card of list) rememberCard(card);
  return list;
}

export async function kanbanListComments(cardId: string): Promise<KanbanCommentDto[]> {
  return invoke<KanbanCommentDto[]>("kanban_comment_list", { cardId });
}

export async function kanbanListRuns(cardId: string): Promise<KanbanRunDto[]> {
  return invoke<KanbanRunDto[]>("kanban_run_list", { cardId });
}

export async function kanbanAddComment(cardId: string, body: string, author: "user" | "agent" | "system" = "user") {
  return invoke<KanbanCommentDto>("kanban_comment_add", { args: { cardId, author, body } });
}

async function moveCard(cardId: string, toColumn: KanbanColumn): Promise<void> {
  const moved = await invoke<KanbanCardDto>("kanban_card_move", {
    args: { cardId, toColumn },
  });
  rememberCard(moved);
}

async function finishRun(runId: string, status: string, error: string | null) {
  await invoke("kanban_run_finish", { runId, status, error }).catch((err) =>
    console.warn("[kanban] run_finish failed:", err),
  );
}

// ==================== 终态订阅（模块级单例）====================

/** taskId → 进行中的 run 上下文（终态到达时据此回写 run 与卡片列）。 */
interface ActiveRun {
  cardId: string;
  runId: string;
}
const activeRuns = new Map<string, ActiveRun>();
let subscribed = false;

function ensureTerminalSubscription(): void {
  if (subscribed) return;
  subscribed = true;
  subscribeTaskTerminal((event) => {
    const active = activeRuns.get(event.taskId);
    if (!active) return; // 非看板发起的回合，忽略
    activeRuns.delete(event.taskId);
    const verdict = resolveRunVerdict({
      taskId: event.taskId,
      outcome: event.outcome,
      error: event.error ?? null,
      awaitingDecision: event.awaitingDecision,
    });
    void (async () => {
      await finishRun(
        active.runId,
        verdict.runStatus,
        verdict.runStatus === "succeeded" ? null : (verdict as { error?: string; reason?: string }).error ?? (verdict as { reason?: string }).reason ?? null,
      );
      // 卡片列回写：succeeded→InReview / failed|blocked→Blocked。
      // ⚠ 从 InProgress 出发才合法（Rust 白名单）；读**数据库真实列**判断（内存缓存
      // 可能因 HMR/多实例而过期——本轮 E2E 实测踩中），非法迁移如实记日志不静默。
      const fresh = await invoke<KanbanCardDto>("kanban_card_get", { cardId: active.cardId }).catch(() => null);
      if (fresh) rememberCard(fresh);
      if (fresh && fresh.column === "InProgress") {
        await moveCard(active.cardId, verdict.nextColumn).catch((err) =>
          console.warn("[kanban] 卡片列回写失败:", err),
        );
      } else if (fresh) {
        console.warn("[kanban] 卡片不在 InProgress（当前 " + fresh.column + "），跳过终态列回写");
      }
      // Agent 结论入评论流（成功时）——看板详情的时间线由评论构成
      if (verdict.runStatus === "succeeded" && event.lastAssistantText?.trim()) {
        const clipped = event.lastAssistantText.trim().slice(0, 4000);
        await kanbanAddComment(active.cardId, clipped, "agent").catch(() => {});
      }
      if (verdict.runStatus === "blocked") {
        toast.warning(`看板卡片「${fresh?.title ?? active.cardId}」等待你的回答`);
        void pushNotification({
          categoryKey: `kanban:${active.cardId}`,
          kind: "kanban",
          title: fresh?.title ?? active.cardId,
          body: "等待你的回答（评论后自动重跑）",
          linkView: "kanban",
          linkTaskId: event.taskId,
        });
      } else if (verdict.runStatus === "failed") {
        toast.error(`看板卡片「${fresh?.title ?? active.cardId}」执行失败`);
        void pushNotification({
          categoryKey: `kanban:${active.cardId}`,
          kind: "kanban",
          title: fresh?.title ?? active.cardId,
          body: "执行失败（InReview 评论会打回 Todo 重跑）",
          linkView: "kanban",
          linkTaskId: event.taskId,
        });
      }
    })();
  });
}

// ==================== 派发 ====================

/** F20 同源解析：卡片指定的 provider → 否则全局默认；模型必属该 provider。 */
async function resolveCardModel(card: KanbanCardDto): Promise<
  { provider: ProviderItem; modelId: string; isDemo: boolean } | { error: string }
> {
  const providers = await loadProvidersConfigFromDisk().catch(() => [] as ProviderItem[]);
  const wantedProviderId = card.providerId.trim();
  let provider = wantedProviderId ? providers.find((p) => p.id === wantedProviderId) ?? null : null;
  if (!provider) {
    // 回退全局默认 provider（服务商设置里的默认模型指针）
    const { DEFAULT_SETTINGS } = await import("../../lib/settings/store");
    const fallbackId = DEFAULT_SETTINGS.provider;
    provider = providers.find((p) => p.id === fallbackId) ?? null;
  }
  if (!provider) {
    return { error: `服务商「${wantedProviderId || "默认"}」不存在，无法派发` };
  }
  if (provider.enabled === false) {
    return { error: `服务商「${provider.name || provider.id}」已停用` };
  }
  let modelId = card.modelId.trim();
  let model = modelId ? provider.models?.find((m) => m.id === modelId) ?? null : null;
  if (!model) {
    const fallbackModelId =
      provider.defaultModelId && provider.models?.some((m) => m.id === provider.defaultModelId)
        ? provider.defaultModelId
        : provider.models?.find((m) => m.enabled !== false)?.id ?? "";
    if (fallbackModelId) {
      modelId = fallbackModelId;
      model = provider.models?.find((m) => m.id === fallbackModelId) ?? null;
    }
  }
  if (!modelId || !model) {
    return { error: `服务商「${provider.name || provider.id}」下未找到可用模型` };
  }
  const apiKey = (provider.apiKey ?? "").trim();
  const isDemo = !apiKey && !providerAllowsMissingApiKey(provider);
  return { provider, modelId, isDemo };
}

/**
 * 派发卡片执行：绑会话（首次创建，不抢前台）→ run_start（单 run 查重）
 * → poolSend 简报。trigger: todo|comment|manual。
 */
export async function dispatchCard(cardId: string, trigger: "todo" | "comment" | "manual"): Promise<boolean> {
  ensureTerminalSubscription();
  // 一律读数据库（内存缓存可能因 HMR/多实例过期——每卡派发频率低，一次查询无成本）
  const card = await invoke<KanbanCardDto>("kanban_card_get", { cardId }).then((c) => {
    rememberCard(c);
    return c;
  });

  // 派发前按**合法路径**把卡片推进到 InProgress（终态回写 InReview/Blocked 只从
  // InProgress 出发才合法）。白名单：Backlog→Todo→InProgress，不能一步跳
  // （本轮实测：直接 Backlog→InProgress 被状态机正确拒绝）。
  const path: KanbanColumn[] =
    card.column === "Todo" ? ["InProgress"] : card.column === "InProgress" ? [] : ["Todo", "InProgress"];
  let currentColumn = card.column;
  for (const step of path) {
    try {
      const advanced = await invoke<KanbanCardDto>("kanban_card_move", {
        args: { cardId, toColumn: step },
      });
      rememberCard(advanced);
      currentColumn = advanced.column;
    } catch (err) {
      console.warn("[kanban] 推进 " + step + " 失败（终态可能不回写）:", err);
      break;
    }
  }
  if (currentColumn !== "InProgress") {
    console.warn("[kanban] 卡片未能进入 InProgress（当前 " + currentColumn + "），本轮仍执行但终态不回写列");
  }

  const resolved = await resolveCardModel(card);
  if ("error" in resolved) {
    toast.error(`看板派发失败：${resolved.error}`);
    await kanbanAddComment(cardId, `[系统] 派发失败：${resolved.error}`, "system").catch(() => {});
    return false;
  }
  const { provider, modelId, isDemo } = resolved;

  // 1. 绑定持久会话（首次）：createTask 会劫持 activeTaskId → 保存并恢复
  let taskId = card.taskId;
  if (!taskId) {
    const store = useAppStore.getState();
    const previousActive = store.activeTaskId;
    taskId = store.createTask(card.title, card.workspacePath || null, provider.id, modelId, undefined, "full", "kanban");
    // 不抢前台：恢复原活动任务（看板执行是后台行为）
    useAppStore.getState().setActiveTaskId(previousActive);
    await invoke("kanban_card_set_task", { cardId, taskId }).catch((err) =>
      console.warn("[kanban] 绑定会话失败:", err),
    );
    card.taskId = taskId;
    rememberCard(card);
  }

  // 2. run 记账（每卡单 run 由 Rust 部分唯一索引兜底）
  const started = await invoke<{ runId: string; started: boolean }>("kanban_run_start", {
    args: { cardId, taskId, trigger },
  }).catch((err) => {
    toast.error(`看板派发失败：${err instanceof Error ? err.message : err}`);
    return null;
  });
  if (!started || !started.started) {
    if (started) toast.warning("该卡片已有正在执行的任务");
    return false;
  }

  // 3. 组装简报（标题/描述/优先级/约定/评论）并派发
  const comments = await kanbanListComments(cardId).catch(() => [] as KanbanCommentDto[]);
  const brief = buildCardBrief(
    {
      title: card.title,
      description: card.description,
      priority: card.priority,
      workspacePath: card.workspacePath,
      column: card.column,
    },
    comments.map((c) => ({ author: c.author, body: c.body })),
  );

  activeRuns.set(taskId, { cardId, runId: started.runId });

  const accepted = poolSend(taskId, brief, {
    source: isDemo ? "faux" : (provider.id as never),
    config: {
      provider: provider.id as never,
      apiKey: provider.apiKey ?? "",
      modelId,
      baseUrl: provider.baseUrl ?? "",
      apiFormat: provider.apiFormat,
      hasEffort: true,
      contextWindow: provider.models?.find((m) => m.id === modelId)?.contextWindow ?? null,
      maxOutputTokens: provider.models?.find((m) => m.id === modelId)?.maxOutputTokens ?? null,
      supportsImage: provider.models?.find((m) => m.id === modelId)?.supportsImage ?? null,
    },
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    maxSteps: 0,
    workspaceRoot: resolveWorkspaceRoot(card.workspacePath || null),
    thinkingLevel: undefined,
    approvalMode: "full",
  });

  if (!accepted) {
    activeRuns.delete(taskId);
    await finishRun(started.runId, "failed", "派发被拒绝（会话池繁忙）");
    toast.error("看板派发被拒绝：会话池繁忙，请稍后重试");
    return false;
  }
  return true;
}

/**
 * 卡片拖入 Todo（或从 InReview/Blocked 评论后重跑）：先迁移列再派发。
 * 非法迁移由 Rust 拒绝（前端 isValidTransition 已前置拦截）。
 */
export async function moveCardAndMaybeRun(cardId: string, toColumn: KanbanColumn): Promise<void> {
  await moveCard(cardId, toColumn);
  if (toColumn === "Todo") {
    await dispatchCard(cardId, "todo");
  }
}

/**
 * Blocked 卡片上用户回答（ask_user 挂起中）：把回答作为审批决策回灌，
 * 唤醒挂起的提问工具，回合继续跑（run 仍在 running，不新建 run）。
 * @returns true = 已回灌到挂起的提问；false = 没有挂起（走了普通评论重跑）
 */
export async function answerBlockedCard(cardId: string, answerText: string): Promise<boolean> {
  const card = cards.get(cardId);
  if (!card?.taskId) return false;
  const { getEntrySnapshot } = await import("../chat/conversationPool");
  const snapshot = getEntrySnapshot(card.taskId);
  if (!snapshot?.pendingApproval) return false;
  // ask_user 的结构化回答：{ answers: [{ questionIndex, answer }] }（单选/文本）
  resolveApproval(card.taskId, { answers: [{ questionIndex: 0, answer: answerText }] });
  await kanbanAddComment(cardId, answerText, "user").catch(() => {});
  await moveCard(cardId, "InProgress").catch(() => {});
  return true;
}

/** 关闭/清理时的活期 run 映射（测试与调试用）。 */
export function __resetActiveRuns(): void {
  activeRuns.clear();
  cards.clear();
}

/** 供 UI 查询某卡是否正在执行（事件订阅之外的乐观提示）。 */
export function isCardRunning(cardId: string): boolean {
  for (const run of activeRuns.values()) if (run.cardId === cardId) return true;
  return false;
}
