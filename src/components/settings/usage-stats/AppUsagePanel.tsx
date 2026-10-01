import { RefreshCcw, Trash2 } from "lucide-react";
import { Fragment, lazy, useState } from "react";
import { APP_USAGE_RANGES } from "./types";
import type { AppUsageRange, AppUsageSnapshot } from "./types";
import { Button } from "../../lw/ui/button";
import { Tabs, TabsList, TabsTrigger } from "../../lw/ui/tabs";
import { useZCodeIntl } from "./usageIntl";
import { useAppUsageStats } from "./useAppUsageStats";
import { UsageChartLoadBoundary } from "./UsageChartLoadBoundary";
import { UsageHeatmap } from "./UsageHeatmap";
import { UsageStatsErrorNotice } from "./UsageStatsErrorNotice";
import {
  USAGE_STATS_TABS_LIST_CLASS,
  USAGE_STATS_TABS_TRIGGER_CLASS,
  UsageEmptyState,
  formatCompactNumber,
  formatSummaryCompactTokenUsage,
} from "./usageStatsUiParts";

// Recharts 会在模块初始化阶段触发 decimal.js-light 的 LN10 校验，
// 在 Electron Linux 容器里会阻断整个 renderer 启动。图表按需加载后，
// 普通启动和 e2e 首页不会被 Usage 页图表依赖影响，打开 Usage 时也由局部边界隔离。
const AppUsageDailyModelTrendChart = lazy(() =>
  import("./AppUsageDailyModelTrendChart").then((module) => ({
    default: module.AppUsageDailyModelTrendChart,
  })),
);
const AppUsageModelUsagePieChart = lazy(() =>
  import("./AppUsageModelUsagePieChart").then((module) => ({
    default: module.AppUsageModelUsagePieChart,
  })),
);

