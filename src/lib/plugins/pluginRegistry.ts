/**
 * pluginRegistry —— 插件注册表 TS 侧（P2-G2）。
 *
 * 数据源：Rust plugin_list / plugin_install_from_dir / plugin_uninstall
 * （`~/.ReinAgent/plugins/<name>/` + plugin.json 清单，见 src-tauri/src/plugins.rs）。
 * 启用态：kv `reinagent-plugins-enabled`（JSON {name: boolean}，缺省启用）。
 *
 * 贡献面挂接：
 * - hooks → hooksRuntime 发现时合并（安装 = 显式用户动作，视为已信任来源）；
 * - commands → LexicalComposer 扫描时把启用插件的 commands 目录传给
 *   commands_scan 的 extra_dirs（同 frontmatter 格式）。
 */

import { invoke } from "@tauri-apps/api/core";
import { kvGet, kvSet } from "../storage/db";

const ENABLED_KEY = "reinagent-plugins-enabled";

export interface InstalledPlugin {
  root: string;
  name: string;
  description: string;
  version: string;
  /** commands 目录绝对路径（manifest 声明且存在时） */
  commandsDir: string | null;
  /** hooks 条目（manifest 原样，结构同 HookConfigEntry） */
  hooks: Array<{
    event: string;
    matcher?: string;
    command: string;
    timeoutMs?: number;
  }> | null;
  manifestOk: boolean;
}

export function getPluginEnabledMap(): Record<string, boolean> {
  try {
    const raw = kvGet(ENABLED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, boolean>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function setPluginEnabled(name: string, enabled: boolean): void {
  const map = getPluginEnabledMap();
  map[name] = enabled;
  kvSet(ENABLED_KEY, JSON.stringify(map));
}

export function isPluginEnabled(name: string, map = getPluginEnabledMap()): boolean {
  return map[name] !== false; // 缺省启用
}

export async function listInstalledPlugins(): Promise<InstalledPlugin[]> {
  return invoke<InstalledPlugin[]>("plugin_list");
}

export async function installPluginFromDir(
  source: string,
  name?: string,
  overwrite?: boolean,
): Promise<InstalledPlugin> {
  return invoke<InstalledPlugin>("plugin_install_from_dir", {
    source,
    name: name ?? null,
    overwrite: overwrite ?? false,
  });
}

export async function uninstallPlugin(name: string): Promise<void> {
  await invoke("plugin_uninstall", { name });
}

/** 启用插件贡献的全部 hooks（未配置/禁用 → 空数组）。 */
export async function getEnabledPluginHooks(): Promise<
  Array<{ event: string; matcher?: string; command: string; timeoutMs?: number }>
> {
  try {
    const [plugins, enabledMap] = await Promise.all([listInstalledPlugins(), Promise.resolve(getPluginEnabledMap())]);
    return plugins
      .filter((p) => p.manifestOk && isPluginEnabled(p.name, enabledMap))
      .flatMap((p) => (Array.isArray(p.hooks) ? p.hooks : []));
  } catch (err) {
    console.warn("[plugins] hook collection failed:", err);
    return [];
  }
}

/** 启用插件贡献的命令目录（commands_scan extra_dirs 用）。 */
export async function getEnabledPluginCommandDirs(): Promise<string[]> {
  try {
    const [plugins, enabledMap] = await Promise.all([listInstalledPlugins(), Promise.resolve(getPluginEnabledMap())]);
    return plugins
      .filter((p) => p.manifestOk && isPluginEnabled(p.name, enabledMap) && p.commandsDir)
      .map((p) => p.commandsDir as string);
  } catch (err) {
    console.warn("[plugins] command dir collection failed:", err);
    return [];
  }
}
