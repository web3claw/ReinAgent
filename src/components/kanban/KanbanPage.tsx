/**
 * 看板页（ROADMAP ⑤）：7 列横排 + HTML5 原生拖拽 + 卡片详情弹窗。
 *
 * 交互语义（对齐 Hetu）：
 * - 卡片拖进 Todo → 触发无人值守执行（Rust 状态机校验 + 单 run 查重）；
 * - InReview/Blocked 下添加评论 → 打回 Todo 重跑（评论成为下一轮要求）；
 * - Blocked 且有挂起提问时，评论=回答（回灌 ask_user 续跑）。
 * 运行中卡片显示 Loader（复用池的 streaming 订阅）。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import {
  KANBAN_COLUMNS,
  KANBAN_PRIORITIES,
  isValidTransition,
  priorityBarClass,
  type KanbanColumn,
} from "../../lib/kanban/model";
import {
  answerBlockedCard,
  dispatchCard,
  isCardRunning,
  kanbanAddComment,
  kanbanListCards,
  kanbanListComments,
  kanbanListRuns,
  moveCardAndMaybeRun,
  type KanbanCardDto,
  type KanbanCommentDto,
  type KanbanRunDto,
} from "../../lib/kanban/runDispatcher";
import { subscribeStreaming } from "../../lib/chat/conversationPool";
import { useAppStore } from "../../store/useAppStore";
import { toast } from "../lw/ui/toast";
import { invoke } from "@tauri-apps/api/core";
import { Plus, Loader2, X, MessageSquare, Clock, Trash2 } from "lucide-react";

const PRIORITY_LABEL: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
  urgent: "紧急",
};

export function KanbanPage({ workspacePath }: { providers?: unknown[]; workspacePath: string }) {
  const { t } = useTranslation();
  const [cards, setCards] = useState<KanbanCardDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailCardId, setDetailCardId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [dragCardId, setDragCardId] = useState<string | null>(null);
  const [streamingTaskIds, setStreamingTaskIds] = useState<ReadonlySet<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const list = await kanbanListCards();
      setCards(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 运行中标记：复用池的流式订阅（与侧栏任务徽标同源）
  useEffect(() => {
    const apply = () => {
      const ids = new Set<string>();
      for (const card of cards) if (card.taskId) ids.add(card.taskId);
      setStreamingTaskIds(new Set([...ids]));
    };
    apply();
    return subscribeStreaming(() => {
      apply();
      void refresh();
    });
  }, [cards, refresh]);

  const runningTaskIds = useMemo(() => {
    const running = new Set<string>();
    for (const card of cards) {
      if (card.taskId && (streamingTaskIds.has(card.taskId) || isCardRunning(card.cardId))) {
        running.add(card.cardId);
      }
    }
    return running;
  }, [cards, streamingTaskIds]);

  const byColumn = useMemo(() => {
    const map = new Map<KanbanColumn, KanbanCardDto[]>();
    for (const col of KANBAN_COLUMNS) map.set(col, []);
    for (const card of cards) {
      const bucket = map.get(card.column);
      if (bucket) bucket.push(card);
    }
    for (const bucket of map.values()) bucket.sort((a, b) => a.sortOrder - b.sortOrder || b.updatedAt - a.updatedAt);
    return map;
  }, [cards]);

  async function handleDrop(toColumn: KanbanColumn) {
    const cardId = dragCardId;
    setDragCardId(null);
    if (!cardId) return;
    const card = cards.find((c) => c.cardId === cardId);
    if (!card) return;
    if (card.column === toColumn) return;
    if (!isValidTransition(card.column, toColumn)) {
      toast.warning(`不允许从 ${card.column} 直接拖到 ${toColumn}`);
      return;
    }
    try {
      await moveCardAndMaybeRun(cardId, toColumn);
      await refresh();
    } catch (err) {
      toast.error(`移动失败：${err instanceof Error ? err.message : err}`);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--text-dim)]">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)]">
      <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border)] shrink-0">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold">{t("kanbanTitle", "看板")}</h2>
          <span className="text-xs text-[var(--text-dim)]">
            {t("kanbanHint", "拖入 Todo 触发执行 · InReview/Blocked 下评论会重跑")}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[var(--accent)] text-white text-sm hover:bg-[var(--accent-dim)] cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          {t("kanbanNewCard", "新建卡片")}
        </button>
      </div>

      {error ? (
        <div className="m-4 rounded-lg border border-[var(--status-err,red)] p-3 text-sm text-[var(--status-err,red)] break-all">
          {error}
        </div>
      ) : null}

      <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden p-4">
        <div className="flex gap-3 h-full min-h-0">
          {KANBAN_COLUMNS.map((column) => {
            const items = byColumn.get(column) ?? [];
            return (
              <div
                key={column}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  void handleDrop(column);
                }}
                className="flex w-64 shrink-0 flex-col min-h-0 rounded-xl border border-[var(--border)] bg-[var(--bg-elev)]"
              >
                <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)] shrink-0">
                  <span className="text-xs font-medium text-[var(--text)]">{columnLabel(column, t as (key: string, fallback?: string) => string)}</span>
                  <span className="text-[11px] text-[var(--text-dim)]">{items.length}</span>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
                  {items.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-[var(--border)] p-3 text-center text-[11px] text-[var(--text-dim)]">
                      {t("kanbanEmptyColumn", "拖卡片到这里")}
                    </div>
                  ) : (
                    items.map((card) => (
                      <div
                        key={card.cardId}
                        draggable
                        onDragStart={() => setDragCardId(card.cardId)}
                        onDragEnd={() => setDragCardId(null)}
                        onClick={() => setDetailCardId(card.cardId)}
                        className={`relative cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2.5 pl-3 transition-colors hover:border-[var(--accent)] ${
                          dragCardId === card.cardId ? "opacity-50" : ""
                        }`}
                      >
                        <span className={`absolute left-0 top-0 h-full w-1 rounded-l-lg ${priorityBarClass(card.priority)}`} />
                        <div className="flex items-start gap-1.5">
                          <span className="flex-1 text-xs font-medium text-[var(--text)] break-words">{card.title}</span>
                          {runningTaskIds.has(card.cardId) ? (
                            <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-[var(--accent)]" />
                          ) : null}
                          {card.column === "Blocked" ? (
                            <span className="size-2 shrink-0 rounded-full bg-red-500" title={t("kanbanBlockedHint", "等待你的回答")} />
                          ) : null}
                        </div>
                        {card.description ? (
                          <p className="mt-1 text-[11px] text-[var(--text-dim)] line-clamp-2 break-words">{card.description}</p>
                        ) : null}
                        <div className="mt-1.5 flex items-center gap-2 text-[10px] text-[var(--text-dim)]">
                          <span>{PRIORITY_LABEL[card.priority] ?? card.priority}</span>
                          {card.workspacePath ? <span className="truncate">{card.workspacePath.split(/[\\/]/).pop()}</span> : null}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {showCreate ? (
        <CreateCardDialog
          workspacePath={workspacePath}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void refresh();
          }}
        />
      ) : null}

      {detailCardId ? (
        <CardDetailDialog
          cardId={detailCardId}
          onClose={() => setDetailCardId(null)}
          onChanged={() => void refresh()}
        />
      ) : null}
    </div>
  );
}

function columnLabel(column: KanbanColumn, t: (key: string, fallback?: string) => string): string {
  const map: Record<KanbanColumn, [string, string]> = {
    Backlog: ["kanbanColBacklog", "待规划"],
    Todo: ["kanbanColTodo", "待执行"],
    InProgress: ["kanbanColInProgress", "执行中"],
    InReview: ["kanbanColInReview", "待验收"],
    Blocked: ["kanbanColBlocked", "阻塞"],
    Done: ["kanbanColDone", "完成"],
    Archived: ["kanbanColArchived", "归档"],
  };
  const [key, fallback] = map[column];
  return t(key, fallback);
}

// ==================== 新建卡片 ====================

function CreateCardDialog({
  workspacePath,
  onClose,
  onCreated,
}: {
  workspacePath: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("medium");
  const [workspace, setWorkspace] = useState(workspacePath || "");
  const [column, setColumn] = useState<KanbanColumn>("Backlog");
  const [busy, setBusy] = useState(false);

  async function handleCreate() {
    if (!title.trim()) {
      toast.warning(t("kanbanTitleRequired", "请填写卡片标题"));
      return;
    }
    setBusy(true);
    try {
      const created = await invoke<KanbanCardDto>("kanban_card_create", {
        args: { title: title.trim(), description, priority, workspacePath: workspace, column },
      });
      // 直接建在 Todo 也触发执行（与拖拽同语义）
      if (created.column === "Todo") {
        await dispatchCard(created.cardId, "todo");
      }
      toast.success(t("kanbanCreated", "卡片已创建"));
      onCreated();
    } catch (err) {
      toast.error(`创建失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        className="w-[520px] max-w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-2xl space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">{t("kanbanNewCard", "新建卡片")}</span>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-[var(--surface-hover)] cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("kanbanCardTitlePlaceholder", "卡片标题")}
          className="w-full h-9 rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none focus:border-[var(--accent)]"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("kanbanCardDescPlaceholder", "任务描述（会作为执行简报发给模型）")}
          rows={4}
          className="w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--accent)] resize-none"
        />
        <div className="grid grid-cols-3 gap-2">
          <label className="text-xs text-[var(--text-dim)]">
            {t("kanbanPriority", "优先级")}
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              className="mt-1 w-full h-8 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-xs"
            >
              {KANBAN_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-[var(--text-dim)]">
            {t("kanbanColumn", "列")}
            <select
              value={column}
              onChange={(e) => setColumn(e.target.value as KanbanColumn)}
              className="mt-1 w-full h-8 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-xs"
            >
              {["Backlog", "Todo"].map((c) => (
                <option key={c} value={c}>
                  {columnLabel(c as KanbanColumn, t as (key: string, fallback?: string) => string)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-[var(--text-dim)]">
            {t("kanbanWorkspace", "工作区")}
            <input
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              className="mt-1 w-full h-8 rounded-lg border border-[var(--border)] bg-transparent px-2 text-xs outline-none focus:border-[var(--accent)]"
            />
          </label>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="h-8 px-3 rounded-lg border border-[var(--border)] text-sm hover:bg-[var(--surface-hover)] cursor-pointer"
          >
            {t("cancel", "取消")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleCreate()}
            className="h-8 px-3 rounded-lg bg-[var(--accent)] text-white text-sm disabled:opacity-40 cursor-pointer"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t("kanbanCreate", "创建")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ==================== 卡片详情 ====================

function CardDetailDialog({
  cardId,
  onClose,
  onChanged,
}: {
  cardId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [comments, setComments] = useState<KanbanCommentDto[]>([]);
  const [runs, setRuns] = useState<KanbanRunDto[]>([]);
  const [card, setCard] = useState<KanbanCardDto | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [c, cs, rs] = await Promise.all([
      invoke<KanbanCardDto>("kanban_card_get", { cardId }),
      kanbanListComments(cardId).catch(() => []),
      kanbanListRuns(cardId).catch(() => []),
    ]);
    setCard(c);
    setComments(cs);
    setRuns(rs);
  }, [cardId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleSubmitComment() {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    try {
      // Blocked + 有挂起提问 → 评论作为回答回灌（续跑，不新建 run）
      const answered = card?.column === "Blocked" ? await answerBlockedCard(cardId, body) : false;
      if (!answered) {
        await kanbanAddComment(cardId, body, "user");
        // InReview/Blocked 下评论 → 打回 Todo 重跑（Hetu 语义）
        if (card && (card.column === "InReview" || card.column === "Blocked")) {
          await moveCardAndMaybeRun(cardId, "Todo");
          await dispatchCard(cardId, "comment");
        }
      }
      setDraft("");
      await refresh();
      onChanged();
    } catch (err) {
      toast.error(`提交失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    try {
      await invoke("kanban_card_delete", { cardId });
      toast.success(t("kanbanDeleted", "卡片已删除"));
      onClose();
      onChanged();
    } catch (err) {
      toast.error(`删除失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  }

  function openTaskSession() {
    if (!card?.taskId) return;
    useAppStore.getState().setCurrentView("workbench");
    useAppStore.getState().setActiveTaskId(card.taskId);
  }

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        className="flex h-[80%] w-[640px] max-w-full flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] shrink-0">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{card?.title ?? cardId}</div>
            <div className="mt-0.5 text-[11px] text-[var(--text-dim)]">
              {card ? columnLabel(card.column as KanbanColumn, t as (key: string, fallback?: string) => string) : ""} · {PRIORITY_LABEL[card?.priority ?? ""] ?? ""}
            </div>
          </div>
          <div className="flex items-center gap-1">
            {card?.taskId ? (
              <button
                type="button"
                onClick={openTaskSession}
                className="h-7 px-2 rounded-lg border border-[var(--border)] text-xs hover:bg-[var(--surface-hover)] cursor-pointer"
              >
                {t("kanbanOpenSession", "打开会话")}
              </button>
            ) : null}
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleDelete()}
              className="p-1.5 rounded-lg hover:bg-[var(--surface-hover)] text-[var(--status-err,red)] cursor-pointer disabled:opacity-40"
              title={t("kanbanDeleteCard", "删除卡片")}
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--surface-hover)] cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {card?.description ? (
          <div className="px-4 py-2 text-xs text-[var(--text-dim)] border-b border-[var(--border)] shrink-0 whitespace-pre-wrap break-words">
            {card.description}
          </div>
        ) : null}

        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
          {comments.length === 0 ? (
            <div className="text-xs text-[var(--text-dim)] p-2">{t("kanbanNoComments", "还没有评论")}</div>
          ) : (
            comments.map((comment) => (
              <div key={comment.id} className="rounded-lg border border-[var(--border)] p-2 text-xs">
                <div className="mb-1 flex items-center gap-2 text-[11px] text-[var(--text-dim)]">
                  <span className="font-medium text-[var(--text)]">{comment.author}</span>
                  <span>{new Date(comment.createdAt).toLocaleString()}</span>
                </div>
                <div className="whitespace-pre-wrap break-words">{comment.body}</div>
              </div>
            ))
          )}
          {runs.length > 0 ? (
            <div className="pt-2">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] text-[var(--text-dim)]">
                <Clock className="w-3 h-3" />
                {t("kanbanRunHistory", "运行历史")}
              </div>
              {runs.map((run) => (
                <div key={run.runId} className="flex items-center gap-2 py-0.5 text-[11px] text-[var(--text-dim)]">
                  <span
                    className={`size-1.5 rounded-full ${
                      run.status === "succeeded"
                        ? "bg-emerald-500"
                        : run.status === "running"
                          ? "bg-blue-500 animate-pulse"
                          : run.status === "blocked"
                            ? "bg-amber-500"
                            : "bg-red-500"
                    }`}
                  />
                  <span>{run.status}</span>
                  <span>{run.trigger}</span>
                  <span className="ml-auto">{new Date(run.createdAt).toLocaleString()}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="border-t border-[var(--border)] p-2 shrink-0">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            placeholder={
              card?.column === "Blocked"
                ? t("kanbanAnswerPlaceholder", "回答模型的提问（续跑）…")
                : card?.column === "InReview"
                  ? t("kanbanCommentRerunPlaceholder", "提出修改要求（提交后会重新执行）…")
                  : t("kanbanCommentPlaceholder", "添加评论…")
            }
            className="w-full rounded-lg border border-[var(--border)] bg-transparent px-2.5 py-1.5 text-xs outline-none resize-none focus:border-[var(--accent)]"
          />
          <div className="mt-1 flex justify-end">
            <button
              type="button"
              disabled={busy || !draft.trim()}
              onClick={() => void handleSubmitComment()}
              className="flex items-center gap-1 h-7 px-2.5 rounded-lg bg-[var(--accent)] text-white text-xs disabled:opacity-40 cursor-pointer"
            >
              <MessageSquare className="w-3.5 h-3.5" />
              {t("kanbanSendComment", "提交")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