export function AppUsagePanel() {
  const { intl, locale } = useZCodeIntl();
  const [range, setRange] = useState<AppUsageRange>("7d");
  const [resetArmed, setResetArmed] = useState(false);
  const { snapshot: lifetimeSnapshot, refresh: refreshLifetime } = useAppUsageStats("all");
  const { snapshot, loading, error, refresh } = useAppUsageStats(range);

  if (loading && !snapshot) {
    return (
      <div className="space-y-5">
        <AppUsageLifetimeSummaryStrip snapshot={lifetimeSnapshot} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.usage.appUsageRangeTitle" })}
          </div>
          <AppUsageRangeTabs range={range} onRangeChange={setRange} />
        </div>
        {/* App Usage 只聚合本地 session 历史，不能复用 Coding Plan 的 monitor API 加载说明。*/}
        <UsageEmptyState
          title={intl.formatMessage({ id: "settings.usage.loadingTitle" })}
          description={intl.formatMessage({
            id: "settings.usage.appUsageLoadingDescription",
          })}
        />
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="space-y-5">
        <AppUsageLifetimeSummaryStrip snapshot={lifetimeSnapshot} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.usage.appUsageRangeTitle" })}
          </div>
          <AppUsageRangeTabs range={range} onRangeChange={setRange} />
        </div>
        {error ? <UsageStatsErrorNotice error={error} /> : null}
        <UsageEmptyState
          title={intl.formatMessage({ id: "settings.usage.emptyTitle" })}
          description={intl.formatMessage({
            id: "settings.usage.emptyDescription",
          })}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <AppUsageLifetimeSummaryStrip snapshot={lifetimeSnapshot} />
      {lifetimeSnapshot?.heatmap.weeks.length ? (
        <UsageHeatmap locale={locale} intl={intl} weeks={lifetimeSnapshot.heatmap.weeks} />
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.appUsageRangeTitle" })}
        </div>
        <AppUsageRangeTabs range={range} onRangeChange={setRange} />
      </div>
      {error ? <UsageStatsErrorNotice error={error} /> : null}

      <UsageChartLoadBoundary
        scope="settings.usage.app-daily-model-chart"
        resetKeys={[snapshot.range, snapshot.generatedAt]}
        loadingDescription={intl.formatMessage({
          id: "settings.usage.appUsageLoadingDescription",
        })}
      >
        <AppUsageDailyModelTrendChart snapshot={snapshot} />
      </UsageChartLoadBoundary>
      <UsageChartLoadBoundary
        scope="settings.usage.app-model-pie-chart"
        resetKeys={[snapshot.range, snapshot.generatedAt, "model-pie"]}
        loadingDescription={intl.formatMessage({
          id: "settings.usage.appUsageLoadingDescription",
        })}
      >
        <AppUsageModelUsagePieChart snapshot={snapshot} />
      </UsageChartLoadBoundary>

      <div className="flex justify-end gap-2">
        {/* 清零账目（两击确认）：DELETE model_usage + 回填水位线，历史源数据不再重灌 */}
        {resetArmed ? (
          <div className="flex items-center gap-1" data-usage-reset="true">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 border-red-500/40 text-red-500 hover:bg-red-500/10"
              onClick={() => {
                void (async () => {
                  try {
                    const { invoke } = await import("@tauri-apps/api/core");
                    await invoke("usage_reset");
                    await Promise.all([refresh(), refreshLifetime()]);
                  } catch (err) {
                    console.error("[usage] reset failed:", err);
                  } finally {
                    setResetArmed(false);
                  }
                })();
              }}
            >
              确认清零
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={() => setResetArmed(false)}
            >
              取消
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 rounded-md bg-background"
            title="清空全部模型用量账目，从零开始记账"
            onClick={() => setResetArmed(true)}
          >
            <Trash2 className="size-3.5" />
            清零
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 rounded-md bg-background"
          onClick={() => {
            void Promise.all([refresh(), refreshLifetime()]);
          }}
        >
          <RefreshCcw className="size-3.5" />
          {intl.formatMessage({ id: "settings.usage.refresh" })}
        </Button>
      </div>
    </div>
  );
}

function AppUsageLifetimeSummaryStrip({ snapshot }: { snapshot: AppUsageSnapshot | null }) {
  const { intl, locale } = useZCodeIntl();
  const items = [
    {
      label: intl.formatMessage({ id: "settings.usage.lifetimeTotalTokens" }),
      value: snapshot ? formatSummaryCompactTokenUsage(locale, snapshot.summary.totalTokens) : "--",
    },
    {
      label: intl.formatMessage({ id: "settings.usage.lifetimePeakTokens" }),
      value: snapshot
        ? formatSummaryCompactTokenUsage(locale, snapshot.summary.peakDayTokens)
        : "--",
    },
    {
      label: intl.formatMessage({ id: "settings.usage.longestSession" }),
      value: snapshot ? formatAppUsageDuration(snapshot.summary.longestSessionMs, intl) : "--",
    },
    {
      label: intl.formatMessage({ id: "settings.usage.currentStreak" }),
      value: snapshot ? formatAppUsageDays(snapshot.summary.currentStreakDays, intl, locale) : "--",
    },
    {
      label: intl.formatMessage({ id: "settings.usage.longestStreak" }),
      value: snapshot ? formatAppUsageDays(snapshot.summary.longestStreakDays, intl, locale) : "--",
    },
  ];

  return (
    <section className="flex flex-col overflow-hidden rounded-xl bg-surface sm:flex-row sm:items-center">
      {items.map((item, index) => (
        <Fragment key={item.label}>
          {index > 0 ? (
            <div aria-hidden="true" className="hidden h-7 w-px bg-border sm:block" />
          ) : null}
          <div className="min-w-0 flex-1 px-4 py-3 text-center">
            <div className="truncate text-ui-lg font-medium text-foreground">{item.value}</div>
            <div className="mt-1 truncate text-ui-base text-foreground-subtle">{item.label}</div>
          </div>
        </Fragment>
      ))}
    </section>
  );
}

function formatAppUsageDays(
  days: number,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  locale: string,
): string {
  return `${formatCompactNumber(locale, days)} ${intl.formatMessage({
    id: "settings.usage.duration.day",
  })}`;
}

export function formatAppUsageDuration(
  durationMs: number,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
): string {
  const totalMinutes = Math.max(0, Math.floor(durationMs / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days} ${intl.formatMessage({ id: "settings.usage.duration.day" })}`);
  }
  if (hours > 0) {
    parts.push(`${hours} ${intl.formatMessage({ id: "settings.usage.duration.hour" })}`);
  }
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes} ${intl.formatMessage({ id: "settings.usage.duration.minute" })}`);
  }
  return parts.join(" ");
}

function AppUsageRangeTabs({
  range,
  onRangeChange,
}: {
  range: AppUsageRange;
  onRangeChange: (range: AppUsageRange) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Tabs
      value={range}
      onValueChange={(value) => onRangeChange(value as AppUsageRange)}
      className="shrink-0"
    >
      <TabsList className={USAGE_STATS_TABS_LIST_CLASS}>
        {APP_USAGE_RANGES.filter((option) => option !== "all").map((option) => (
          <TabsTrigger key={option} value={option} className={USAGE_STATS_TABS_TRIGGER_CLASS}>
            {intl.formatMessage({ id: `settings.usage.range.${option}` })}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
