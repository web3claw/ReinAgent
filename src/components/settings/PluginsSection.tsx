/**
 * PluginsSection —— 插件管理（P2-G2 插件系统 v2）。
 *
 * 安装源：本地目录（fs_pick_folder → plugin_install_from_dir 整拷）或
 * Git 仓库（github owner/repo 短形式或完整 URL → plugin_install_from_git 浅克隆）。
 * 列表（名称/描述/版本/贡献计数）+ 启用开关 + 卸载 + userConfig 值编辑
 * （存 kv，hook stdin payload.pluginOptions / 技能发现消费）。
 */

import { useCallback, useEffect, useState } from "react";
import { Download, Loader2, PackageOpen, Trash2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "../../i18n";
import { invalidateSkillsDiscoveryCache } from "../../lib/skills/index";
import {
  getPluginEnabledMap,
  getPluginOptions,
  installPluginFromDir,
  installPluginFromGit,
  isPluginEnabled,
  listInstalledPlugins,
  setPluginEnabled,
  setPluginOption,
  uninstallPlugin,
  type InstalledPlugin,
} from "../../lib/plugins/pluginRegistry";

export function PluginsSection() {
  const { t } = useTranslation();
  const [plugins, setPlugins] = useState<InstalledPlugin[] | null>(null);
  const [enabledMap, setEnabledMap] = useState<Record<string, boolean>>({});
  const [installing, setInstalling] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [gitUrl, setGitUrl] = useState("");
  /** 每插件的 userConfig 草稿（name → {key: value 字符串态}） */
  const [optionDrafts, setOptionDrafts] = useState<Record<string, Record<string, string>>>({});

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

  const install = async (source: "dir" | "git") => {
    setInstalling(true);
    setFeedback(null);
    try {
      let installed: InstalledPlugin;
      if (source === "git") {
        if (!gitUrl.trim()) return;
        installed = await installPluginFromGit(gitUrl.trim(), undefined, true);
      } else {
        const dir = await invoke<string | null>("fs_pick_folder");
        if (!dir) return;
        installed = await installPluginFromDir(dir, undefined, true);
      }
      // 插件可能贡献技能：使技能发现缓存失效（下次进 Skills 页重新扫描）
      try {
        invalidateSkillsDiscoveryCache();
        invalidateSkillsDiscoveryCache();
      } catch {
        // 缓存失效失败无害：仅延迟到下次自然刷新
      }
      setGitUrl("");
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
      <p className="text-xs text-[var(--text-dim)]">{t("pluginsHint")}</p>

      {/* 安装源：本地目录 / Git 仓库 */}
      <div className="space-y-2 rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void install("dir")}
            disabled={installing}
            className="flex items-center gap-1.5 rounded-lg bg-[var(--brand)] px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PackageOpen className="h-3.5 w-3.5" />}
            {t("pluginsInstallFromDir")}
          </button>
          <span className="text-xs text-[var(--text-dim)]">{t("pluginsOrGit")}</span>
          <input
            type="text"
            value={gitUrl}
            onChange={(e) => setGitUrl(e.target.value)}
            placeholder={t("pluginsGitPlaceholder")}
            className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-transparent px-2.5 py-1.5 text-xs text-[var(--text)] placeholder-[var(--text-dim)] focus:border-[var(--brand)] focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void install("git")}
            disabled={installing || !gitUrl.trim()}
            aria-label={t("pluginsInstallFromGit")}
            title={t("pluginsInstallFromGit")}
            className="flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-[var(--brand)] px-3 py-1.5 text-xs font-medium text-[var(--brand)] transition-opacity hover:opacity-85 disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" />
            {t("pluginsInstallFromGit")}
          </button>
        </div>
      </div>

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
            const userConfigDecls = plugin.userConfig && typeof plugin.userConfig === "object" ? plugin.userConfig : null;
            const configKeys = userConfigDecls ? Object.keys(userConfigDecls) : [];
            const draft = (optionDrafts[plugin.name] ?? {}) as Record<string, string>;
            const optValue = (key: string): string => {
              const declared = userConfigDecls ? userConfigDecls[key] : undefined;
              const saved: Record<string, string | number | boolean> = getPluginOptions(
                plugin.name,
                userConfigDecls,
              );
              const savedValue = saved[key];
              const savedText = savedValue !== undefined ? String(savedValue) : "";
              const defaultText = declared && declared.default !== undefined ? String(declared.default) : "";
              const draftValue = draft[key] ?? "";
              const v = draftValue || savedText || defaultText;
              return v;
            };
            const setOpt = (key: string, value: string) => {
              setOptionDrafts((cur) => ({ ...cur, [plugin.name]: { ...(cur[plugin.name] ?? {}), [key]: value } }));
            };
            const saveOptions = () => {
              for (const key of configKeys) setPluginOption(plugin.name, key, optValue(key));
              setFeedback(t("pluginsOptionsSaved").replace("{name}", plugin.name));
            };
            const skillNote = plugin.skillsDir ? ` · ${t("pluginsHasSkills")}` : "";
            return (
              <div
                key={plugin.root}
                className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-3"
              >
                <div className="flex items-center gap-3">
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
                    {skillNote}
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
                {configKeys.length > 0 && plugin.manifestOk ? (
                  <div className="mt-2 space-y-1.5 rounded-lg border border-[var(--border)] p-2.5">
                    <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-dim)]">
                      {t("pluginsUserConfig")}
                    </div>
                    {configKeys.map((key) => {
                      const decl = userConfigDecls?.[key];
                      return (
                        <div key={key} className="flex items-center gap-2">
                          <span className="w-32 shrink-0 truncate text-xs text-[var(--text-dim)]">
                            {decl?.title || key}
                          </span>
                          <input
                            type="text"
                            value={optValue(key)}
                            onChange={(e) => setOpt(key, e.target.value)}
                            className="min-w-0 flex-1 rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--text)] focus:outline-none"
                          />
                        </div>
                      );
                    })}
                    <button
                      type="button"
                      onClick={saveOptions}
                      className="rounded border border-[var(--brand)] px-2 py-0.5 text-[10px] font-medium text-[var(--brand)]"
                    >
                      {t("pluginsOptionsSave")}
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
