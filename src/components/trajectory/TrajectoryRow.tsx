// LiveAgent 移植：crates/agent-ui/src/components/trajectory/TrajectoryRow.tsx
// 适配：useLocale → useTranslation；KIND_BADGE 调色板类 → 语义 token（明暗两套，见 global.css）；
// IconSet/lucide 无依赖；h-30px → h-[30px]。
/**
 * 账本单行。
 *
 * 一行一条记录：角色徽标 + 摘要 + 工具结果 + 自身耗时。溢出交给 CSS 省略，
 * 完整内容在详情面板里看。
 */

import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import {
  formatTrajectorySeconds,
  trajectoryFallbackLabelKey,
  trajectoryKindLabelKey,
} from "../../lib/trajectory/presentation";
import type { TrajectoryRecord, TrajectoryRecordKind } from "../../lib/trajectory/types";

const KIND_BADGE: Record<TrajectoryRecordKind, string> = {
  system:
    "bg-[var(--trajectory-badge-system-bg)] text-[var(--trajectory-badge-system-fg)]",
  user: "bg-[var(--trajectory-badge-user-bg)] text-[var(--trajectory-badge-user-fg)]",
  context:
    "bg-[var(--trajectory-badge-context-bg)] text-[var(--trajectory-badge-context-fg)]",
  compacted:
    "bg-[var(--trajectory-badge-compacted-bg)] text-[var(--trajectory-badge-compacted-fg)]",
  message:
    "bg-[var(--trajectory-badge-message-bg)] text-[var(--trajectory-badge-message-fg)]",
  tool: "bg-[var(--trajectory-badge-tool-bg)] text-[var(--trajectory-badge-tool-fg)]",
  subtool:
    "bg-[var(--trajectory-badge-subtool-bg)] text-[var(--trajectory-badge-subtool-fg)]",
};

export function TrajectoryRow(props: {
  record: TrajectoryRecord;
  selected: boolean;
  focused: boolean;
  dimmed: boolean;
  onSelect: (index: number) => void;
}) {
  const { t, locale } = useTranslation();
  // 动态 i18n 键（kind 查表）需要 string 签名
  const tf = t as unknown as (key: string) => string;
  const { record } = props;
  const fallbackKey = trajectoryFallbackLabelKey(record);
  const label = fallbackKey === undefined ? record.text : tf(fallbackKey);

  return (
    <button
      type="button"
      data-trajectory-index={record.index}
      aria-current={props.selected ? "true" : undefined}
      onClick={() => props.onSelect(record.index)}
      className={cn(
        "flex h-[30px] w-full min-w-0 items-center gap-2 px-3",
        "text-left text-xs transition-colors @max-[520px]:gap-1.5 @max-[520px]:px-2",
        "border-l-2 border-transparent hover:bg-muted/50",
        props.selected && "border-primary bg-muted/70",
        props.focused && !props.selected && "bg-muted/40",
        props.dimmed && "opacity-35",
        record.kind === "subtool" && "pl-8 @max-[520px]:pl-5",
      )}
    >
      <span
        className={cn(
          "shrink-0 rounded px-1.5 py-px font-medium text-tiny tracking-wide",
          record.isError
            ? "bg-[var(--trajectory-badge-error-bg)] text-[var(--trajectory-badge-error-fg)]"
            : KIND_BADGE[record.kind],
        )}
      >
        {tf(trajectoryKindLabelKey(record.kind))}
      </span>

      <span className="min-w-0 flex-1 truncate text-foreground/90">
        {record.toolName !== undefined && record.kind !== "message" && (
          <span className="font-medium">{record.toolName}</span>
        )}
        {record.toolName !== undefined && label !== record.toolName && label !== "" && (
          <span className="ml-1.5 text-muted-foreground">{label}</span>
        )}
        {record.toolName === undefined && label}
      </span>

      {record.result !== undefined && record.result !== "" && (
        <span className="hidden min-w-0 max-w-[38%] shrink-0 truncate text-muted-foreground md:inline">
          <span aria-hidden="true" className="mr-1">
            →
          </span>
          {record.result}
        </span>
      )}

      {record.status === "running" && (
        <span className="shrink-0 text-tiny text-muted-foreground">
          {t("trajectory.status.running")}
        </span>
      )}

      <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground @max-[520px]:w-12 @max-[520px]:text-xs">
        {record.timeSeconds === null ? "" : formatTrajectorySeconds(record.timeSeconds, locale)}
      </span>
    </button>
  );
}
