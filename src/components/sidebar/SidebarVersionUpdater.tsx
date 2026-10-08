import { useEffect } from "react";
import { Download, AlertCircle } from "lucide-react";
import { useTranslation } from "../../i18n";
import { useAppUpdateStore } from "../../store/useAppUpdateStore";

interface SidebarVersionUpdaterProps {
  versionText: string;
}

export function SidebarVersionUpdater({ versionText }: SidebarVersionUpdaterProps) {
  const { t } = useTranslation();
  const status = useAppUpdateStore((s) => s.status);
  const percent = useAppUpdateStore((s) => s.percent);
  const hasAutoChecked = useAppUpdateStore((s) => s.hasAutoChecked);
  const checkAndAutoDownload = useAppUpdateStore((s) => s.checkAndAutoDownload);
  const retry = useAppUpdateStore((s) => s.retry);
  const restart = useAppUpdateStore((s) => s.restart);
  const initListener = useAppUpdateStore((s) => s.initListener);
  const setCurrentVersion = useAppUpdateStore((s) => s.setCurrentVersion);

  useEffect(() => {
    if (versionText) {
      setCurrentVersion(versionText);
    }
    const cleanup = initListener();
    if (!hasAutoChecked) {
      void checkAndAutoDownload();
    }
    return () => {
      cleanup();
    };
  }, [versionText, hasAutoChecked, initListener, checkAndAutoDownload, setCurrentVersion]);

  // 1. 正在检查中 / 正在下载中：圆圈进度圈（带百分比）
  if (status === "checking" || status === "downloading") {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    const size = 22;
    const strokeWidth = 2.2;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const strokeDashoffset = circumference - (circumference * clamped) / 100;
    const tooltipText =
      status === "checking"
        ? t("updaterStatusChecking")
        : t("updaterStatusDownloading").replace("{percent}", String(clamped));

    return (
      <div className="group/tt relative inline-flex items-center justify-center">
        <div
          className="relative inline-flex items-center justify-center shrink-0 select-none text-[var(--brand)]"
          style={{ width: size, height: size }}
          role="progressbar"
          aria-valuenow={clamped}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            className="transform -rotate-90 block"
          >
            {/* 背景底环 */}
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth={strokeWidth}
              opacity={0.25}
            />
            {/* 动态进度环 */}
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth={strokeWidth}
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffset}
              strokeLinecap="round"
              className="transition-all duration-150 ease-out"
            />
          </svg>
          <span
            className="absolute inset-0 flex items-center justify-center font-bold leading-none tracking-tighter text-[var(--brand)]"
            style={{
              fontSize: "7.5px",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {clamped}%
          </span>
        </div>

        {/* Tooltip */}
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full right-0 z-50 mb-1.5 whitespace-nowrap rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-2.5 py-1.5 opacity-0 shadow-xl transition-opacity duration-100 group-hover/tt:opacity-100"
        >
          <span className="text-xs font-medium text-[var(--text)]">{tooltipText}</span>
        </span>
      </div>
    );
  }

  // 2. 下载完成待重启：绿色下载图标，hover 提示「立即重启更新」，点击重启
  if (status === "ready") {
    return (
      <div className="group/tt relative inline-flex items-center justify-center">
        <button
          type="button"
          onClick={() => void restart()}
          aria-label={t("updaterRestartNow")}
          className="relative flex items-center justify-center w-6 h-6 rounded-full bg-emerald-500 hover:bg-emerald-600 active:scale-95 text-white shadow-sm transition-all duration-150 cursor-pointer"
        >
          <Download className="w-3.5 h-3.5 stroke-[2.5]" />
        </button>

        {/* Tooltip */}
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full right-0 z-50 mb-1.5 whitespace-nowrap rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-2.5 py-1.5 opacity-0 shadow-xl transition-opacity duration-100 group-hover/tt:opacity-100"
        >
          <span className="text-xs font-medium text-emerald-400">{t("updaterRestartNow")}</span>
        </span>
      </div>
    );
  }

  // 3. 获取更新信息失败 / 下载更新失败：黄色圆圈感叹号，hover 提示原因，点击重试
  if (status === "error_check" || status === "error_download") {
    const errorTooltip =
      status === "error_check"
        ? t("updaterCheckFailed")
        : t("updaterDownloadFailed");

    return (
      <div className="group/tt relative inline-flex items-center justify-center">
        <button
          type="button"
          onClick={() => void retry()}
          aria-label={errorTooltip}
          className="relative flex items-center justify-center w-6 h-6 rounded-full bg-amber-500/15 hover:bg-amber-500/25 text-amber-500 border border-amber-500/40 active:scale-95 transition-all duration-150 cursor-pointer"
        >
          <AlertCircle className="w-3.5 h-3.5 stroke-[2.3]" />
        </button>

        {/* Tooltip */}
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full right-0 z-50 mb-1.5 whitespace-nowrap rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-2.5 py-1.5 opacity-0 shadow-xl transition-opacity duration-100 group-hover/tt:opacity-100"
        >
          <span className="text-xs font-medium text-amber-400">{errorTooltip}</span>
        </span>
      </div>
    );
  }

  // 4. 默认常态：无新版本，显示普通版本号
  if (!versionText) return null;

  return (
    <span className="text-[13px] leading-none tabular-nums text-[var(--text-dim)] font-medium">
      v{versionText}
    </span>
  );
}
