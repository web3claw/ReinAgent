/**
 * 用量来源面板（ROADMAP ⑧）：ZCode 复刻面板下方的增量区——来源分布环形 +
 * 来源×模型堆叠条 + 7×24 周热力图。数据经 useAppUsageStats("all")（独立实例，
 * 不侵入复刻文件）；Rust usage_snapshot 的 sources/sourceModels/weekHourly 增量字段
 * 用交叉类型断言读取（复刻 types.ts 保持零改动）。
 */

import { useMemo } from "react";
import { useTranslation, type TranslationKey } from "../../i18n";
import { useAppUsageStats } from "./usage-stats/useAppUsageStats";
import type { AppUsageSnapshot } from "./usage-stats/types";

interface SourceRow {
  source: string;
  totalTokens: number;
  requestCount: number;
  share: number;
}
interface SourceModelRow {
  source: string;
  modelId: string | null;
  totalTokens: number;
}
interface WeekHourCell {
  date: string;
  hour: number;
  totalTokens: number;
  level: number;
}
type SourceExtras = AppUsageSnapshot & {
  sources?: SourceRow[];
  sourceModels?: SourceModelRow[];
  weekHourly?: { maxTokens: number; cells: WeekHourCell[] };
};

const SOURCE_LABEL_KEYS: Record<string, TranslationKey> = {
  chat: "usageSrcChat",
  kanban: "usageSrcKanban",
  automation: "usageSrcAutomation",
  subagent: "usageSrcSubagent",
  "note-ai": "usageSrcNoteAi",
  "memory-organizer": "usageSrcMemoryOrganizer",
  title: "usageSrcTitle",
  embedding: "usageSrcEmbedding",
  "commit-message": "usageSrcCommitMessage",
  "prompt-enhance": "usageSrcPromptEnhance",
};

/** 环形/堆叠段色：复用 usage 图表色板变量（chart-1..6 循环） */
const chartColor = (i: number) => `var(--color-usage-chart-${(i % 6) + 1})`;

const HEAT_LEVEL_COLORS = [
  "var(--color-usage-heatmap-0)",
  "var(--color-usage-heatmap-1)",
  "var(--color-usage-heatmap-2)",
  "var(--color-usage-heatmap-3)",
  "var(--color-usage-heatmap-4)",
];

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const WEEKDAY_KEYS: TranslationKey[] = ["usageWeekdaySun", "usageWeekdayMon", "usageWeekdayTue", "usageWeekdayWed", "usageWeekdayThu", "usageWeekdayFri", "usageWeekdaySat"];

