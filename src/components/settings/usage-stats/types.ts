/**
 * 用量统计快照类型（P1-7 复刻 ZCode，类型自 ZCode packages/shared/src/usage-stats.ts
 * 的 zod schema 转写为 TS interface——契约字段一一对应，未引入 zod）。
 */

export const APP_USAGE_RANGES = ["all", "7d", "30d"] as const;
export type AppUsageRange = (typeof APP_USAGE_RANGES)[number];

export interface AppUsageFavoriteModel {
  modelId: string | null;
  totalTokens: number;
  share: number;
}

export interface AppUsageSummary {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cacheHitRate: number;
  totalSessions: number;
  totalTurns: number;
  toolCallCount: number;
  toolErrorRate: number;
  modelErrorRate: number;
  avgTimeToFirstTokenMs: number | null;
  avgTurnDurationMs: number | null;
  activeDays: number;
  currentStreakDays: number;
  longestSessionMs: number;
  longestStreakDays: number;
  peakDayTokens: number;
  favoriteModel: AppUsageFavoriteModel | null;
}

export interface AppUsageHeatmapCell {
  date: string;
  level: 0 | 1 | 2 | 3 | 4;
  totalTokens: number;
  turnCount: number;
  toolCallCount: number;
}

export interface AppUsageHeatmapWeek {
  weekIndex: number;
  days: (AppUsageHeatmapCell | null)[];
}

export interface AppUsageHeatmap {
  startDate: string | null;
  endDate: string | null;
  maxTokens: number;
  weeks: AppUsageHeatmapWeek[];
}

export interface AppUsageDailyModelItem {
  modelId: string | null;
  totalTokens: number;
}

export interface AppUsageDailyModelUsage {
  date: string;
  models: AppUsageDailyModelItem[];
}

export interface AppUsageModelUsage {
  modelId: string | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  share: number;
}

export interface AppUsageToolUsage {
  toolName: string;
  callCount: number;
  errorCount: number;
  errorRate: number;
  avgDurationMs: number | null;
}

export interface AppUsageSnapshot {
  range: AppUsageRange;
  generatedAt: number;
  timeZone: string;
  source: "agent-db";
  summary: AppUsageSummary;
  heatmap: AppUsageHeatmap;
  dailyModelUsage: AppUsageDailyModelUsage[];
  models: AppUsageModelUsage[];
  tools: AppUsageToolUsage[];
}
