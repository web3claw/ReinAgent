/**
 * store —— 设置存储的**环境适配层**（Tauri plugin-store ↔ 内存降级）。
 *
 * 纯逻辑在 `settingsStore.js`（可无头测试）；这里只负责：
 *   1. 尝试加载 `@tauri-apps/plugin-store`，注入真实读写后端；
 *   2. 若插件不可用（纯浏览器 `bun run dev`、或 capability 权限未配置），
 *      注入一个「读写必失败」的后端，让 settingsStore 走**降级为内存 + 警示**的路径。
 *
 * 依赖注入原则：组件不直接 `load()`，而是经 useSettings → createEnvSettingsStore，
 * 因此可以在测试里替换为内存实现。
 */

import { DEFAULT_MODEL_ID } from "../providers/catalog";
import { createSettingsStore } from "./settingsStore";
import type { SettingsStore } from "./settingsStore";

/** 应用设置（持久化到 Tauri 的 settings.json）。 */
export interface Settings {
  apiKey: string;
  modelId: string;
  baseUrl: string;
}

/** 默认设置：无 Key（→ 演示模式）、默认模型、baseUrl 留空（取 catalog 权威值）。 */
export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  modelId: DEFAULT_MODEL_ID,
  baseUrl: "",
};

/** 持久化文件与键名。 */
const SETTINGS_FILE = "settings.json";
const SETTINGS_KEY = "settings";

/**
 * 构造环境设置存储：优先 Tauri plugin-store，不可用则降级为内存（带警示）。
 */
export async function createEnvSettingsStore(): Promise<SettingsStore> {
  const defaults = DEFAULT_SETTINGS;
  const warn = (message: string) => {
    console.warn("[settings]", message);
  };

  try {
    const mod = await import("@tauri-apps/plugin-store");
    const store = await mod.load(SETTINGS_FILE, { autoSave: true });
    return createSettingsStore({
      read: () => store.get(SETTINGS_KEY),
      write: (value) => store.set(SETTINGS_KEY, value),
      defaults,
      warn,
    });
  } catch (err) {
    // 非 Tauri 环境，或权限未配置导致插件调用失败：
    // 注入必失败后端 → settingsStore 首次 load() 即降级为内存并给出警示。
    const reason = err instanceof Error ? err.message : String(err);
    return createSettingsStore({
      read: async () => {
        throw new Error(reason);
      },
      write: async () => {
        throw new Error(reason);
      },
      defaults,
      warn,
    });
  }
}
