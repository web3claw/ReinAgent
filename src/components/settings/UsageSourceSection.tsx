/**
 * 用量来源面板（ROADMAP ⑧ + v2 下钻增强）：ZCode 复刻面板下方的增量区——
 * 范围选择（7d/30d/all + 对比上一期开关）+ 来源分布环形（点击行 → 明细）+
 * 来源×模型堆叠条（色段点击 → 明细过滤）+ 对比表 + 7×24 周热力图。
 *
 * 数据经 useAppUsageStats(range)（独立实例，不侵入 ZCode 复刻文件）；对比上期 =
 * 同 range 再查一次 usage_snapshot({offsetDays: 窗口天数})（Rust 侧仅来源两维偏移）。
 * 明细走 usage_details（30 天保留期——超窗如实提示，不另改保留期）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation, type TranslationKey } from "../../i18n";
import type { AppUsageRange } from "./usage-stats/types";
import type { AppUsageSnapshot as UsageSnapshot } from "./usage-stats/types";

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
type SourceExtras = UsageSnapshot & {
  sources?: SourceRow[];
  sourceModels?: SourceModelRow[];
  weekHourly?: { maxTokens: number; cells: WeekHourCell[] };
};

export interface UsageDetailRow {
  id: string;
  querySource: string;
  provider: string;
  model: string;
  startedAt: number;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}
export interface UsageDetailsResult {
  rows: UsageDetailRow[];
  total: number;
  sumTokens: number;
}
export interface UsageDetailsFilter {
  source?: string;
  model?: string;
  days?: number;
  limit?: number;
  offset?: number;
}

const DETAIL_PAGE = 50;
const RANGE_DAYS: Record<Exclude<AppUsageRange, "all">, number> = { "7d": 7, "30d": 30 };

/** 明细查询（浏览器模式/失败如实抛） */
export async function fetchUsageDetails(f: UsageDetailsFilter): Promise<UsageDetailsResult> {
  return invoke<UsageDetailsResult>("usage_details", { args: f });
}

/** 来源本期/上期增减：新增/消失特判，其余百分比（≥10% 取整保精度） */
export function compareDelta(cur: number, prev: number): { text: string; dir: "up" | "down" | "flat" | "new" | "gone" } {
  if (cur === 0 && prev === 0) return { text: "0%", dir: "flat" };
  if (prev === 0) return { text: "", dir: "new" };
  if (cur === 0) return { text: "", dir: "gone" };
  const pct = ((cur - prev) / prev) * 100;
  const rounded = Math.abs(pct) >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10;
  return { text: `${pct > 0 ? "+" : ""}${rounded}%`, dir: pct > 0 ? "up" : pct < 0 ? "down" : "flat" };
}

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
  "graph-extract": "usageSrcGraphExtract",
  wiki: "usageSrcWiki",
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

interface DetailPanelState {
  filter: UsageDetailsFilter;
  result: UsageDetailsResult | null;
  page: number;
  loading: boolean;
  error: string | null;
}

