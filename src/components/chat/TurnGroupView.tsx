/**
 * TurnGroupView —— 单轮对话的分组渲染（对齐 ZCode ConversationTurnGroup / AssistantHistoryStatus）。
 *
 * 结构（自上而下）：
 *   1. 用户消息行（复用 MessageItem 用户分支）；
 *   2. 回合工作状态条：「工作中 {时长}」（运行中，每秒跳动、锁定展开不可收起）/
 *      「已工作 {时长}」（完成，默认折叠可展开）/「已停止」/「已处理」（历史无打点，No-Fallback）；
 *   3. 折叠体：思考块（ThinkingBlock）+ 工具调用卡（ToolCallCard）+ 中间叙述文本；
 *      运行中最后一条 assistant 的正文**就地**渲染在折叠体的时间线位置（亮色 + 流式指示器）；
 *   4. 最终回复正文（轮内最后一条 assistant，复用 MessageItem 助手分支）：**轮结束后**外显。
 *
 * 时间线不变式（对齐 ZCode orderedRows 严格按产出顺序渲染）：工具条目在状态机里诞生于
 * 所属 assistant 消息之后，因此「运行中正文就地、结束后外显」的首尾位置一致——工具卡
 * 出现时必然落在正文下方且不再移动，轮次切换不再发生上下跳动（修复卡片位置漂移）。
 *
 * 折叠交互对齐 ZCode：运行中是「只读展开」（不渲染箭头、不可收起）；完成态翻转为默认折叠、
 * 可点击展开。轮 key 变化时组件随 React key 重挂载，折叠态自然复位。
 */

import { ChevronRight } from "lucide-react";
import type { TimelineEntry, ToolTimelineEntry } from "../../lib/chat/conversationModel";
import { MessageItem } from "./MessageItem";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";
import { MarkdownText } from "./MarkdownText";
import { ChatLoading } from "./ChatLoading";
import { CompactionBand } from "./CompactionBand";
import { isCompactEntry } from "../../lib/chat/compaction";
import { useTranslation } from "../../i18n";
import { memo, useMemo, useRef, useState } from "react";
import {
  buildActivitySegments,
  buildUnifiedPatch,
  collectTurnFileChanges,
  computeLineChangeStat,
  effectiveWorkMs,
  formatWorkDuration,
  isAttentionRequired,
  isReinAgentTempPath,
  pathDirectory,
  resolveTurnWorkState,
  turnDurationMs,
  type TurnGroup,
} from "../../lib/chat/turnActivity";
import { useAppStore } from "../../store/useAppStore";
import { WebSearchGroupCard } from "./WebSearchGroupCard";
import { buildAssistantCodeCommentCards, projectAssistantCodeComments } from "../../lib/chat/codeComment/assistantCodeComment";
import { AssistantCodeCommentCards } from "./AssistantCodeCommentCards";

function isToolEntry(message: TimelineEntry): message is ToolTimelineEntry {
  return message.role === "tool";
}

/**
 * 「查阅」聚合卡已移除（2026-09-27 用户决策）：查阅族工具（list_dir / read_file）不再
 * 聚合为组卡，直接以独立卡渲染（对齐 ZCode ReadToolCallBlock 的独立形态——图标 + 文件名
 * + 路径；成功不显示状态词，失败才显示「执行失败」并带 tooltip）。
 */

