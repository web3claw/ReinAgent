/**
 * WebSearchGroupCard —— 联网搜索聚合行（对齐 LiveAgent HostedSearchGroupView）。
 *
 * 把回合内**连续**的 websearch 工具条目折叠为一行：
 *   「已搜索 N 次 · N 个来源」（运行中 =「正在联网搜索」+ 扫光；部分失败显示失败数）。
 * 展开后：逐次搜索的 query 行（含失败原因）+ 去重来源列表（favicon + 标题/host，
 * 收起态只显示前 5 条，其余以「查看其余 N 个来源」展开）。
 */

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { ToolTimelineEntry } from "../../lib/chat/conversationModel";
import { useTranslation } from "../../i18n";
import { ToolLayout } from "../../preview/ToolCallBlocks/ToolLayout";
import { Globe } from "lucide-react";

/** 收起态默认展示的来源条数（对齐 LA COLLAPSED_SOURCE_COUNT）。 */
const COLLAPSED_SOURCE_COUNT = 5;

interface SourceRow {
  url: string;
  title: string;
}

/** 跨多次搜索去重来源（按 URL 原样去重，对齐 LA getUniqueSources）。 */
function collectSources(entries: ToolTimelineEntry[]): SourceRow[] {
  const seen = new Set<string>();
  const rows: SourceRow[] = [];
  for (const entry of entries) {
    const sources = Array.isArray(entry.details?.sources) ? entry.details.sources : [];
    for (const s of sources) {
      if (!s || typeof s.url !== "string" || seen.has(s.url)) continue;
      seen.add(s.url);
      rows.push({ url: s.url, title: typeof s.title === "string" ? s.title : "" });
    }
  }
  return rows;
}

function sourceHost(url: string): string {
  return url.replace(/^https?:\/\//, "").split("/")[0] ?? url;
}

/** favicon 取站点根 /favicon.ico，加载失败兜底 a.favicon.im（对齐 LA）。 */
function SourceFavicon({ url }: { url: string }) {
  let host = "";
  let primary = "";
  try {
    const parsed = new URL(url);
    host = parsed.host;
    primary = `${parsed.origin}/favicon.ico`;
  } catch {
    return <Globe className="size-3.5 shrink-0 text-foreground-subtle" />;
  }
  return (
    <img
      src={primary}
      alt=""
      loading="lazy"
      className="size-3.5 shrink-0 rounded-sm"
      onError={(e) => {
        const img = e.currentTarget;
        if (img.dataset.fallback) return;
        img.dataset.fallback = "1";
        img.src = `https://a.favicon.im/${host}`;
      }}
    />
  );
}

export function WebSearchGroupCard({ entries }: { entries: ToolTimelineEntry[] }) {
  const { t } = useTranslation();
  const [showAllSources, setShowAllSources] = useState(false);

  const searchCount = entries.length;
  const sources = useMemo(() => collectSources(entries), [entries]);
  const running = entries.some((e) => e.status === "running");
  const failedEntries = entries.filter((e) => e.isError);
  const failedCount = failedEntries.length;

  const statusLabel = running
    ? t("toolStatusRunning")
    : failedCount > 0
      ? t("toolStatusFailed")
      : t("toolStatusDone");
  const statusTooltip =
    failedCount > 0 ? failedEntries.map((e) => e.error ?? e.resultText).join("\n") : undefined;

  const searchedLabel = t("webSearchGroupSearched").replace("{count}", String(searchCount));
  const sourceLabel =
    sources.length > 0 ? t("webSearchGroupSources").replace("{count}", String(sources.length)) : "";
  const primaryLabel = sourceLabel ? `${searchedLabel} · ${sourceLabel}` : searchedLabel;

  const visibleSources = showAllSources ? sources : sources.slice(0, COLLAPSED_SOURCE_COUNT);
  const hiddenCount = sources.length - visibleSources.length;

  return (
    <ToolLayout
      toolId={`websearch-group-${entries[0]?.id ?? "0"}`}
      icon={<Globe className="size-4 shrink-0 text-foreground-subtle" />}
      kindLabel={running ? t("webSearchGroupRunning") : t("webSearchGroupSearched").replace("{count}", String(searchCount))}
      primaryText={<span className="min-w-0 truncate">{primaryLabel}</span>}
      statusLabel={failedCount > 0 ? <span className="text-[var(--danger)]">{t("webSearchGroupFailed").replace("{count}", String(failedCount))}</span> : statusLabel}
      showStatusLabel={!running || failedCount > 0}
      showFailureStatus={failedCount > 0}
      statusTooltip={statusTooltip}
      isRunning={running}
      renderContent={() => (
        <div className="mb-2 space-y-1.5 border-l-2 border-border pl-3">
          {entries.map((entry) => (
            <div key={entry.id} className="space-y-1">
              <div className="flex min-w-0 items-center gap-1.5 text-sm text-[var(--text)]">
                <Search className="size-3.5 shrink-0 text-foreground-subtle" />
                <span className="min-w-0 truncate">
                  {typeof entry.args?.query === "string" ? entry.args.query : t("webSearchGroupRunning")}
                </span>
              </div>
              {entry.isError ? (
                <p className="truncate pl-5 text-xs text-[var(--danger)]">
                  {entry.error ?? entry.resultText}
                </p>
              ) : null}
            </div>
          ))}
          {visibleSources.length > 0 ? (
            <div className="space-y-1 pt-1">
              {visibleSources.map((s) => (
                <div key={s.url} className="flex min-w-0 items-center gap-1.5 text-sm text-[var(--text)]" title={s.url}>
                  <SourceFavicon url={s.url} />
                  <span className="min-w-0 truncate">{s.title || sourceHost(s.url)}</span>
                </div>
              ))}
              {hiddenCount > 0 ? (
                <button
                  type="button"
                  className="pl-0.5 text-sm text-foreground-subtle hover:underline"
                  onClick={() => setShowAllSources(true)}
                >
                  {t("webSearchGroupMore").replace("{count}", String(hiddenCount))}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    />
  );
}