export function UsageSourceSection() {
  const { t } = useTranslation();
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const [range, setRange] = useState<AppUsageRange>("30d");
  const [compareOn, setCompareOn] = useState(false);
  const [cur, setCur] = useState<SourceExtras | null>(null);
  const [prev, setPrev] = useState<SourceExtras | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailPanelState | null>(null);
  const reqVersion = useRef(0);

  const load = useCallback(async () => {
    if (!isTauri) return;
    const version = ++reqVersion.current;
    setLoading(true);
    setError(null);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const tzOffsetMs = -new Date().getTimezoneOffset() * 60_000;
    try {
      const spanDays = (RANGE_DAYS as Partial<Record<AppUsageRange, number>>)[range] ?? 0;
      const offsetDays = compareOn && range !== "all" ? spanDays : 0;
      const [curSnap, prevSnap] = await Promise.all([
        invoke<SourceExtras>("usage_snapshot", { range, timeZone, tzOffsetMs, offsetDays: 0 }),
        offsetDays > 0
          ? invoke<SourceExtras>("usage_snapshot", { range, timeZone, tzOffsetMs, offsetDays })
          : Promise.resolve(null),
      ]);
      if (version !== reqVersion.current) return;
      setCur(curSnap);
      setPrev(offsetDays > 0 ? prevSnap : null);
    } catch (err) {
      if (version === reqVersion.current) setError(String(err));
    } finally {
      if (version === reqVersion.current) setLoading(false);
    }
  }, [range, compareOn, isTauri]);

  useEffect(() => {
    void load();
  }, [load]);

  const sources = useMemo(() => cur?.sources ?? [], [cur]);
  const sourceModels = useMemo(() => cur?.sourceModels ?? [], [cur]);
  const weekHourly = cur?.weekHourly;

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

  // 对比表：并集来源逐行本期/上期/增减
  const compareRows = useMemo(() => {
    if (!compareOn || !prev) return [];
    const curMap = new Map<string, SourceRow>(sources.map((s) => [s.source, s]));
    const prevMap = new Map<string, SourceRow>((prev.sources ?? []).map((s) => [s.source, s]));
    const keys = [...new Set([...curMap.keys(), ...prevMap.keys()])];
    return keys
      .map((k) => {
        const c = curMap.get(k)?.totalTokens ?? 0;
        const p = prevMap.get(k)?.totalTokens ?? 0;
        return { source: k, cur: c, prev: p, delta: compareDelta(c, p) };
      })
      .sort((a, b) => b.cur - a.cur);
  }, [compareOn, prev, sources]);

  const label = (source: string): string => {
    const key = SOURCE_LABEL_KEYS[source];
    return key ? t(key) : source;
  };

  const openDetails = useCallback(
    (filter: UsageDetailsFilter) => {
      const days = range === "all" ? 30 : RANGE_DAYS[range] ?? 30;
      setDetail({ filter: { ...filter, days, limit: DETAIL_PAGE, offset: 0 }, result: null, page: 0, loading: true, error: null });
    },
    [range],
  );

  // 明细面板数据拉取（page 变化重拉）
  useEffect(() => {
    if (!detail || !isTauri) return;
    let cancelled = false;
    void fetchUsageDetails(detail.filter)
      .then((r) => {
        if (!cancelled) setDetail((d) => (d ? { ...d, result: r, loading: false, error: null } : d));
      })
      .catch((err) => {
        if (!cancelled) setDetail((d) => (d ? { ...d, loading: false, error: String(err) } : d));
      });
    return () => {
      cancelled = true;
    };
  }, [detail?.filter, isTauri]); // eslint-disable-line react-hooks/exhaustive-deps

  const detailPage = useCallback(
    (page: number) => {
      setDetail((d) =>
        d ? { ...d, page, loading: true, filter: { ...d.filter, offset: page * DETAIL_PAGE } } : d,
      );
    },
    [],
  );

  if (error) {
    const isWeb = !isTauri;
    return (
      <div className="p-4 bg-[var(--bg-elev)] rounded-xl border border-[var(--border)]">
        <div className="font-medium mb-1">{t("usageSourceTitle")}</div>
        <p className="text-sm text-[var(--text-dim)]">{isWeb ? t("usageDesktopOnly") : error}</p>
      </div>
    );
  }

  if (!isTauri) {
    return (
      <div className="p-4 bg-[var(--bg-elev)] rounded-xl border border-[var(--border)]">
        <p className="text-sm text-[var(--text-dim)]">{t("usageDesktopOnly")}</p>
      </div>
    );
  }

  if (loading && !cur) {
    return (
      <div className="p-4 bg-[var(--bg-elev)] rounded-xl border border-[var(--border)]">
        <p className="text-sm text-[var(--text-dim)]">{t("usageLoading")}</p>
      </div>
    );
  }

  const hasAny = sources.length > 0;
  const rangeKeys: { key: AppUsageRange; labelKey: TranslationKey }[] = [
    { key: "7d", labelKey: "usageRange7d" },
    { key: "30d", labelKey: "usageRange30d" },
    { key: "all", labelKey: "usageRangeAll" },
  ];

  return (
    <div className="space-y-4">
      {/* 范围 + 对比开关 */}
      <div className="flex flex-wrap items-center gap-2 px-1">
        {rangeKeys.map(({ key, labelKey }) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setRange(key);
              // all 范围无「上一期」语义（账目仅 30 天且窗口无穷），强制关对比
              if (key === "all") setCompareOn(false);
            }}
            className={`rounded-lg border px-2.5 py-1 text-xs ${range === key ? "border-[var(--brand)] text-[var(--brand)]" : "border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)]"}`}
          >
            {t(labelKey)}
          </button>
        ))}
        <span className="flex-1" />
        <label className="flex items-center gap-1.5 text-xs text-[var(--text-dim)]">
          <input type="checkbox" checked={compareOn} disabled={range === "all"} onChange={(e) => setCompareOn(e.target.checked)} className="accent-[var(--brand)] disabled:opacity-40" />
          {t("usageComparePrev")}
        </label>
      </div>

      {/* 来源分布（环形 + 图例，点击行 → 明细） */}
      <div className="p-4 bg-[var(--bg-elev)] rounded-xl border border-[var(--border)]">
        <div className="font-medium">{t("usageSourceTitle")}</div>
        <div className="text-sm text-[var(--text-dim)] mb-3">
          {range === "all" ? t("usageSourceNote30d") : t("usageSourceDesc")}
        </div>
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
                <li key={s.source}>
                  <button
                    type="button"
                    onClick={() => openDetails({ source: s.source })}
                    className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-[var(--surface-hover)]"
                    title={t("usageDrillHint")}
                  >
                    <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: chartColor(i) }} />
                    <span className="min-w-0 flex-1 truncate">{label(s.source)}</span>
                    <span className="tabular-nums text-[var(--text-dim)]">{fmtTokens(s.totalTokens)}</span>
                    <span className="w-14 text-right tabular-nums text-[var(--text-dim)]">{(s.share * 100).toFixed(1)}%</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* 对比上一期表 */}
      {compareOn && compareRows.length > 0 ? (
        <div className="p-4 bg-[var(--bg-elev)] rounded-xl border border-[var(--border)]">
          <div className="font-medium">{t("usageCompareTitle")}</div>
          <div className="text-sm text-[var(--text-dim)] mb-2">{t("usageCompareDesc")}</div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[var(--text-dim)]">
                <th className="py-1 font-normal">{t("usageCompareColSource")}</th>
                <th className="py-1 text-right font-normal">{t("usageCompareColCur")}</th>
                <th className="py-1 text-right font-normal">{t("usageCompareColPrev")}</th>
                <th className="py-1 text-right font-normal">{t("usageCompareColDelta")}</th>
              </tr>
            </thead>
            <tbody>
              {compareRows.map((r) => (
                <tr key={r.source} className="border-t border-[var(--border)]">
                  <td className="py-1">{label(r.source)}</td>
                  <td className="py-1 text-right tabular-nums">{fmtTokens(r.cur)}</td>
                  <td className="py-1 text-right tabular-nums text-[var(--text-dim)]">{fmtTokens(r.prev)}</td>
                  <td
                    className={`py-1 text-right tabular-nums ${
                      r.delta.dir === "up" ? "text-[var(--diff-removed)]" : r.delta.dir === "down" ? "text-[var(--diff-added)]" : r.delta.dir === "new" ? "text-[var(--warn-text)]" : "text-[var(--text-dim)]"
                    }`}
                  >
                    {r.delta.dir === "new" ? t("usageCompareNew") : r.delta.dir === "gone" ? t("usageCompareGone") : r.delta.text}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* 来源 × 模型（色段点击 → 明细过滤） */}
      {stackedRows.length > 0 ? (
        <div className="p-4 bg-[var(--bg-elev)] rounded-xl border border-[var(--border)]">
          <div className="font-medium">{t("usageSourceModelTitle")}</div>
          <div className="text-sm text-[var(--text-dim)] mb-3">{t("usageSourceModelDesc")}</div>
          <div className="space-y-2.5">
            {stackedRows.map((row) => (
              <div key={row.source}>
                <div className="flex items-center justify-between text-xs mb-1">
                  <button type="button" onClick={() => openDetails({ source: row.source })} className="text-[var(--text)] hover:underline" title={t("usageDrillHint")}>
                    {label(row.source)}
                  </button>
                  <span className="tabular-nums text-[var(--text-dim)]">{fmtTokens(row.total)}</span>
                </div>
                <div className="flex h-3 w-full overflow-hidden rounded-full bg-[var(--surface-hover)]">
                  {row.models.map((m, i) => (
                    <button
                      key={m.model}
                      type="button"
                      onClick={() => openDetails({ source: row.source, model: m.model })}
                      title={`${m.model}: ${fmtTokens(m.tokens)} · ${t("usageDrillHint")}`}
                      className="cursor-pointer hover:brightness-125"
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

      {/* 明细下钻面板 */}
      {detail ? (
        <div className="p-4 bg-[var(--bg-elev)] rounded-xl border border-[var(--border)]" data-testid="usage-details-panel">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{t("usageDetailsTitle")}</span>
            {detail.filter.source ? (
              <span className="rounded-full bg-[var(--surface-hover)] px-2 py-0.5 text-[10px] text-[var(--text-dim)]">
                {t("usageFilterSource")}={label(detail.filter.source)}
              </span>
            ) : null}
            {detail.filter.model ? (
              <span className="rounded-full bg-[var(--surface-hover)] px-2 py-0.5 text-[10px] text-[var(--text-dim)]">
                {t("usageFilterModel")}={detail.filter.model}
              </span>
            ) : null}
            <span className="rounded-full bg-[var(--surface-hover)] px-2 py-0.5 text-[10px] text-[var(--text-dim)]">
              {t("usageFilterDays")}={detail.filter.days}{t("usageUnitDays")}
            </span>
            <span className="flex-1" />
            <button type="button" onClick={() => setDetail(null)} className="rounded px-1.5 py-0.5 text-xs text-[var(--text-dim)] hover:text-[var(--text)]" aria-label={t("usageDetailsClose")}>
              ✕
            </button>
          </div>
          {detail.error ? (
            <p className="text-xs text-[var(--danger)]">{detail.error}</p>
          ) : detail.loading ? (
            <p className="text-xs text-[var(--text-dim)]">{t("usageLoading")}</p>
          ) : !detail.result || detail.result.rows.length === 0 ? (
            <p className="text-xs text-[var(--text-dim)]">{t("usageDetailsEmpty")}</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-[11px]" data-testid="usage-details-table">
                  <thead>
                    <tr className="text-left text-[var(--text-dim)]">
                      <th className="py-1 pr-2 font-normal">{t("usageColTime")}</th>
                      <th className="py-1 pr-2 font-normal">{t("usageColSource")}</th>
                      <th className="py-1 pr-2 font-normal">{t("usageColModel")}</th>
                      <th className="py-1 pr-2 text-right font-normal">{t("usageColInput")}</th>
                      <th className="py-1 pr-2 text-right font-normal">{t("usageColOutput")}</th>
                      <th className="py-1 pr-2 text-right font-normal">{t("usageColCacheRead")}</th>
                      <th className="py-1 pr-2 text-right font-normal">{t("usageColTotal")}</th>
                      <th className="py-1 text-right font-normal">{t("usageColDuration")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.result.rows.map((r) => (
                      <tr key={r.id} className="border-t border-[var(--border)]">
                        <td className="py-1 pr-2 whitespace-nowrap text-[var(--text-dim)]">{new Date(r.startedAt).toLocaleString()}</td>
                        <td className="py-1 pr-2">{label(r.querySource)}</td>
                        <td className="py-1 pr-2 max-w-32 truncate" title={r.model || "—"}>{r.model || "—"}</td>
                        <td className="py-1 pr-2 text-right tabular-nums">{r.inputTokens.toLocaleString()}</td>
                        <td className="py-1 pr-2 text-right tabular-nums">{r.outputTokens.toLocaleString()}</td>
                        <td className="py-1 pr-2 text-right tabular-nums text-[var(--text-dim)]">{r.cacheReadTokens.toLocaleString()}</td>
                        <td className="py-1 pr-2 text-right tabular-nums font-medium">{r.totalTokens.toLocaleString()}</td>
                        <td className="py-1 text-right tabular-nums text-[var(--text-dim)]">{r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-2 flex items-center justify-between text-[11px] text-[var(--text-dim)]">
                <span>
                  {t("usageDetailsSummary", )
                    .replace("{n}", String(detail.result.total))
                    .replace("{tokens}", fmtTokens(detail.result.sumTokens))}
                  {detail.result.total > DETAIL_PAGE ? ` · ${t("usageDetailsWindowNote")}` : ""}
                </span>
                <span className="flex items-center gap-1.5">
                  <button type="button" disabled={detail.page === 0} onClick={() => detailPage(detail.page - 1)} className="rounded border border-[var(--border)] px-1.5 py-0.5 hover:text-[var(--text)] disabled:opacity-40">
                    ‹
                  </button>
                  <span>{detail.page + 1}/{Math.max(1, Math.ceil(detail.result.total / DETAIL_PAGE))}</span>
                  <button
                    type="button"
                    disabled={(detail.page + 1) * DETAIL_PAGE >= detail.result.total}
                    onClick={() => detailPage(detail.page + 1)}
                    className="rounded border border-[var(--border)] px-1.5 py-0.5 hover:text-[var(--text)] disabled:opacity-40"
                  >
                    ›
                  </button>
                </span>
              </div>
            </>
          )}
        </div>
      ) : null}

      {/* 7×24 周热力图 */}
      {weekRows.length === 7 ? (
        <div className="p-4 bg-[var(--bg-elev)] rounded-xl border border-[var(--border)]">
          <div className="font-medium">{t("usageWeekHourTitle")}</div>
          <div className="text-sm text-[var(--text-dim)] mb-3">{t("usageWeekHourDesc")}</div>
          <div className="overflow-x-auto">
            <div className="min-w-[560px]">
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
