/**
 * SteerQueuePanel —— steering 排队消息提示（P2-F1）。
 *
 * 流式中用户追加的引导消息在此列出（「运行中消息」语义，对齐 ZCode steering）：
 * 每条可 × 撤回；轮收敛后自动逐条续跑。挂载在 composer 上方。
 */

import { X } from "lucide-react";
import { useTranslation } from "../../i18n";

export function SteerQueuePanel({
  queue,
  onRemove,
}: {
  queue: string[];
  onRemove: (index: number) => void;
}) {
  const { t } = useTranslation();
  if (queue.length === 0) return null;

  return (
    <div data-testid="steer-queue" className="mx-4 mb-1 space-y-1">
      <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-dim)]">
        {t("steerQueueTitle")}
      </div>
      {queue.map((text, index) => (
        <div
          key={`${index}-${text.slice(0, 16)}`}
          className="flex min-w-0 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-2.5 py-1.5"
        >
          <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-secondary)]">
            {text}
          </span>
          <button
            type="button"
            aria-label={t("steerRemove")}
            title={t("steerRemove")}
            onClick={() => onRemove(index)}
            className="shrink-0 rounded p-0.5 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
