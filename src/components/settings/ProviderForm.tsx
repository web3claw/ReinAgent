import { PROVIDERS, getProviderMeta, type ProviderType } from "../../lib/providers/catalog";
import { validateProviderConfig } from "../../lib/providers/modelFactory";
import type { Settings } from "../../lib/settings/store";
import type { SettingsStatus } from "../../lib/settings/useSettings";
import { useTranslation } from "../../i18n";
import { AlertTriangle, CheckCircle2, Server, Key, Cpu, Globe, ChevronDown } from "lucide-react";

export function ProviderForm({
  settings,
  status,
  onChange,
}: {
  settings: Settings;
  status: SettingsStatus;
  onChange: (patch: Partial<Settings>) => void;
}) {
  const { t } = useTranslation();
  const currentProviderMeta = getProviderMeta(settings.provider || "deepseek");
  const baseUrlError = validateProviderConfig({ baseUrl: settings.baseUrl });

  const handleProviderChange = (newProvider: ProviderType) => {
    const meta = getProviderMeta(newProvider);
    onChange({
      provider: newProvider,
      modelId: meta.defaultModelId,
      baseUrl: "", // reset to default for that provider
    });
  };

  return (
    <section className="settings-panel border-b border-[var(--border)] bg-[var(--bg-secondary)] p-4 sm:p-6 transition-colors">
      <div className="flex items-center justify-between pb-4 mb-4 border-b border-[var(--border)]">
        <div className="flex items-center gap-2">
          <Server className="w-5 h-5 text-[var(--accent)]" />
          <h2 className="text-base font-semibold text-[var(--text-primary)]">{t("settings")}</h2>
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          {status.persistent ? (
            <span className="flex items-center gap-1 text-emerald-500 font-medium">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>{t("saved")}</span>
            </span>
          ) : (
            <span className="flex items-center gap-1 text-amber-500 font-medium">
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>Memory Mode</span>
            </span>
          )}
        </div>
      </div>

      {status.warning ? (
        <div className="flex items-start gap-2 p-3 mb-4 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-500">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{status.warning}</span>
        </div>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Provider */}
        <label className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
            <Server className="w-3.5 h-3.5" />
            <span>{t("provider")}</span>
          </span>
          <div className="relative w-full">
            <select
              className="w-full appearance-none pl-3 pr-9 py-2 text-sm rounded-lg border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] cursor-pointer"
              value={settings.provider || "deepseek"}
              onChange={(e) => handleProviderChange(e.target.value as ProviderType)}
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id} className="bg-[var(--bg-card)] text-[var(--text-primary)]">
                  {p.name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-secondary)] opacity-70" />
          </div>
        </label>

        {/* Model */}
        <label className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
            <Cpu className="w-3.5 h-3.5" />
            <span>{t("model")}</span>
          </span>
          <div className="relative w-full">
            <select
              className="w-full appearance-none pl-3 pr-9 py-2 text-sm rounded-lg border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] cursor-pointer"
              value={settings.modelId}
              onChange={(e) => onChange({ modelId: e.target.value })}
            >
              {currentProviderMeta.models.map((m) => (
                <option key={m.id} value={m.id} className="bg-[var(--bg-card)] text-[var(--text-primary)]">
                  {m.name} ({m.id})
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-secondary)] opacity-70" />
          </div>
        </label>

        {/* API Key */}
        <label className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
            <Key className="w-3.5 h-3.5" />
            <span>{t("apiKey")}</span>
          </span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={settings.provider === "ollama" ? "Ollama does not require an API Key" : t("apiKeyPlaceholder")}
            value={settings.apiKey}
            onChange={(e) => onChange({ apiKey: e.target.value })}
            className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)] placeholder-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent)] font-mono"
          />
        </label>

        {/* Base URL */}
        <label className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
            <Globe className="w-3.5 h-3.5" />
            <span>{t("baseUrl")}</span>
          </span>
          <input
            type="url"
            spellCheck={false}
            placeholder={`Default: ${currentProviderMeta.defaultBaseUrl}`}
            value={settings.baseUrl}
            onChange={(e) => onChange({ baseUrl: e.target.value })}
            className={`w-full px-3 py-2 text-sm rounded-lg border bg-[var(--bg-card)] text-[var(--text-primary)] placeholder-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent)] font-mono ${
              baseUrlError ? "border-red-500" : "border-[var(--border)]"
            }`}
          />
          {baseUrlError ? <span className="text-xs text-red-500 mt-0.5">{baseUrlError}</span> : null}
        </label>
      </div>
    </section>
  );
}
