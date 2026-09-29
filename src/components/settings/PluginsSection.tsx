/**
 * PluginsSection —— 插件管理（P2-G2 插件系统）。
 *
 * 列表（名称/描述/版本/贡献计数）+ 启用开关 + 卸载 + 从本地目录安装
 * （fs_pick_folder 选目录 → plugin_install_from_dir 整拷到 ~/.ReinAgent/plugins/）。
 * 贡献挂接：hooks → hooksRuntime；commands → commands_scan extra_dirs。
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, PackageOpen, Trash2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "../../i18n";
import {
  getPluginEnabledMap,
  installPluginFromDir,
  isPluginEnabled,
  listInstalledPlugins,
  setPluginEnabled,
  uninstallPlugin,
  type InstalledPlugin,
} from "../../lib/plugins/pluginRegistry";

export function PluginsSection() {
  const { t } = useTranslation();
  const [plugins, setPlugins] = useState<InstalledPlugin[] | null>(null);
  const [enabledMap, setEnabledMap] = useState<Record<string, boolean>>({});
  const [installing, setInstalling] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [list, map] = await Promise.all([listInstalledPlugins(), Promise.resolve(getPluginEnabledMap())]);
      setPlugins(list);
      setEnabledMap(map);
    } catch (err) {
      setPlugins([]);
      setFeedback(String(err).slice(0, 200));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = (name: string) => {
    const next = !isPluginEnabled(name, enabledMap);
    setPluginEnabled(name, next);
    setEnabledMap((cur) => ({ ...cur, [name]: next }));
  };

  const install = async () => {
    setInstalling(true);
    setFeedback(null);
    try {
      const dir = await invoke<string | null>("fs_pick_folder");
      if (!dir) return;
      const installed = await installPluginFromDir(dir, undefined, true);
      setFeedback(t("pluginsInstalled").replace("{name}", installed.name));
      await refresh();
    } catch (err) {
      setFeedback(String(err).slice(0, 220));
    } finally {
      setInstalling(false);
    }
  };

  const uninstall = async (name: string) => {
    try {
      await uninstallPlugin(name);
      await refresh();
    } catch (err) {
      setFeedback(String(err).slice(0, 220));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">{t("pluginsTitle")}</h2>
        <button
          type="button"
          onClick={() => void install()}
          disabled={installing}
          className="flex items-center gap-1.5 rounded-lg bg-[var(--brand)] px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PackageOpen className="h-3.5 w-3.5" />}
          {t("pluginsInstallFromDir")}
        </button>
      </div>
      <p className="text-xs text-[var(--text-dim)]">{t("pluginsHint")}</p>

      {feedback ? (
        <p className="rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] p-2 text-xs text-[var(--text-dim)] break-all">
          {feedback}
        </p>
      ) : null}

      {plugins === null ? (
        <div className="flex items-center gap-2 text-xs text-[var(--text-dim)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("pluginsLoading")}
        </div>
      ) : plugins.length === 0 ? (
        <p className="text-xs text-[var(--text-dim)]">{t("pluginsEmpty")}</p>
      ) : (
        <div className="space-y-2">
          {plugins.map((plugin) => {
            const enabled = isPluginEnabled(plugin.name, enabledMap);
            const hooksCount = Array.isArray(plugin.hooks) ? plugin.hooks.length : 0;
            return (
              <div
                key={plugin.root}
                className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-[var(--text)]">{plugin.name}</span>
                    {plugin.version ? (
                      <span className="text-[10px] text-[var(--text-dim)]">v{plugin.version}</span>
                    ) : null}
                    {!plugin.manifestOk ? (
                      <span className="rounded border border-[var(--danger)] px-1.5 py-0.5 text-[10px] text-[var(--danger)]">
                        {t("pluginsInvalidManifest")}
                      </span>
                    ) : null}
                  </div>
                  {plugin.description ? (
                    <p className="mt-0.5 truncate text-xs text-[var(--text-dim)]">{plugin.description}</p>
                  ) : null}
                  <p className="mt-0.5 text-[10px] text-[var(--text-dim)]">
                    {hooksCount > 0
                      ? t("pluginsHooksCount").replace("{count}", String(hooksCount))
                      : t("pluginsNoHooks")}
                    {plugin.commandsDir
                      ? ` · ${t("pluginsHasCommands")}`
                      : ""}
                  </p>
                </div>
                {plugin.manifestOk ? (
                  <>
                    <button
                      type="button"
                      onClick={() => toggle(plugin.name)}
                      aria-label={enabled ? t("pluginsDisable") : t("pluginsEnable")}
                      className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                        enabled
                          ? "border-[var(--status-ok)]/50 text-[var(--status-ok)]"
                          : "border-[var(--border)] text-[var(--text-dim)]"
                      }`}
                    >
                      {enabled ? t("pluginsEnabled") : t("pluginsDisabled")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void uninstall(plugin.name)}
                      aria-label={t("pluginsUninstall")}
                      className="flex-shrink-0 rounded p-1.5 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--danger)]"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