export function UsageSourceSection() {
  const { t } = useTranslation();
  const { snapshot, loading, error } = useAppUsageStats("all");
  const data = snapshot as SourceExtras | null;

  const sources = useMemo(() => data?.sources ?? [], [data]);
  const sourceModels = useMemo(() => data?.sourceModels ?? [], [data]);
  const weekHourly = data?.weekHourly;

  // 来源×模型 → 每来源一行（段=模型）
  const stackedRows = useMemo(() => {
    const bySource = new Map<string, { total: number; models: { model: string; tokens: number }[] }>();
    for (const row of sourceModels) {
      const entry = bySource.get(row.source) ?? { total: 0, models: [] };
      entry.total += row.totalTokens;
      entry.models.push({ model: row.modelId ?? "—", tokens: row.totalTokens });
      bySource.set(row.source, entry);
    }
    return [...bySource.entries()]
      .map(([source, v]) => ({
        source,
        total: v.total,
        models: v.models.sort((a, b) => b.tokens - a.tokens),
      }))
      .sort((a, b) => b.total - a.total);
  }, [sourceModels]);

  // 7×24 → 按天分 7 行
  const weekRows = useMemo(() => {
    if (!weekHourly) return [];
    const rows: { date: string; cells: WeekHourCell[] }[] = [];
    for (const cell of weekHourly.cells) {
      const last = rows[rows.length - 1];
      if (!last || last.date !== cell.date) {
        rows.push({ date: cell.date, cells: [cell] });
      } else {
        last.cells.push(cell);
      }
    }
    return rows;
  }, [weekHourly]);

  const label = (source: string): string => {
    const key = SOURCE_LABEL_KEYS[source];
    return key ? t(key) : source;
  };

  if (error) {
    // 浏览器模式（无 Tauri invoke）显示桌面端引导；真实错误如实展示（no-fallback）
    const isWeb = typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);
    return (
      <div className="p-4 bg-[var(--bg-elev)] rounded-xl border border-[var(--border)]">
        <div className="font-medium mb-1">{t("usageSourceTitle")}</div>
        <p className="text-sm text-[var(--text-dim)]">{isWeb ? t("usageDesktopOnly") : error}</p>
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="p-4 bg-[var(--bg-elev)] rounded-xl border border-[var(--border)]">
        <p className="text-sm text-[var(--text-dim)]">{t("usageLoading")}</p>
      </div>
    );
  }

  const hasAny = sources.length > 0;

  return (
    <div className="space-y-4">
      {/* 来源分布（环形 + 图例） */}
      <div className="p-4 bg-[var(--bg-elev)] rounded-xl border border-[var(--border)]">
        <div className="font-medium">{t("usageSourceTitle")}</div>
        <div className="text-sm text-[var(--text-dim)] mb-3">{t("usageSourceDesc")}</div>
        {!hasAny ? (
          <p className="text-sm text-[var(--text-dim)]">{t("usageEmpty")}</p>
        ) : (
          <div className="flex flex-col sm:flex-row items-center gap-5">
            <svg viewBox="0 0 120 120" className="h-32 w-32 shrink-0 -rotate-90" role="img" aria-label={t("usageSourceTitle")}>
              {(() => {
                let acc = 0;
                const r = 48;
                const c = 2 * Math.PI * r;
                return sources.map((s, i) => {
                  const frac = Math.min(1, Math.max(0, s.share));
                  const dash = frac * c;
                  const el = (
                    <circle
                      key={s.source}
                      cx="60"
                      cy="60"
                      r={r}
                      fill="none"
                      stroke={chartColor(i)}
                      strokeWidth="16"
                      strokeDasharray={`${dash} ${c - dash}`}
                      strokeDashoffset={-acc * c}
                    />
                  );
                  acc += frac;
                  return el;
                });
              })()}
            </svg>
            <ul className="flex-1 min-w-0 w-full space-y-1">
              {sources.map((s, i) => (
                <li key={s.source} className="flex items-center gap-2 text-sm">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: chartColor(i) }} />
                  <span className="min-w-0 flex-1 truncate">{label(s.source)}</span>
                  <span className="tabular-nums text-[var(--text-dim)]">{fmtTokens(s.totalTokens)}</span>
                  <span className="w-14 text-right tabular-nums text-[var(--text-dim)]">{(s.share * 100).toFixed(1)}%</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* 来源 × 模型（横向堆叠条） */}
      {stackedRows.length > 0 ? (
        <div className="p-4 bg-[var(--bg-elev)] rounded-xl border border-[var(--border)]">
          <div className="font-medium">{t("usageSourceModelTitle")}</div>
          <div className="text-sm text-[var(--text-dim)] mb-3">{t("usageSourceModelDesc")}</div>
          <div className="space-y-2.5">
            {stackedRows.map((row) => (
              <div key={row.source}>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span>{label(row.source)}</span>
                  <span className="tabular-nums text-[var(--text-dim)]">{fmtTokens(row.total)}</span>
                </div>
                <div className="flex h-3 w-full overflow-hidden rounded-full bg-[var(--surface-hover)]">
                  {row.models.map((m, i) => (
                    <div
                      key={m.model}
                      title={`${m.model}: ${fmtTokens(m.tokens)}`}
                      style={{ width: `${(m.tokens / row.total) * 100}%`, background: chartColor(i) }}
                    />
                  ))}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-[var(--text-dim)]">
                  {row.models.slice(0, 4).map((m, i) => (
                    <span key={m.model} className="flex items-center gap-1">
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: chartColor(i) }} />
                      {m.model}
                    </span>
                  ))}
                  {row.models.length > 4 ? <span>+{row.models.length - 4}</span> : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* 7×24 周热力图 */}
      {weekRows.length === 7 ? (
        <div className="p-4 bg-[var(--bg-elev)] rounded-xl border border-[var(--border)]">
          <div className="font-medium">{t("usageWeekHourTitle")}</div>
          <div className="text-sm text-[var(--text-dim)] mb-3">{t("usageWeekHourDesc")}</div>
          <div className="overflow-x-auto">
            <div className="min-w-[560px]">
              {/* 小时刻度：每 6 小时一档 */}
              <div className="flex pl-9 text-[10px] text-[var(--text-dim)] mb-1">
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="flex-1 text-center">
                    {h % 6 === 0 ? h : ""}
                  </div>
                ))}
              </div>
              {weekRows.map((row) => {
                const weekday = new Date(`${row.date}T00:00:00`).getDay();
                return (
                  <div key={row.date} className="flex items-center mb-1">
                    <div className="w-9 shrink-0 text-[10px] text-[var(--text-dim)]">{t(WEEKDAY_KEYS[weekday])}</div>
                    <div className="flex flex-1 gap-[2px]">
                      {row.cells.map((cell) => (
                        <div
                          key={cell.hour}
                          title={`${row.date} ${String(cell.hour).padStart(2, "0")}:00 · ${fmtTokens(cell.totalTokens)} tokens`}
                          className="h-4 flex-1 rounded-[2px]"
                          style={{ background: HEAT_LEVEL_COLORS[Math.min(4, Math.max(0, cell.level))] }}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
