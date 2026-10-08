/**
 * AppUpdaterCard —— 应用更新（P2-G2；2026-10-08 改为 magpie 式自更新）。
 *
 * 更新源为自建 `latest.json`（Release asset，格式 {version, notes, pubDate, assets}）；
 * 检查/安装走 Rust `update_check` / `update_install`（self_update.rs：下载裸二进制 /
 * .app zip → SHA-256 校验 → 原地替换 → 重启）。所有失败如实显示（未配置更新源 /
 * URL 无效 / 网络与校验错误），绝不伪装成功。
 *
 * 半自动：启动静默检查，有新版提示但**不自动下载**，用户点「立即更新」才执行。
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { RefreshCw, Download } from "lucide-react";
import { useTranslation } from "../../i18n";

/** 默认更新源：本仓库 GitHub Releases 的 latest.json（CI 发布时生成）。 */
export const DEFAULT_UPDATE_ENDPOINT =
  "https://github.com/web3claw/ReinAgent/releases/latest/download/latest.json";

export function defaultUpdateEndpoint(): string {
  return DEFAULT_UPDATE_ENDPOINT;
}

interface CheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  availableVersion?: string;
  notes?: string;
  pubDate?: string;
}

interface UpdateProgressPayload {
  percent: number;
  downloaded: number;
  total: number;
}

/** 圆圈进度条组件（中间显示百分比数值） */
function CircularProgress({
  percent,
  size = 22,
  strokeWidth = 2.5,
}: {
  percent: number;
  size?: number;
  strokeWidth?: number;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (circumference * clamped) / 100;

  return (
    <div
      className="relative inline-flex items-center justify-center shrink-0 select-none"
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
          opacity={0.3}
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
      {/* 中间显示百分比 */}
      <span
        className="absolute inset-0 flex items-center justify-center font-bold leading-none tracking-tighter"
        style={{
          fontSize: size >= 24 ? "8px" : "7px",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {clamped}%
      </span>
    </div>
  );
}

export function AppUpdaterCard({ appVersion }: { appVersion?: string }) {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<UpdateProgressPayload | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 监听后端推送的下载进度事件
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<UpdateProgressPayload>("update-progress", (event) => {
      setProgress(event.payload);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const install = async () => {
    setInstalling(true);
    setProgress({ percent: 0, downloaded: 0, total: 0 });
    setError(null);
    try {
      await invoke("update_install", {
        args: { feed: DEFAULT_UPDATE_ENDPOINT },
      });
      // 成功即重启（不返回）
    } catch (err) {
      setError(String(err));
      setInstalling(false);
      setProgress(null);
    }
  };

  const check = async () => {
    setChecking(true);
    setError(null);
    setResult(null);
    try {
      const r = await invoke<CheckResult>("update_check", {
        args: { feed: DEFAULT_UPDATE_ENDPOINT },
      });
      setResult(r);
    } catch (err) {
      setError(String(err));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="p-6 bg-[var(--bg-elev)] rounded-xl border border-[var(--border)] space-y-4">
      {/* 头部：应用信息 + 右上角检查更新按钮 */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <div className="w-12 h-12 bg-[var(--brand)] rounded-xl flex items-center justify-center text-white font-bold text-xl shrink-0">
            R
          </div>
          <div className="min-w-0">
            <h3 className="text-lg font-semibold truncate">ReinAgent</h3>
            <p className="text-sm text-[var(--text-dim)] truncate">Version {appVersion || "—"}</p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => void check()}
          disabled={checking || installing}
          className="flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-[var(--brand)] px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {checking ? (
            <>
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              <span>{t("updaterCheck")}</span>
            </>
          ) : (
            <>
              <RefreshCw className="h-3.5 w-3.5" />
              <span>{t("updaterCheck")}</span>
            </>
          )}
        </button>
      </div>

      {/* 描述信息 */}
      <div className="pt-4 border-t border-[var(--border)] text-sm text-[var(--text-dim)] space-y-2">
        <p>A desktop AI coding assistant built with Tauri v2.</p>
        <p>MIT License</p>
        <p>Tech Stack: React 19, TypeScript, Vite, Tailwind CSS v4, Zustand</p>
      </div>

      {/* 状态与更新结果反馈 */}
      {error ? (
        <p className="rounded-lg border border-[var(--danger)] bg-[var(--bg-elev)] p-2 text-xs text-[var(--danger)] break-all">
          {error}
        </p>
      ) : null}

      {result ? (
        result.hasUpdate ? (
          <div className="space-y-2 rounded-lg border border-[var(--status-ok)]/40 bg-[var(--status-ok)]/10 p-3 text-xs">
            <p className="text-[var(--text)] font-medium">
              {t("updaterAvailable").replace("{version}", result.availableVersion ?? "?")}{" "}
              ({t("updaterCurrent").replace("{version}", result.currentVersion)})
            </p>
            {result.notes ? (
              <p className="whitespace-pre-wrap text-[var(--text-dim)]">{result.notes}</p>
            ) : null}
            <button
              type="button"
              onClick={() => void install()}
              disabled={installing}
              className="flex items-center gap-2 rounded-lg bg-[var(--brand)] px-3 py-1.5 font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {installing ? (
                <>
                  <CircularProgress percent={progress?.percent ?? 0} size={20} strokeWidth={2.5} />
                  <span>{t("updaterDownloading")}</span>
                </>
              ) : (
                <>
                  <Download className="h-3.5 w-3.5" />
                  <span>{t("updaterInstall")}</span>
                </>
              )}
            </button>
          </div>
        ) : (
          <p className="text-xs text-[var(--text-dim)]">
            {t("updaterUpToDate").replace("{version}", result.currentVersion)}
          </p>
        )
      ) : null}
    </div>
  );
}