export interface TurnGroupViewProps {
  /** 本轮正在流式（代码高亮等昂贵渲染降级，完成后恢复） */
  streaming?: boolean;
  /** 本轮的自动重试记录（重试详情块数据源；仅实时轮传入） */
  retryAttempts?: import("../../lib/chat/conversationModel").RetryAttemptRecord[];
  /** 是否处于自动重试等待期（「重新连接中」副行显示条件，对齐 LiveAgent 恢复后撤下）。 */
  retrying?: boolean;
  group: TurnGroup;
  /** 每秒刷新的当前时间（MessageList live tick），仅运行中轮用于工时跳动。 */
  liveNowMs: number;
  /**
   * 本轮是否为「实时轮」（Agent 循环仍在流式中的最后一轮）。
   * 工具循环的轮与轮之间存在瞬态空窗（上一轮已 done、下一轮未建条目），
   * 仅凭条目状态判 running 会导致状态条/思考块闪烁——以会话级流式状态兜住。
   */
  live?: boolean;
  workspaceRoot?: string;
  /** 追加发送新消息（「已达最大步数 → 继续」）。 */
  onEditSend?: (newText: string) => void;
  /** 编辑重发（硬截断该轮及其后内容后以新文本重跑）。 */
  onEditResend?: (messageId: string, text: string, attachments: import("../../lib/chat/attachments").UserAttachmentRef[]) => void;
  /** 单值编辑态（MessageList 下发）：仅锚点命中的轮进入编辑。 */
  isEditing?: boolean;
  onStartEdit?: (messageId: string) => void;
  onCancelEdit?: () => void;
  /** 以原始提问重发该轮（重试 = 截断该回复及其后内容后重跑）。 */
  onRetryFrom?: (messageId: string) => void;
  /** 从某条回复创建分支（复制前缀进新任务并切换）。 */
  onBranchFrom?: (messageId: string) => void;
  /** 发送/流式中禁用全部行内动作（对齐 LiveAgent isSending）。 */
  actionsDisabled?: boolean;
  /** 搜索跳转定位高亮：命中的消息 id（user/assistant 行短暂亮边）。 */
  highlightMessageId?: string | null;
  /**
   * 会话级挂起审批（ChatState.pendingApproval）：存在时本轮进入 attention 态——
   * 状态条强制展开、显示「等待你的决定」且不可折叠（对齐 LiveAgent attentionRequired）。
   */
  pendingApproval?: unknown;
  /**
   * 页面隐藏时段（[hiddenAt, visibleAt]，末段可开区间）：运行中轮的工时折算用
   * ——隐藏窗口停表（对齐 LiveAgent：切后台/最小化期间不计入工作耗时）。
   */
  hiddenSpans?: Array<[number, number]>;
}

/** 折叠体内「中间叙述」的暗色正文（非最终回复的 assistant 文本）。 */
function IntermediateText({ entry, streaming }: { entry: TimelineEntry; streaming?: boolean }) {
  if (entry.role !== "assistant" || !entry.text) return null;
  return (
    <div className="turn-intermediate-text font-[450] text-[var(--text)] leading-relaxed">
      <MarkdownText text={entry.text} streaming={streaming} />
    </div>
  );
}


/** 文件更改摘要卡（对齐 ZCode ConversationFileSummaryPanel 的轻量宿主版）：
 * 数据由轮内 edit/write 条目客户端现算；审查 → 右侧面板 patch 模式；打开 → 文件预览。 */
