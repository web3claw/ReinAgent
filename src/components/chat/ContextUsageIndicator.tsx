/**
 * ContextUsageIndicator —— 上下文容量指示器（对齐 ZCode ChatContextUsage/ContextTrigger）。
 *
 * - 触发器：SVG 圆环，按已用百分比画进度弧（strokeDashoffset）；
 * - 悬停面板（radix-ui HoverCard，side=top 宽 320）：标题行 + 多段进度条（品牌色按占比
 *   排名逐级淡化）+ 分类行（彩点 + 名称 + 百分比）+ 命中率行（≥78% 才显示，分隔线隔开）；
 * - 「剩余额度」区块不在本功能范围（用户已确认排除）。
 */
import { HoverCard } from "radix-ui";
import type { ContextUsageData } from "../../lib/chat/contextUsage";
import { formatCompactTokens } from "../../lib/chat/contextUsage";
import { useTranslation, type TranslationKey } from "../../i18n";
import { useAppStore } from "../../store/useAppStore";

const TONE_OPS = [100, 78, 58, 42, 28];

function tone(rank: number): string {
  const op = TONE_OPS[Math.min(rank, TONE_OPS.length - 1)];
  return `color-mix(in srgb, var(--brand) ${op}%, transparent)`;
}

const RING_RADIUS = 8;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** 圆环颜色按用量语义化：充足绿 / 偏高琥珀 / 接近满红 */
function ringColor(pct: number): string {
  if (pct >= 95) return "var(--danger)";
  if (pct >= 80) return "var(--status-warn)";
  return "var(--status-ok)";
}

export function ContextUsageIndicator({ data }: { data: ContextUsageData }) {
  const { t, locale } = useTranslation();
  const openCodeViewer = useAppStore((state) => state.openCodeViewer);
  const pct = Math.min(100, Math.max(0, data.percent));
  const usedText = formatCompactTokens(data.used, locale);
  const totalText = formatCompactTokens(data.total, locale);
  const sorted = data.categories;

  return (
    <HoverCard.Root openDelay={120} closeDelay={80}>
      <HoverCard.Trigger asChild>
        <button
          type="button"
          className="flex items-center transition-colors cursor-pointer"
          title={t("contextUsageTitle")}
          aria-label={t("contextUsageTitle")}
        >
          <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
            <circle
              cx="10" cy="10" r={RING_RADIUS} fill="none"
              stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5"
            />
            <circle
              cx="10" cy="10" r={RING_RADIUS} fill="none"
              stroke={ringColor(pct)} strokeWidth="2.5" strokeLinecap="round"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={RING_CIRCUMFERENCE * (1 - pct / 100)}
              transform="rotate(-90 10 10)"
            />
          </svg>
        </button>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="top"
          align="end"
          sideOffset={8}
          className="z-50 w-80 rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-3 shadow-xl select-none"
        >
          {/* 标题行 */}
          <div className="flex items-center justify-between mb-2">
            <span className="text-[15px] font-medium text-[var(--text)]">{t("contextUsageTitle")}</span>
            <span className="font-mono text-[14px] text-[var(--text-secondary)]">
              {usedText}/{totalText}（{pct.toFixed(1)}%）
            </span>
          </div>

          {/* 多段进度条（对齐 ZCode Progress 双口径）：轨道上「指示条宽度 = 真实
              used/window 百分比」，构成分段（各分类占内容总量的比例）用 flexBasis
              画在指示条内部、按排名逐级淡化——0.2% 用量时指示条只是轨道起点的一小段，
              而不是把构成比铺满整条轨道。 */}
          <div className="h-2 rounded-full overflow-hidden bg-[var(--bg-sunken)] flex">
            <div
              className="flex h-full min-w-[2px] overflow-hidden rounded-full"
              style={{ width: `${pct}%` }}
            >
              {sorted
                .map((cat, rank) => ({ cat, rank }))
                .filter(({ cat }) => (cat.chars ?? 0) > 0)
                .map(({ cat, rank }) => (
                  <span
                    key={cat.key}
                    className="h-full shrink-0"
                    style={{
                      flexBasis: `${cat.percent}%`,
                      backgroundColor: tone(rank),
                    }}
                  />
                ))}
            </div>
          </div>

          {/* 分类明细行：彩点 + 名称 + 百分比 */}
          <div className="mt-2 flex flex-col gap-2">
            {sorted.map((cat, rank) => {
              const clickable = typeof cat.buildContent === "function";
              const RowTag = (clickable ? "button" : "div") as "button";
              return (
                <RowTag
                  key={cat.key}
                  {...(clickable
                    ? {
                        type: "button" as const,
                        onClick: () => {
                          const content = cat.buildContent!();
                          const type = cat.key === "systemTools" ? "json" : "markdown";
                          openCodeViewer({
                            type: "text",
                            title: `${t("contextUsageTitle")} · ${t(cat.labelKey as TranslationKey)}`,
                            content,
                            language: cat.language ?? type,
                            // 面板打开期间内容变化（如切换助手 → 系统提示词变化）自动跟随刷新
                            liveCategory: cat.key,
                          });
                        },
                      }
                    : {})}
                  className={`flex items-center justify-between gap-2 text-[15px] w-full text-left ${
                    clickable ? "cursor-pointer rounded-md px-1 -mx-1 hover:bg-[var(--surface-hover)]" : ""
                  }`}
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span
                      className="w-2 h-2 rounded-sm shrink-0 border border-[var(--border)]"
                      style={{ backgroundColor: tone(rank) }}
                    />
                    <span
                      className={`truncate ${clickable ? "text-[var(--text)]" : "text-[var(--text-secondary)]"}`}
                    >
                      {t(cat.labelKey as TranslationKey)}
                    </span>
                  </span>
                  <span className="font-mono tabular-nums text-[var(--text-secondary)]">
                    {cat.percent.toFixed(1)}%
                  </span>
                </RowTag>
              );
            })}
          </div>
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
