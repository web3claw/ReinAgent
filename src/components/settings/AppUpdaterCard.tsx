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

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, Download } from "lucide-react";
import { useTranslation } from "../../i18n";
import { kvGet, kvSet } from "../../lib/storage/db";
import { toast } from "../lw/ui/toast";

const ENDPOINT_KEY = "reinagent-update-endpoint";
/** 默认更新源：本仓库 GitHub Releases 的 latest.json（CI 发布时生成）。 */
export const DEFAULT_UPDATE_ENDPOINT =
  "https://github.com/web3claw/ReinAgent/releases/latest/download/latest.json";

export function defaultUpdateEndpoint(): string {
  return kvGet(ENDPOINT_KEY)?.trim() || DEFAULT_UPDATE_ENDPOINT;
}

interface CheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  availableVersion?: string;
  notes?: string;
  pubDate?: string;
}

export function AppUpdaterCard() {
  const { t } = useTranslation();
  const [endpoint, setEndpoint] = useState("");
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 启动自动检查只跑一次（严格模式双挂载也只发一次请求）。
  const autoCheckedRef = useRef(false);

  useEffect(() => {
    setEndpoint(kvGet(ENDPOINT_KEY) ?? "");
  }, []);

  // 启动自动检查（半自动）：只提示，不自动下载。静默失败——未发布 Release 时
  // 拉取 404 属预期，不该在启动时报错打扰；设置页手动检查仍如实显示错误。
  useEffect(() => {
    if (autoCheckedRef.current) return;
    autoCheckedRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const r = await invoke<CheckResult>("update_check", {
          args: { feed: defaultUpdateEndpoint() },
        });
        if (cancelled || !r.hasUpdate) return;
        toast.success(
          t("updaterAvailable").replace("{version}", r.availableVersion ?? "?"),
          {
            id: "reinagent-update-available",
            duration: 0,
            action: {
              label: t("updaterInstall"),
              onClick: () => {
                void invoke("update_install", { args: { feed: defaultUpdateEndpoint() } });
              },
            },
          },
        );
      } catch {
        // 启动检查失败静默（未配置/无网络/无 Release 均属预期）
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  const check = async () => {
    setChecking(true);
    setError(null);
    setResult(null);
    try {
      // 留空则回退默认源（调用 Rust 前先解析好，避免传 null）。
      const target = endpoint.trim() || DEFAULT_UPDATE_ENDPOINT;
      kvSet(ENDPOINT_KEY, endpoint.trim());
      const r = await invoke<CheckResult>("update_check", { args: { feed: target } });
      setResult(r);
    } catch (err) {
      setError(String(err));
    } finally {
      setChecking(false);
    }
  };

  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      await invoke("update_install", {
        args: { feed: endpoint.trim() || DEFAULT_UPDATE_ENDPOINT },
      });
      // 成功即重启（不返回）
    } catch (err) {
      setError(String(err));
      setInstalling(false);
    }
  };

  return (
    <div className="p-6 bg-[var(--bg-elev)] rounded-xl border border-[var(--border)] space-y-3">
      <h3 className="text-sm font-semibold text-[var(--text)]">{t("updaterTitle")}</h3>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder={t("updaterEndpointPlaceholder")}
          className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-transparent px-3 py-1.5 text-xs text-[var(--text)] placeholder-[var(--text-dim)] focus:border-[var(--brand)] focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void check()}
          disabled={checking}
          className="flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-[var(--brand)] px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`} />
          {t("updaterCheck")}
        </button>
      </div>

      {error ? (
        <p className="rounded-lg border border-[var(--danger)] bg-[var(--bg-elev)] p-2 text-xs text-[var(--danger)] break-all">
          {error}
        </p>
      ) : null}

      {result ? (
        result.hasUpdate ? (
          <div className="space-y-2 rounded-lg border border-[var(--status-ok)]/40 bg-[var(--status-ok)]/10 p-3 text-xs">
            <p className="text-[var(--text)]">
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
              className="flex items-center gap-1.5 rounded-lg bg-[var(--brand)] px-3 py-1.5 font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <Download className={`h-3.5 w-3.5 ${installing ? "animate-bounce" : ""}`} />
              {t("updaterInstall")}
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
