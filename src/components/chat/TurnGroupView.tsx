/**
 * TurnGroupView —— 单轮对话的分组渲染（对齐 ZCode ConversationTurnGroup / AssistantHistoryStatus）。
 *
 * 结构（自上而下）：
 *   1. 用户消息行（复用 MessageItem 用户分支）；
 *   2. 回合工作状态条：「工作中 {时长}」（运行中，每秒跳动、锁定展开不可收起）/
 *      「已工作 {时长}」（完成，默认折叠可展开）/「已停止」/「已处理」（历史无打点，No-Fallback）；
 *   3. 折叠体：思考块（ThinkingBlock）+ 工具调用卡（ToolCallCard）+ 中间叙述文本；
 *   4. 最终回复正文（轮内最后一条 assistant，复用 MessageItem 助手分支，始终外显）。
 *
 * 折叠交互对齐 ZCode：运行中是「只读展开」（不渲染箭头、不可收起）；完成态翻转为默认折叠、
 * 可点击展开。轮 key 变化时组件随 React key 重挂载，折叠态自然复位。
 */

import { ChevronRight, FileText, Search } from "lucide-react";
import type { TimelineEntry, ToolTimelineEntry } from "../../lib/chat/conversationModel";
import { MessageItem } from "./MessageItem";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";
import { MarkdownText } from "./MarkdownText";
import { useTranslation } from "../../i18n";
import { useMemo, useRef, useState } from "react";
import {
  buildUnifiedPatch,
  collectTurnFileChanges,
  computeLineChangeStat,
  formatWorkDuration,
  isExploreTool,
  pathDirectory,
  resolveTurnWorkState,
  toolArgPath,
  turnDurationMs,
  type TurnGroup,
} from "../../lib/chat/turnActivity";
import { useAppStore } from "../../store/useAppStore";

function isToolEntry(message: TimelineEntry): message is ToolTimelineEntry {
  return message.role === "tool";
}

/** 折叠体渲染项：普通时间线条目单卡，或连续查阅族工具聚合成的「查阅」卡（对齐 ZCode ExploreToolCallBlock）。 */
type ActivityItem =
  | { kind: "tool"; entry: TimelineEntry }
  | { kind: "explore"; entries: ToolTimelineEntry[] };

