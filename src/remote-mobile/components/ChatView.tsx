/**
 * ChatView —— 手机端对话页：任务头卡 + 时间线（贴底跟随）+ 审批/提问/计划卡 + Composer。
 * 数据 = 远控 store 的 taskState（activeTaskId 订阅）+ taskOptions（模型/模式）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, LoaderIcon, MessageCirclePlus } from "lucide-react";
import type { RemoteAttachmentRef, RemoteProviderModels, TaskOptions } from "../api/protocol";
import {
  fetchTaskOptions,
  getRemoteSnapshot,
  resolveApproval,
  sendMessage,
  subscribeRemote,
  subscribeTask,
  unsubscribeTask,
} from "../api/client";
import { useSyncExternalStore } from "react";
import { Timeline } from "./Timeline";
import { RemoteComposer } from "./Composer";
import { RemoteApprovalCard, RemotePlanCard, RemoteQuestionCard } from "./ApprovalCards";
import { useRemoteT } from "../i18n";
import { cn } from "../lib/cn";

const STICK_THRESHOLD_PX = 120;

export function ChatView({
  activeTaskId,
  taskTitle,
  isDraft,
  models,
}: {
  activeTaskId: string | null;
  taskTitle: string;
  isDraft: boolean;
  models: RemoteProviderModels[] | null;
}) {
  const t = useRemoteT();
  const snapshot = useSyncExternalStore(subscribeRemote, getRemoteSnapshot);
  const taskState = activeTaskId ? snapshot.taskStates[activeTaskId] : undefined;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [options, setOptions] = useState<TaskOptions | null>(null);
  const [scrolledAway, setScrolledAway] = useState(false);

  // 切任务：退订旧任务、订阅新任务、重置贴底
  useEffect(() => {
    if (!activeTaskId) {
      setOptions(null);
      return;
    }
    subscribeTask(activeTaskId);
    setOptions(null);
    void fetchTaskOptions(activeTaskId)
      .then(setOptions)
      .catch(() => setOptions(null));
    stickRef.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    return () => {
      unsubscribeTask(activeTaskId);
    };
  }, [activeTaskId]);

  // 草稿态：选项走全局默认（taskId=null 语义）
  useEffect(() => {
    if (activeTaskId) return;
    void fetchTaskOptions(null)
      .then(setOptions)
      .catch(() => setOptions(null));
  }, [activeTaskId]);

  // 贴底跟随：内容增长时若仍在底部附近则贴底
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
    setScrolledAway(!stickRef.current);
  }, [taskState?.revision, taskState?.messages]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const following = distance < STICK_THRESHOLD_PX;
    stickRef.current = following;
    setScrolledAway(!following);
  };

  const pending = taskState?.pendingApproval ?? null;
  const pendingKind = (pending?.args as { kind?: string } | undefined)?.kind;
  const queuedMessages = useMemo(() => taskState?.queuedMessages ?? [], [taskState?.queuedMessages]);
  const messages = taskState?.messages ?? [];
  const truncatedTop = taskState !== undefined && messages.length >= 500;
  // 首帧未到（冷任务：桌面池水合中）→ 加载态，不用空态文案误导
  const awaitingFirstState = activeTaskId !== null && taskState === undefined;

  const handleSend = (text: string, attachments: RemoteAttachmentRef[]) => {
    void sendMessage({ taskId: activeTaskId, text, attachments });
    stickRef.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 任务头卡（ZCode 移动端同款：图标 + 标题截断，运行态由 composer spinner 表达） */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-header px-3 py-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface text-foreground-subtle">
          {isDraft ? <MessageCirclePlus className="size-4" /> : <FolderOpen className="size-4" />}
        </span>
        <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
          {taskTitle}
        </span>
      </div>

      {/* 时间线 */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {truncatedTop ? (
          <div className="py-2 text-center text-ui-xs text-foreground-subtlest">
            {t("remote.chat.loadHistoryMore")}
          </div>
        ) : null}
        {messages.length > 0 ? (
          <Timeline rows={messages} />
        ) : awaitingFirstState ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-ui-sm text-foreground-subtle">
            <LoaderIcon className="size-4 animate-spin" />
            <span>{t("remote.chat.loadingHistory")}</span>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-ui-sm text-foreground-subtlest">
            {t("remote.chat.emptyConversation")}
          </div>
        )}
        {/* 底部呼吸空间：审批卡出现前不顶贴底 */}
        <div className={cn("h-2", pending && "h-40")} />
      </div>

      {/* 审批/提问/计划卡（输入条上方） */}
      {pending && pendingKind === "question" ? (
        <RemoteQuestionCard
          pending={pending}
          onAnswer={(answers) => {
            if (activeTaskId) void resolveApproval(activeTaskId, { answers });
          }}
          onSkip={() => {
            if (activeTaskId) void resolveApproval(activeTaskId, "reject");
          }}
        />
      ) : pending && pendingKind === "plan" ? (
        <RemotePlanCard
          pending={pending}
          onApprove={() => {
            if (activeTaskId) void resolveApproval(activeTaskId, { approved: true });
          }}
          onReject={(feedback) => {
            if (activeTaskId) void resolveApproval(activeTaskId, { approved: false, feedback });
          }}
        />
      ) : pending ? (
        <RemoteApprovalCard
          pending={pending}
          onDecide={(decision) => {
            if (activeTaskId) void resolveApproval(activeTaskId, decision);
          }}
        />
      ) : null}

      {/* 回到底部 */}
      {scrolledAway ? (
        <button
          type="button"
          className="absolute bottom-24 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-toast px-3 py-1.5 text-ui-xs text-foreground shadow-lg"
          onClick={() => {
            stickRef.current = true;
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          ↓
        </button>
      ) : null}

      <RemoteComposer
        taskId={activeTaskId}
        running={taskState?.running ?? false}
        queuedMessages={queuedMessages}
        options={options}
        models={models}
        contextUsage={taskState?.contextUsage ?? null}
        onSend={handleSend}
        onOptionsChanged={() => {
          void fetchTaskOptions(activeTaskId)
            .then(setOptions)
            .catch(() => undefined);
        }}
      />
    </div>
  );
}
