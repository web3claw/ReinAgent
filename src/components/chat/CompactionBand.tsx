/**
 * CompactionBand —— 压缩标记带（对齐 LiveAgent CompactionBand / ZCode compact 分隔线）。
 *
 * 两态：
 * - **running**：shimmer 文案「正在压缩上下文…」（压缩期间占位在时间线里）；
 * - **settled**：可展开的 seam 行——chips「覆盖 N 条消息」+ 摘要 markdown（默认收起）。
 *
 * 颜色全部走语义变量（禁硬编码色值）；`prefers-reduced-motion` 退化为静态文案。
 */

import { useState } from "react";
import { ChevronRight, History } from "lucide-react";
import { MarkdownText } from "./MarkdownText";
import { useTranslation } from "../../i18n";

export interface CompactionBandProps {
  state: "running" | "settled";
  /** 被压缩的消息数（settled 态 chips 用） */
  coveredCount?: number;
  /** 摘要文本（settled 态展开显示） */
  summary?: string;
}

export function CompactionBand({ state, coveredCount, summary }: CompactionBandProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  if (state === "running") {
    return (
      <div className="compaction-band-running" role="status">
        <History className="w-3.5 h-3.5 shrink-0" />
        <span className="compaction-shimmer">{t("compactionRunning")}</span>
      </div>
    );
  }

  const hasBody = typeof summary === "string" && summary.length > 0;
  return (
    <div className="compaction-band-seam">
      {hasBody ? (
        <button
          type="button"
          className="compaction-seam-trigger"
          aria-expanded={open}
          onClick={() => setOpen((cur) => !cur)}
        >
          <ChevronRight
            className={`w-3.5 h-3.5 shrink-0 transition-transform text-[var(--text-dim)] ${
              open ? "rotate-90" : ""
            }`}
          />
          <History className="w-3.5 h-3.5 shrink-0 text-[var(--text-dim)]" />
          <span className="text-xs text-[var(--text-dim)]">
            {t("compactionSettled").replace("{count}", String(coveredCount ?? 0))}
          </span>
        </button>
      ) : (
        <div className="compaction-seam-trigger compaction-seam-static">
          <History className="w-3.5 h-3.5 shrink-0 text-[var(--text-dim)]" />
          <span className="text-xs text-[var(--text-dim)]">
            {t("compactionSettled").replace("{count}", String(coveredCount ?? 0))}
          </span>
        </div>
      )}
      {open && hasBody ? (
        <div className="compaction-summary md">
          <MarkdownText text={summary ?? ""} />
        </div>
      ) : null}
    </div>
  );
}