function TurnFileSummaryCard({ entries, workspaceRoot }: { entries: TimelineEntry[]; workspaceRoot?: string }) {
  const { t } = useTranslation();
  const openCodeViewer = useAppStore((state) => state.openCodeViewer);
  const [open, setOpen] = useState(true);
  // 临时目录清理：idle → confirm（3 秒无操作回退）→ cleaning → done/error
  const [cleanState, setCleanState] = useState<"idle" | "confirm" | "cleaning" | "done" | "error">("idle");
  const [cleanMsg, setCleanMsg] = useState<string | null>(null);
  const confirmTimerRef = useRef<number | null>(null);

  const handleCleanup = async () => {
    if (cleanState === "idle") {
      setCleanState("confirm");
      confirmTimerRef.current = window.setTimeout(() => setCleanState("idle"), 3000);
      return;
    }
    if (confirmTimerRef.current) {
      window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
    setCleanState("cleaning");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const res = await invoke<{ deleted_entries: number }>("fs_clean_reinagent_tmp", {
        workspaceRoot: workspaceRoot ?? "",
      });
      setCleanState("done");
      setCleanMsg(t("tmpCleanDone").replace("{count}", String(res.deleted_entries)));
    } catch (err) {
      setCleanState("error");
      setCleanMsg(err instanceof Error ? err.message : String(err));
    }
    window.setTimeout(() => {
      setCleanState("idle");
      setCleanMsg(null);
    }, 3000);
  };

  const cleanupLabel =
    cleanState === "confirm"
      ? t("tmpCleanConfirm")
      : cleanState === "cleaning"
        ? t("tmpCleanBusy")
        : cleanState === "done"
          ? cleanMsg
          : cleanState === "error"
            ? cleanMsg
            : t("tmpCleanButton");

  // 同一文件在一轮内被多次编辑时按路径聚合：original 取第一次编辑前、final 取最后一次编辑后，
  // 只显示净变更（对齐 ZCode taskChangeSummary 的按路径合并语义）。
  // `.ReinAgent/temp/` 下的一次性脚本不进摘要（不列行、不计入数量与增删统计）。
  const changes = useMemo(() => {
    const byPath = new Map<string, { path: string; originalContent: string; finalContent: string }>();
    for (const change of collectTurnFileChanges(entries)) {
      if (isReinAgentTempPath(change.path)) continue;
      const existing = byPath.get(change.path);
      if (existing) {
        existing.finalContent = change.finalContent;
      } else {
        byPath.set(change.path, { ...change });
      }
    }
    return Array.from(byPath.values());
  }, [entries]);
  const files = useMemo(
    () =>
      changes.map(({ path, originalContent, finalContent }) => {
        const stat = computeLineChangeStat(originalContent, finalContent);
        return {
          path,
          basename: path.replace(/[\/]+$/, "").split(/[\/]/).pop() || path,
          dir: pathDirectory(path),
          added: stat.added,
          removed: stat.removed,
          originalContent,
          finalContent,
        };
      }),
    [changes]
  );

  // 净变更为零的文件（编辑后又改回去）不显示
  const visibleFiles = files.filter((f) => f.added !== 0 || f.removed !== 0);
  if (visibleFiles.length === 0) return null;
  const added = visibleFiles.reduce((sum, f) => sum + f.added, 0);
  const removed = visibleFiles.reduce((sum, f) => sum + f.removed, 0);

  return (
    <div className="turn-file-summary">
      <button
        type="button"
        className="turn-file-summary-trigger"
        aria-expanded={open}
        onClick={() => setOpen((cur) => !cur)}
      >
        <ChevronRight
          className={`w-3.5 h-3.5 shrink-0 transition-transform text-[var(--text-dim)] ${
            open ? "rotate-90" : ""
          }`}
        />
        <span className="turn-file-summary-title">
          {t("turnFileSummaryChanged").replace("{count}", String(files.length))}
        </span>
        <span className="tool-diff font-mono tabular-nums">
          <span className="diff-added">+{added}</span>
          <span className="diff-removed">−{removed}</span>
        </span>
        <button
          type="button"
          className={`turn-file-summary-action ${cleanState === "confirm" || cleanState === "error" ? "text-[var(--danger)] border-[var(--danger)]" : ""} ${cleanState === "done" ? "opacity-70" : ""}`}
          disabled={cleanState === "cleaning"}
          title={t("tmpCleanButton")}
          onClick={(event) => {
            event.stopPropagation();
            void handleCleanup();
          }}
        >
          {cleanState === "error" ? cleanMsg : cleanupLabel}
        </button>
      </button>
      {open && (
        <div className="turn-file-summary-rows">
          {visibleFiles.map((file) => (
            <div key={file.path} className="turn-file-summary-row" title={file.path}>
              <span className="turn-file-summary-badge">M</span>
              <span className="turn-file-summary-name">{file.basename}</span>
              {file.dir ? <span className="turn-file-summary-dir">{file.dir}</span> : null}
              <span className="tool-diff font-mono tabular-nums">
                <span className="diff-added">+{file.added}</span>
                <span className="diff-removed">−{file.removed}</span>
              </span>
              <button
                type="button"
                className="turn-file-summary-action"
                onClick={(event) => {
                  event.stopPropagation();
                  openCodeViewer({
                    type: "text",
                    title: file.basename,
                    path: file.path,
                    content: buildUnifiedPatch(file.path, file.originalContent, file.finalContent),
                    language: "diff",
                  });
                }}
              >
                {t("turnFileSummaryReview")}
              </button>
              <button
                type="button"
                className="turn-file-summary-action"
                onClick={(event) => {
                  event.stopPropagation();
                  openCodeViewer({ type: "file", title: file.basename, path: file.path });
                }}
              >
                {t("turnFileSummaryOpen")}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TurnGroupViewImpl({
  group,
  retryAttempts,
  retrying = false,
  liveNowMs,
  live = false,
  streaming = false,
  workspaceRoot,
  onEditSend,
  onEditResend,
  isEditing = false,
  onStartEdit,
  onCancelEdit,
  onRetryFrom,
  onBranchFrom,
  actionsDisabled = false,
  highlightMessageId,
  pendingApproval,
  hiddenSpans,
}: TurnGroupViewProps) {
  const { t, locale } = useTranslation();
  // 用户只折叠/展开「已完成」的轮次；运行中强制展开且不可收起（userToggle 仅完成态生效）。
  const [userToggle, setUserToggle] = useState<boolean | null>(null);

  // 轮运行判定 = 条目级 running || 实时轮兜底（消除多步循环间隙的闪烁）
  const isTurnRunning = group.running || live;
  const workState = isTurnRunning
    ? "running"
    : resolveTurnWorkState(group);
  // 工时折算：隐藏窗口停表（仅当有隐藏记录且能定位轮起点时生效；否则退回墙钟，
  // 保证历史/无打点轮的既有行为完全不变）。
  const durationMs = (() => {
    const spans = hiddenSpans && hiddenSpans.length > 0 ? hiddenSpans : null;
    if (spans && group.startedAt !== undefined) {
      const end = isTurnRunning ? liveNowMs : group.endedAt;
      if (typeof end === "number") {
        return effectiveWorkMs(group.startedAt, end, spans);
      }
    }
    return isTurnRunning && group.startedAt !== undefined
      ? Math.max(0, liveNowMs - group.startedAt)
      : turnDurationMs(group, liveNowMs);
  })();
  const lastAssistant = group.lastAssistant;
  const openCodeViewer = useAppStore((state) => state.openCodeViewer);
  // P2-C2：终态回复的代码评论卡（::code-comment 指令解析；运行中不生成）
  const codeCommentCards = useMemo(
    () =>
      lastAssistant && !isTurnRunning
        ? buildAssistantCodeCommentCards(lastAssistant.text, workspaceRoot || ".", 50)
        : [],
    [lastAssistant, isTurnRunning, workspaceRoot],
  );
  // 运行中最后一条 assistant 的正文就地渲染进折叠体（见文件头「时间线不变式」）。
  // 纯文本轮没有思考/工具/中间叙述，靠这个标记让折叠体仍然渲染（否则流式正文不可见）。
  const liveAnswerInBody = isTurnRunning && lastAssistant !== undefined;

  // 状态条恒显示（对齐 ZCode：纯文本回复也有「已工作 X 秒」）；折叠箭头仅在有
  // 可折叠内容（思考/工具/中间叙述）时出现，纯文本回复的状态条只是工时说明。
  const hasThinking = group.activity.some(
    (entry) => entry.role === "assistant" && entry.thinking.length > 0
  );
  const hasTools = group.activity.some((entry) => entry.role === "tool");
  const hasIntermediateText = group.activity.some(
    (entry) => entry.role === "assistant" && entry !== lastAssistant && entry.text.length > 0
  );
  const showHeader = group.activity.length > 0;
  const hasBody = hasThinking || hasTools || hasIntermediateText;
  // 连续 websearch 合并为聚合段（联网搜索聚合行，其余条目逐条渲染）
  const activitySegments = useMemo(() => buildActivitySegments(group.activity), [group.activity]);

  // 需用户介入（挂起审批/等人类工具）时强制展开并显式告知（对齐 LiveAgent attention）。
  const attentionRequired = isAttentionRequired(group, pendingApproval);
  // 折叠交互仅对有内容的轮次生效；运行中或 attention 态强制展开且不可收起。
  const lockOpen = isTurnRunning || attentionRequired;
  const open = lockOpen ? true : userToggle === true;

  // 重连副行（对齐 LiveAgent：重试等待期间显示、首个内容事件到达才撤下；重试详情
  // 记录只在回合收敛后由 MessageItem 展示）。副行实时携带最新一次失败的错误原因。
  const lastRetry = retryAttempts && retryAttempts.length > 0 ? retryAttempts[retryAttempts.length - 1] : null;
  const reconnectLabel =
    isTurnRunning && retrying && lastRetry
      ? t("reconnecting")
          .replace("{attempt}", String(lastRetry.attempt))
          .replace("{max}", String(lastRetry.maxAttempts)) +
        (lastRetry.errorMessage ? ` · ${lastRetry.errorMessage}` : "")
      : null;

  let headerLabel: string;
  if (attentionRequired) {
    // attention 优先于工时文案：此刻用户在等的事项比「已工作 X 分」更重要
    headerLabel = t("turnAwaitingDecision");
  } else switch (workState) {
    case "running":
      headerLabel = t("turnWorking").replace(
        "{duration}",
        formatWorkDuration(durationMs ?? 0, locale)
      );
      break;
    case "completed":
      headerLabel =
        durationMs !== undefined
          ? t("turnWorked").replace("{duration}", formatWorkDuration(durationMs, locale))
          : t("turnWorkedNoDuration");
      break;
    case "stopped":
      headerLabel = t("turnStopped");
      break;
    default:
      headerLabel = t("turnWorkedNoDuration");
  }

  return (
    <div className="turn-group">
      {/* 压缩标记带：轮首的 compact 条目（applyCompaction 产物）渲染为可展开 seam */}
      {group.activity.some((entry) => isCompactEntry(entry)) ? (
        <CompactionBand
          state="settled"
          coveredCount={(group.activity.find((e) => isCompactEntry(e)) as (typeof group.activity)[number] & { coveredCount?: number })?.coveredCount}
          summary={group.activity.find((e) => isCompactEntry(e))?.text}
        />
      ) : null}
      {group.userMessage ? (
        <MessageItem
          message={group.userMessage}
          actionsDisabled={actionsDisabled}
          isEditing={isEditing}
          onStartEdit={onStartEdit}
          onCancelEdit={onCancelEdit}
          onEditResend={onEditResend}
          onAppendSend={onEditSend}
          highlight={highlightMessageId === group.userMessage.id}
        />
      ) : null}

      {showHeader ? (
        <div className="turn-header-row" data-state={workState} data-attention={attentionRequired ? "true" : undefined}>
          {hasBody ? (
            <button
              type="button"
              className="turn-header-trigger"
              aria-expanded={open}
              disabled={lockOpen}
              onClick={() => setUserToggle((cur) => (cur === null ? true : !cur))}
            >
              <span className="turn-header-label">{headerLabel}</span>
              {!lockOpen && (
                <ChevronRight
                  className={`w-3.5 h-3.5 transition-transform text-[var(--text-dim)] ${
                    open ? "rotate-90" : ""
                  }`}
                />
              )}
            </button>
          ) : (
            <div className="turn-header-trigger turn-header-static">
              <span className="turn-header-label">{headerLabel}</span>
            </div>
          )}
          {reconnectLabel && (
            <div className="reconnect-line break-words">{reconnectLabel}</div>
          )}
          {(hasBody || liveAnswerInBody) && open && (
            <div className="turn-body">
              {activitySegments.map((segment) => {
                if (segment.kind === "webSearchGroup") {
                  return <WebSearchGroupCard key={`wsg-${segment.entries[0].id}`} entries={segment.entries} />;
                }
                const entry = segment.entry;
                if (isCompactEntry(entry)) return null; // 压缩带已在轮首渲染
                if (entry.role === "assistant") {
                  return (
                    <div key={entry.id} className="turn-assistant-activity">
                      <ThinkingBlock entry={entry} liveNowMs={liveNowMs} turnRunning={isTurnRunning} />
                      {entry !== lastAssistant ? (
                        <IntermediateText entry={entry} streaming={streaming} />
                      ) : isTurnRunning ? (
                        // 运行中的最终回复正文：就地渲染（样式对齐 MessageItem 助手正文），
                        // 结束后由下方外显的 MessageItem 接管——时间线位置不变。
                        <div className="w-full text-sm text-[var(--text)] leading-relaxed">
                          <div className="md">
                            <MarkdownText text={entry.text} streaming={entry.status === "streaming"} />
                            {entry.status === "streaming" ? (
                              <ChatLoading loading size="sm" className="mt-1" />
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                }
                if (isToolEntry(entry)) {
                  return <ToolCallCard key={entry.id} entry={entry} workspaceRoot={workspaceRoot} />;
                }
                return null;
              })}
            </div>
          )}
        </div>
      ) : null}

      {/* 最终回复：轮结束后外显（运行中正文已在折叠体时间线位置就地渲染，见文件头）。 */}
      {lastAssistant && !isTurnRunning ? (
        <>
          <MessageItem
            message={lastAssistant}
            actionsDisabled={actionsDisabled}
            renderText={
              buildAssistantCodeCommentCards(lastAssistant.text, workspaceRoot || ".", 50).length >= 0
                ? projectAssistantCodeComments(lastAssistant.text, { streaming: false }).visibleText
                : lastAssistant.text
            }
            onAppendSend={onEditSend}
            onRetryFrom={onRetryFrom}
            onBranchFrom={onBranchFrom}
            highlight={highlightMessageId === lastAssistant.id}
          />
          {codeCommentCards.length > 0 && !actionsDisabled ? (
            <AssistantCodeCommentCards
              cards={codeCommentCards}
              onOpenComment={(card) =>
                openCodeViewer({
                  // code-review 预览模式（P2 尾巴 #4）：定位评论行域 + 内联评论覆盖，
                  // 而非普通文件预览（ZCode AssistantCodeCommentCards 同语义）。
                  type: "code-review",
                  title: card.displayPath,
                  path: card.path,
                  review: {
                    requestId: card.id,
                    title: card.title,
                    body: card.body,
                    ...(card.priority !== undefined ? { priority: card.priority } : {}),
                    ...(card.startLine !== undefined ? { startLine: card.startLine } : {}),
                    ...(card.endLine !== undefined ? { endLine: card.endLine } : {}),
                  },
                })
              }
            />
          ) : null}
        </>
      ) : null}

      {/* 文件更改摘要卡：仅在整轮结束后显示（对齐 ZCode —— 编辑过程中看各工具卡，跑完出汇总） */}
      {!isTurnRunning && <TurnFileSummaryCard entries={group.activity} workspaceRoot={workspaceRoot} />}
    </div>
  );
}

/** 仅当 props 变化时才重渲染（group 引用在流式期间保持稳定，见 MessageList 引用稳定化）。 */
export const TurnGroupView = memo(TurnGroupViewImpl);
