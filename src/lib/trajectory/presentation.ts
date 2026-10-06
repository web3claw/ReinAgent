// LiveAgent 移植：crates/agent-ui/src/lib/trajectory/presentation.ts
// 适配：LA 的 ../shared/intlFormatters → 本地缓存 Intl 实现（无共享层依赖，行为等价）。
/**
 * 记录 → 展示文案的纯映射。
 *
 * 布局层刻意不产生任何面向用户的文案：它是纯逻辑，不该知道 i18n。这里只负责把
 * 记录翻译成 i18n key 与格式化数值，真正的取词留给组件。
 */

import type {
  TrajectoryHeaderChange,
  TrajectoryLedger,
  TrajectoryRecord,
  TrajectoryRecordKind,
  TrajectoryStatus,
  TrajectoryUsage,
} from "./types";

// ---- 本地缓存 Intl（对齐 LA cachedNumberFormat/cachedDateTimeFormat 语义） ----

const numberFormatCache = new Map<string, Intl.NumberFormat>();
const dateTimeFormatCache = new Map<string, Intl.DateTimeFormat>();

function cachedNumberFormat(
  locale: string,
  key: string,
  options?: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  const cacheKey = `${locale}\u0000${key}`;
  let format = numberFormatCache.get(cacheKey);
  if (format === undefined) {
    format = new Intl.NumberFormat(locale, options);
    numberFormatCache.set(cacheKey, format);
  }
  return format;
}

function cachedDateTimeFormat(
  locale: string,
  key: string,
  options?: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const cacheKey = `${locale}\u0000${key}`;
  let format = dateTimeFormatCache.get(cacheKey);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(locale, options);
    dateTimeFormatCache.set(cacheKey, format);
  }
  return format;
}

/**
 * True when some settled operations only have structural fallback data while other operations
 * carry real timestamps. Duration mode remains useful, but it necessarily omits the untimed rows.
 */
export function trajectoryLedgerHasPartialTiming(ledger: TrajectoryLedger): boolean {
  if (!ledger.hasTiming) return false;
  const settledMissingTiming = (
    status: TrajectoryStatus,
    startedAt: number | null,
    endedAt: number | null,
  ) => status !== "running" && (startedAt === null || endedAt === null);

  for (const turn of ledger.turns) {
    if (turn.status !== "running" && turn.inputs.some((input) => input.at === null)) return true;
    if (
      turn.steps.some((step) => settledMissingTiming(step.status, step.startedAt, step.endedAt))
    ) {
      return true;
    }
    if (
      turn.compactions.some((compaction) =>
        settledMissingTiming(compaction.status, compaction.startedAt, compaction.endedAt),
      )
    ) {
      return true;
    }
  }
  return ledger.standaloneCompactions.some((compaction) =>
    settledMissingTiming(compaction.status, compaction.startedAt, compaction.endedAt),
  );
}

export function trajectoryKindLabelKey(kind: TrajectoryRecordKind): string {
  return `trajectory.kind.${kind}`;
}

export function trajectoryStatusLabelKey(status: TrajectoryStatus): string {
  return `trajectory.status.${status}`;
}

/** SYSTEM 行没有正文，标题完全由变化类别决定。 */
export function trajectorySystemLabelKey(change: TrajectoryHeaderChange | undefined): string {
  switch (change) {
    case "tools":
      return "trajectory.system.tools";
    case "system-and-tools":
      return "trajectory.system.systemAndTools";
    case "system":
      return "trajectory.system.system";
    default:
      return "trajectory.system.initial";
  }
}

/** 一行在没有正文时的兜底标题 key；有正文时返回 undefined，由调用方直接用 text。 */
export function trajectoryFallbackLabelKey(record: TrajectoryRecord): string | undefined {
  if (record.text !== "") return undefined;
  if (record.kind === "system") return trajectorySystemLabelKey(record.headerChange);
  if (record.kind === "compacted") return "trajectory.compaction.title";
  return undefined;
}

/** 毫秒时长标签；未知为 `—`，秒级以上换算成 s 以免出现七位数字。 */
export function formatTrajectoryDuration(milliseconds: number | null, locale: string): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return "—";
  const rounded = Math.max(0, milliseconds);
  if (rounded < 1000) {
    return `${cachedNumberFormat(locale, "integer-0", { maximumFractionDigits: 0 }).format(rounded)} ms`;
  }
  return `${cachedNumberFormat(locale, "decimal-2", { maximumFractionDigits: 2 }).format(rounded / 1000)} s`;
}

export function formatTrajectorySeconds(seconds: number | null, locale: string): string {
  return formatTrajectoryDuration(seconds === null ? null : seconds * 1000, locale);
}

export function formatTrajectoryCount(value: number | undefined, locale: string): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return cachedNumberFormat(locale, "integer-0", { maximumFractionDigits: 0 }).format(value);
}

export function formatTrajectoryClock(timestamp: number | null, locale: string): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return "—";
  return cachedDateTimeFormat(locale, "clock-ms", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  }).format(new Date(timestamp));
}

/** 解码吞吐；缺少任一时序事实时返回 null 而不是估算。 */
export function trajectoryThroughputTokensPerSecond(record: TrajectoryRecord): number | null {
  const metrics = record.assistantMetrics;
  if (metrics === undefined || !metrics.timingRecorded) return null;
  const { firstTokenAt, completedAt, outputTokens } = metrics;
  if (firstTokenAt === null || completedAt === null || outputTokens === null) return null;
  const decodingMs = completedAt - firstTokenAt;
  if (decodingMs <= 0 || outputTokens <= 0) return null;
  return (outputTokens / decodingMs) * 1000;
}

/** TTFT 与解码两段耗时，用于甘特块的内部分色与 Timing 面板。 */
export function trajectoryAssistantSegments(
  record: TrajectoryRecord,
): { ttftMs: number; decodingMs: number } | null {
  const metrics = record.assistantMetrics;
  if (metrics === undefined || !metrics.timingRecorded) return null;
  const { stepStartAt, firstTokenAt, completedAt } = metrics;
  if (stepStartAt === null || firstTokenAt === null || completedAt === null) return null;
  if (firstTokenAt < stepStartAt || completedAt < firstTokenAt) return null;
  return { ttftMs: firstTokenAt - stepStartAt, decodingMs: completedAt - firstTokenAt };
}

export const TRAJECTORY_USAGE_FIELDS = [
  "totalTokens",
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
] as const satisfies readonly (keyof TrajectoryUsage)[];
