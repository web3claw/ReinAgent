/**
 * SubagentsPanel —— 子代理目录面板（P1-6 增量，对齐 ZCode TUI SubagentsSection +
 * SubagentSessionSidePane 的信息形态）。
 *
 * - 列表：Running 分组在前，Ended（completed/failed/stopped）在后；
 *   每行 = 状态点 + description + 类型/状态次行；running 行带 Stop 按钮。
 * - 详情：点击行进入（prompt / 事实 / 报告全文），返回按钮回列表。
 * - 数据源：subagentRegistry（useSyncExternalStore，内存态——应用重启即清空，
 *   历史回放待子会话持久化批次）。
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { ArrowLeft, Square } from "lucide-react";
import {
  getSubagentRunSnapshot,
  stopRun,
  subscribeSubagentRuns,
  type SubagentRunRecord,
} from "../../lib/subagents/subagentRegistry";

const STATUS_LABEL: Record<SubagentRunRecord["status"], string> = {
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
};

function StatusDot({ status }: { status: SubagentRunRecord["status"] }) {
  const cls =
    status === "running"
      ? "bg-[var(--status-run)] animate-pulse"
      : status === "completed"
        ? "bg-[var(--status-ok)]"
        : "bg-[var(--danger)]";
  return <span className={`size-2 flex-shrink-0 rounded-full ${cls}`} />;
}

function formatDuration(startedAt: number, endedAt?: number): string {
  const ms = (endedAt ?? Date.now()) - startedAt;
  return `${Math.max(1, Math.round(ms / 100) / 10)}s`;
}

export function SubagentsPanel({ focusId }: { focusId?: string }) {
  const records = useSyncExternalStore(subscribeSubagentRuns, getSubagentRunSnapshot, getSubagentRunSnapshot);
  const [selectedId, setSelectedId] = useState<string | null>(focusId ?? null);

  // focusId 变化（重新从卡片点开）跟随
  useEffect(() => {
    if (focusId) setSelectedId(focusId);
  }, [focusId]);

  const selected = records.find((r) => r.id === selectedId) ?? null;
  if (selected) {
    return <SubagentDetail record={selected} onBack={() => setSelectedId(null)} />;
  }

  const running = records.filter((r) => r.status === "running");
  const ended = records.filter((r) => r.status !== "running");

  if (records.length === 0) {
    return (
      <p className="p-4 text-sm text-[var(--text-dim)]">
        本会话还没有子代理运行记录（内存态：应用重启即清空）。
      </p>
    );
  }

  return (
    <div className="space-y-3 p-3">
      {running.length > 0 ? (
        <section>
          <h3 className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-dim)]">
            Running ({running.length})
          </h3>
          <div className="space-y-1">
            {running.map((r) => (
              <RunRow key={r.id} record={r} onOpen={() => setSelectedId(r.id)} />
            ))}
          </div>
        </section>
      ) : null}
      {ended.length > 0 ? (
        <section>
          <h3 className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-dim)]">
            Ended ({ended.length})
          </h3>
          <div className="space-y-1">
            {ended.map((r) => (
              <RunRow key={r.id} record={r} onOpen={() => setSelectedId(r.id)} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function RunRow({ record, onOpen }: { record: SubagentRunRecord; onOpen: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
      className="group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--surface-hover)]"
    >
      <StatusDot status={record.status} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-[var(--text)]">{record.description}</div>
        <div className="truncate text-xs text-[var(--text-dim)]">
          {record.type} · {STATUS_LABEL[record.status]} · {formatDuration(record.startedAt, record.endedAt)}
          {record.background ? " · 后台" : ""}
        </div>
      </div>
      {record.status === "running" && record.background ? <StopButton id={record.id} /> : null}
    </div>
  );
}

function StopButton({ id }: { id: string }) {
  const [stopped, setStopped] = useState(false);
  return (
    <button
      type="button"
      aria-label="停止子代理"
      title="停止"
      disabled={stopped}
      onClick={(e) => {
        e.stopPropagation();
        if (stopRun(id)) setStopped(true);
      }}
      className="flex-shrink-0 rounded p-1 text-[var(--text-dim)] opacity-0 transition-opacity hover:bg-[var(--surface-hover)] hover:text-[var(--danger)] focus:opacity-100 group-hover:opacity-100"
    >
      <Square className="h-3.5 w-3.5" />
    </button>
  );
}

function SubagentDetail({ record, onBack }: { record: SubagentRunRecord; onBack: () => void }) {
  const used = record.usage
    ? record.usage.input + record.usage.output + record.usage.cacheRead + record.usage.cacheWrite
    : null;
  return (
    <div className="space-y-3 p-3">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-[var(--text-dim)] hover:text-[var(--text)]"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        返回列表
      </button>
      <div>
        <div className="flex items-center gap-2">
          <StatusDot status={record.status} />
          <h3 className="min-w-0 truncate text-sm font-medium text-[var(--text)]">{record.description}</h3>
        </div>
        <p className="mt-1 text-xs text-[var(--text-dim)]">
          {record.id} · {record.type} · {STATUS_LABEL[record.status]} ·{" "}
          {formatDuration(record.startedAt, record.endedAt)}
          {used !== null ? ` · ${used} tokens` : ""}
          {record.toolUseCount != null ? ` · ${record.toolUseCount} 工具调用` : ""}
          {record.background ? " · 后台" : ""}
        </p>
      </div>
      <section>
        <h4 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-dim)]">任务</h4>
        <pre className="whitespace-pre-wrap break-words rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] p-2 text-xs text-[var(--text)]">
          {record.prompt}
        </pre>
      </section>
      {record.error ? (
        <p className="rounded-lg border border-[var(--danger)] bg-[var(--bg-elev)] p-2 text-xs text-[var(--danger)]">
          {record.error}
        </p>
      ) : null}
      <section>
        <h4 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-dim)]">报告</h4>
        {record.summary ? (
          <pre className="whitespace-pre-wrap break-words rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] p-2 text-xs text-[var(--text)]">
            {record.summary}
          </pre>
        ) : (
          <p className="text-xs text-[var(--text-dim)]">
            {record.status === "running" ? "运行中，尚未产出报告。" : "没有报告。"}
          </p>
        )}
      </section>
    </div>
  );
}
