// LiveAgent 移植：crates/agent-ui/src/components/trajectory/TrajectoryView.tsx
// 适配（用户定稿「时间线适配版」）：数据源换成本仓时间线适配器（buildTrajectoryFromTimeline）——
// 无事件窗口/实时尾巴/分段池/子代理预取；「加载更早」接本仓会话分页；其余视图逻辑（折叠/
// 搜索/投影/选中/详情宽度）与 LA 一致。
/**
 * 轨迹视图外壳：时间线适配器 → 账本 → 布局 → 工具栏/时间轴/事件列表/详情面板。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TimelineEntry } from "../../lib/chat/conversationModel";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { DEFAULT_TRAJECTORY_DETAILS_WIDTH } from "../../lib/trajectory/detailsResize";
import {
  collapsibleTrajectoryAssistants,
  collapsibleTrajectoryTurns,
} from "../../lib/trajectory/displayItems";
import { buildTrajectoryFromTimeline } from "../../lib/trajectory/fromReinAgentTimeline";
import { deriveTrajectoryLayout } from "../../lib/trajectory/layout";
import { trajectoryLedgerHasPartialTiming } from "../../lib/trajectory/presentation";
import {
  TrajectorySearchIndex,
  trajectorySearchMatchIndexes,
} from "../../lib/trajectory/searchIndex";
import {
  type TrajectoryTimelineMode,
  type TrajectoryTimeRange,
  trajectoryTimelineFocusIndexes,
} from "../../lib/trajectory/timeline";
import type { TrajectoryRecord } from "../../lib/trajectory/types";
import { DetailsPanel } from "./details/DetailsPanel";
import { TrajectoryTable } from "./TrajectoryTable";
import { TrajectoryTimeline } from "./TrajectoryTimeline";
import { TrajectoryToolbar } from "./TrajectoryToolbar";

const EMPTY_TURNS: ReadonlySet<number> = new Set();
const EMPTY_IDS: ReadonlySet<string> = new Set();

export function TrajectoryView(props: {
  /** 会话标识（活动任务 id；切换时重置视图状态）。 */
  conversationId: string;
  /** 当前时间线（内存态即权威；落库条目水合后同样适用）。 */
  messages: readonly TimelineEntry[];
  /** 打开文件预览（详情面板「原始块」的文件按钮）。 */
  onOpenFileLink?: (path: string) => void;
  /** 更早历史是否可分页加载（接本仓会话分页）。 */
  hasMoreMessages?: boolean;
  loadingEarlier?: boolean;
  onLoadEarlier?: () => void | Promise<void>;
  /** 打开「下一次请求预览」弹窗（App 层构建与挂载） */
  onRequestPreview?: () => void;
}) {
  const { t } = useTranslation();
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(EMPTY_TURNS);
  const [collapsedAssistants, setCollapsedAssistants] = useState<ReadonlySet<string>>(EMPTY_IDS);
  const [searchQuery, setSearchQuery] = useState("");
  const [actualDuration, setActualDuration] = useState(false);
  const [range, setRange] = useState<TrajectoryTimeRange | null>(null);
  // Numeric row indexes shift when older pages are prepended; selection must follow the
  // business-stable recordId instead.
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [detailsWidth, setDetailsWidth] = useState(DEFAULT_TRAJECTORY_DETAILS_WIDTH);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // 切换会话：重置全部视图状态（对齐 LA 的 loadGeneration 重置语义）。
  useEffect(() => {
    setCollapsedTurns(EMPTY_TURNS);
    setCollapsedAssistants(EMPTY_IDS);
    setSearchQuery("");
    setActualDuration(false);
    setRange(null);
    setSelectedRecordId(null);
  }, [props.conversationId]);

  const { ledger, content } = useMemo(
    () => buildTrajectoryFromTimeline(props.messages),
    [props.messages],
  );
  const turns = useMemo(() => deriveTrajectoryLayout({ ledger, content }), [ledger, content]);

  const searchIndex = useMemo(() => new TrajectorySearchIndex(), []);
  const layouts = useMemo(() => [turns] as const, [turns]);
  const searchMatchIndexes = useMemo(() => {
    if (searchQuery.trim() === "") return null;
    searchIndex.update(layouts);
    return trajectorySearchMatchIndexes(layouts, searchIndex.search(searchQuery));
  }, [searchIndex, layouts, searchQuery]);

  const hasTiming = ledger.hasTiming;
  const hasPartialTiming = trajectoryLedgerHasPartialTiming(ledger);
  const notice = !hasTiming
    ? t("trajectory.degraded")
    : hasPartialTiming
      ? t("trajectory.partialTiming")
      : null;
  const mode: TrajectoryTimelineMode = hasTiming && actualDuration ? "duration" : "sequence";
  const timelineFocusIndexes = useMemo(
    () => (range === null ? null : trajectoryTimelineFocusIndexes(turns, range, mode)),
    [range, turns, mode],
  );

  const { recordsByIndex, recordsById } = useMemo(() => {
    const byIndex = new Map<number, TrajectoryRecord>();
    const byId = new Map<string, TrajectoryRecord>();
    for (const turn of turns) {
      for (const group of turn.groups) {
        for (const record of group.records) {
          byIndex.set(record.index, record);
          byId.set(record.recordId, record);
        }
      }
    }
    return { recordsByIndex: byIndex, recordsById: byId };
  }, [turns]);
  const selectedRecord =
    selectedRecordId === null ? null : (recordsById.get(selectedRecordId) ?? null);
  const selectedIndex = selectedRecord?.index ?? null;
  const selectRecordAtIndex = useCallback(
    (index: number) => setSelectedRecordId(recordsByIndex.get(index)?.recordId ?? null),
    [recordsByIndex],
  );

  const collapsibleTurns = useMemo(() => collapsibleTrajectoryTurns(turns), [turns]);
  const collapsibleAssistants = useMemo(() => collapsibleTrajectoryAssistants(turns), [turns]);
  const allTurnsCollapsed =
    collapsibleTurns.length > 0 && collapsibleTurns.every((turn) => collapsedTurns.has(turn));
  const allCallsCollapsed =
    collapsibleAssistants.length > 0 &&
    collapsibleAssistants.every((id) => collapsedAssistants.has(id));

  const loadEarlier = useCallback(() => {
    if (props.loadingEarlier || props.hasMoreMessages !== true || props.onLoadEarlier === undefined) return;
    setRange(null);
    void props.onLoadEarlier();
  }, [props.loadingEarlier, props.hasMoreMessages, props.onLoadEarlier]);

  return (
    <div className="@container flex h-full min-h-0 flex-1 flex-col">
      <TrajectoryToolbar
        actualDuration={actualDuration}
        hasTiming={hasTiming}
        onActualDurationChange={(next) => {
          setActualDuration(next);
          setRange(null);
        }}
        allTurnsCollapsed={allTurnsCollapsed}
        onToggleAllTurns={() =>
          setCollapsedTurns(allTurnsCollapsed ? EMPTY_TURNS : new Set(collapsibleTurns))
        }
        allCallsCollapsed={allCallsCollapsed}
        onToggleAllCalls={() =>
          setCollapsedAssistants(allCallsCollapsed ? EMPTY_IDS : new Set(collapsibleAssistants))
        }
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        {...(props.onRequestPreview === undefined ? {} : { onRequestPreview: props.onRequestPreview })}
      />

      {props.hasMoreMessages === true && (
        <div className="shrink-0 border-b border-border/60 px-3 py-1.5 text-center">
          <button
            type="button"
            className={cn(
              "rounded px-2 py-1 text-xs text-muted-foreground",
              "hover:bg-muted hover:text-foreground disabled:cursor-wait disabled:opacity-60",
            )}
            disabled={props.loadingEarlier === true}
            onClick={loadEarlier}
          >
            {props.loadingEarlier ? t("trajectory.loadingEarlier") : t("trajectory.loadEarlier")}
          </button>
        </div>
      )}

      {notice !== null && (
        <p className="shrink-0 border-b border-border/60 bg-muted/30 px-3 py-1 text-xs text-muted-foreground">
          {notice}
        </p>
      )}

      <TrajectoryTimeline
        turns={turns}
        mode={mode}
        range={range}
        selectedIndex={selectedIndex}
        searchMatchIndexes={searchMatchIndexes}
        onRangeChange={setRange}
        onRecordSelect={selectRecordAtIndex}
      />

      {/* 窄容器（小窗口/移动端）下左右分栏互相挤压，改为上下排布。 */}
      <div
        ref={contentRef}
        className="relative flex min-h-0 flex-1 overflow-hidden @max-[640px]:flex-col"
      >
        <TrajectoryTable
          turns={turns}
          collapsedTurns={collapsedTurns}
          collapsedAssistants={collapsedAssistants}
          searchMatchIndexes={searchMatchIndexes}
          timelineFocusIndexes={timelineFocusIndexes}
          selectedIndex={selectedIndex}
          onSelect={selectRecordAtIndex}
          onToggleTurn={(turn) =>
            setCollapsedTurns((current) => {
              const next = new Set(current);
              if (next.has(turn)) next.delete(turn);
              else next.add(turn);
              return next;
            })
          }
        />
        <DetailsPanel
          record={selectedRecord}
          onOpenFileLink={props.onOpenFileLink}
          onClose={() => setSelectedRecordId(null)}
          containerRef={contentRef}
          width={detailsWidth}
          onWidthChange={setDetailsWidth}
        />
      </div>
    </div>
  );
}