function buildActivityItems(activity: TimelineEntry[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  let exploreBuffer: ToolTimelineEntry[] = [];
  const flush = () => {
    if (exploreBuffer.length > 0) {
      items.push({ kind: "explore", entries: exploreBuffer });
      exploreBuffer = [];
    }
  };
  for (const entry of activity) {
    if (isToolEntry(entry) && isExploreTool(entry.toolName)) {
      exploreBuffer.push(entry);
      continue;
    }
    flush();
    items.push({ kind: "tool", entry });
  }
  flush();
  return items;
}

/**
 * 「查阅」聚合卡：轮内连续的目录列表 / 文件读取调用合并为一张卡，
 * header 显示分类计数（N 列表 · N 文件）；**列表调用不渲染文件数组输出**，
 * 展开体只保留单行摘要（对齐 ZCode ExploreToolCallBlock 的信息取舍）。
 */
function ExploreGroupCard({ entries }: { entries: ToolTimelineEntry[] }) {
  const { t } = useTranslation();
  const openCodeViewer = useAppStore((state) => state.openCodeViewer);
  const [open, setOpen] = useState(false);

  const isRunning = entries.some((entry) => entry.status === "running");
  const isError = entries.some((entry) => Boolean(entry.isError));
  const listCount = entries.filter((entry) => entry.toolName === "list_dir").length;
  const fileCount = entries.filter((entry) => entry.toolName === "read_file").length;
  const buckets: string[] = [];
  if (listCount > 0) buckets.push(t("exploreBucketList").replace("{count}", String(listCount)));
  if (fileCount > 0) buckets.push(t("exploreBucketFile").replace("{count}", String(fileCount)));
  const summary = buckets.join(" · ");
  const statusWord =
    isRunning ? t("toolStatusRunning") : isError ? t("toolStatusFailed") : t("toolStatusDone");

  // 运行中：收起摘要实时显示最新一条子调用（对齐 ZCode collapsedChildSummary）
  const latest = entries[entries.length - 1];
  const latestPath = latest ? toolArgPath(latest.args) : undefined;
  const latestIsList = latest?.toolName === "list_dir";
  const collapsedSummary = isRunning && latest
    ? latestIsList
      ? `${t("exploreBucketListLabel")} · ${latestPath || t("exploreCurrentDirectory")}`
      : `${t("exploreBucketFileLabel")} · ${latestPath ? pathDirectory(latestPath) ?? latestPath : ""}`
    : null;

  return (
    <div
      className="tool-card"
      data-status={isRunning ? "running" : isError ? "error" : "done"}
      role="group"
      aria-label={t("exploreCardLabel")}
      aria-busy={isRunning || undefined}
    >
      <button
        type="button"
        className="tool-head tool-head-toggle"
        aria-expanded={open}
        onClick={() => setOpen((cur) => !cur)}
      >
        <Search className="tool-kind-icon" aria-hidden="true" />
        <span className={`tool-kind ${isRunning ? "animated-gradient-text" : ""}`}>
          {t("exploreCardLabel")}
        </span>
        <span className="explore-summary min-w-0 truncate">
          {collapsedSummary ?? summary}
        </span>
        <span className="tool-status" data-error={isError || undefined}>
          {statusWord}
        </span>
        <ChevronRight
          className={`w-3.5 h-3.5 ml-0.5 transition-transform text-[var(--text-dim)] ${
            open ? "rotate-90" : ""
          }`}
        />
      </button>
      {open && (
        <div className="explore-children ml-2 border-l border-[var(--border)] pl-3.5">
          {entries.map((entry) => {
            const p = toolArgPath(entry.args);
            const isList = entry.toolName === "list_dir";
            const fileName = p ? p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p : undefined;
            const dir = p ? pathDirectory(p) : undefined;
            return (
              <div key={entry.id} className="explore-child" title={p}>
                {isList ? (
                  <>
                    <span className="explore-child-kind">{t("exploreBucketListLabel")}</span>
                    <span className="explore-child-text">
                      {p && p !== "." ? p : t("exploreCurrentDirectory")}
                    </span>
                  </>
                ) : (
                  <>
                    <FileText className="w-3 h-3 shrink-0" aria-hidden="true" />
                    <button
                      type="button"
                      className="explore-child-text cursor-pointer hover:text-[var(--text)]"
                      onClick={() =>
                        p && openCodeViewer({ type: "file", title: fileName ?? p, path: p })
                      }
                    >
                      {fileName}
                    </button>
                    {dir ? <span className="explore-child-dir">{dir}</span> : null}
                  </>
                )}
                {entry.status === "error" ? (
                  <span className="tool-status" data-error="true">
                    {t("toolStatusFailed")}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export interface TurnGroupViewProps {
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
  onEditSend?: (newText: string) => void;
  onRetry?: () => void;
}

/** 折叠体内「中间叙述」的暗色正文（非最终回复的 assistant 文本）。 */
function IntermediateText({ entry }: { entry: TimelineEntry }) {
  if (entry.role !== "assistant" || !entry.text) return null;
  return (
    <div className="turn-intermediate-text text-[16px] font-[450] text-[var(--text)] leading-relaxed">
      <MarkdownText text={entry.text} />
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
  const changes = useMemo(() => {
    const byPath = new Map<string, { path: string; originalContent: string; finalContent: string }>();
    for (const change of collectTurnFileChanges(entries)) {
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
        <span
          className="turn-file-summary-action opacity-50"
          title="撤销将在后续版本支持"
          onClick={(event) => event.stopPropagation()}
        >
          ↩ {t("turnFileSummaryUndo")}
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

export function TurnGroupView({ group, liveNowMs, live = false, workspaceRoot, onEditSend, onRetry }: TurnGroupViewProps) {
  const { t, locale } = useTranslation();
  // 用户只折叠/展开「已完成」的轮次；运行中强制展开且不可收起（userToggle 仅完成态生效）。
  const [userToggle, setUserToggle] = useState<boolean | null>(null);

  // 轮运行判定 = 条目级 running || 实时轮兜底（消除多步循环间隙的闪烁）
  const isTurnRunning = group.running || live;
  const workState = isTurnRunning
    ? "running"
    : resolveTurnWorkState(group);
  const durationMs =
    isTurnRunning && group.startedAt !== undefined
      ? Math.max(0, liveNowMs - group.startedAt)
      : turnDurationMs(group, liveNowMs);
  const lastAssistant = group.lastAssistant;

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

  // 折叠交互仅对有内容的轮次生效；运行中强制展开且不可收起（对齐 ZCode 只读展开）。
  const open = isTurnRunning ? true : userToggle === true;
  const activityItems = useMemo(() => buildActivityItems(group.activity), [group.activity]);

  let headerLabel: string;
  switch (workState) {
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
      {group.userMessage ? (
        <MessageItem message={group.userMessage} onEditSend={onEditSend} />
      ) : null}

      {showHeader ? (
        <div className="turn-header-row" data-state={workState}>
          {hasBody ? (
            <button
              type="button"
              className="turn-header-trigger"
              aria-expanded={open}
              disabled={isTurnRunning}
              onClick={() => setUserToggle((cur) => (cur === null ? true : !cur))}
            >
              <span className="turn-header-label">{headerLabel}</span>
              {!isTurnRunning && (
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
          {hasBody && open && (
            <div className="turn-body">
              {activityItems.map((item, index) => {
                if (item.kind === "explore") {
                  return <ExploreGroupCard key={`explore:${index}`} entries={item.entries} />;
                }
                if (item.entry.role === "assistant") {
                  const entry = item.entry;
                  return (
                    <div key={entry.id} className="turn-assistant-activity">
                      <ThinkingBlock entry={entry} liveNowMs={liveNowMs} turnRunning={isTurnRunning} />
                      {entry !== lastAssistant ? <IntermediateText entry={entry} /> : null}
                    </div>
                  );
                }
                if (isToolEntry(item.entry)) {
                  return <ToolCallCard key={item.entry.id} entry={item.entry} />;
                }
                return null;
              })}
            </div>
          )}
        </div>
      ) : null}

      {lastAssistant ? (
        <MessageItem message={lastAssistant} onEditSend={onEditSend} onRetry={onRetry} />
      ) : null}

      {/* 文件更改摘要卡：仅在整轮结束后显示（对齐 ZCode —— 编辑过程中看各工具卡，跑完出汇总） */}
      {!isTurnRunning && <TurnFileSummaryCard entries={group.activity} workspaceRoot={workspaceRoot} />}
    </div>
  );
}
