import { memo, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import { useTranslation } from "../../i18n";

/** 单次重试记录（对齐 LiveAgent RetryAttemptRecord）。 */
export interface RetryAttemptRecord {
  attempt: number;
  maxAttempts: number;
  errorMessage: string;
  /** 本次重试前的退避时长（毫秒） */
  plannedDelayMs?: number;
}

/**
 * 重试详情块（对齐 LiveAgent RetryDetailsBlock）：
 * 折叠头「重试详情 (N)」，展开为每次重试的卡片列表（第 N/M 次重试 + 错误原文）。
 */
export const RetryDetailsBlock = memo(function RetryDetailsBlock({
  attempts,
}: {
  attempts: readonly RetryAttemptRecord[];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  if (attempts.length === 0) return null;

  return (
    <div className="w-full">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full cursor-pointer select-none items-center gap-2 py-1.5 text-left text-[13px] font-normal text-[var(--text-dim)] hover:text-[var(--text)]"
      >
        <RefreshCw className="h-3.5 w-3.5 shrink-0 opacity-60" />
        <span>
          {t("retryDetailsToggle").replace("{count}", String(attempts.length))}
        </span>
        <ChevronRight
          className={`ml-auto h-3.5 w-3.5 opacity-60 transition-transform duration-200 ease-out ${
            open ? "rotate-90" : ""
          }`}
        />
      </button>
      {open && (
        <div className="space-y-1 pb-1 pt-1.5">
          {attempts.map((entry, index) => (
            <div
              key={`${index}-${entry.attempt}-${entry.maxAttempts}`}
              className="rounded-md border border-[var(--border)] bg-[var(--bg-sunken)] px-2.5 py-1.5 text-xs text-[var(--text-secondary)]"
            >
              <div className="font-medium text-[var(--text)]">
                {t("retryAttemptLabel")
                  .replace("{attempt}", String(entry.attempt))
                  .replace("{maxAttempts}", String(entry.maxAttempts))}
              </div>
              <div className="whitespace-pre-wrap break-words">{entry.errorMessage}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
