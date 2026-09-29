/**
 * AppUpdaterCard —— 应用更新（P2-G2）。
 *
 * 更新源 URL 存 kv（`reinagent-update-endpoint`，静态 latest JSON）；
 * 检查/安装走 Rust update_check / update_install。所有失败如实显示
 * （未配置更新源 / URL 无效 / 网络与签名错误），绝不伪装成功。
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, Download } from "lucide-react";
import { useTranslation } from "../../i18n";
import { kvGet, kvSet } from "../../lib/storage/db";

const ENDPOINT_KEY = "reinagent-update-endpoint";

interface CheckResult {
  configured: boolean;
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

  useEffect(() => {
    setEndpoint(kvGet(ENDPOINT_KEY) ?? "");
  }, []);

  const check = async () => {
    setChecking(true);
    setError(null);
    setResult(null);
    try {
      kvSet(ENDPOINT_KEY, endpoint.trim());
      const r = await invoke<CheckResult>("update_check", {
        args: { endpoint: endpoint.trim() || null },
      });
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
      await invoke("update_install", { args: { endpoint: endpoint.trim() || null } });
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
        result.configured ? (
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
        ) : (
          <p className="text-xs text-[var(--text-dim)]">{t("updaterNoEndpoint")}</p>
        )
      ) : null}
    </div>
  );
}
