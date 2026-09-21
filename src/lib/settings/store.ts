import { DEFAULT_PROVIDER, DEFAULT_MODEL_ID, type ProviderType } from "../providers/catalog";
import { createSettingsStore } from "./settingsStore";
import type { SettingsStore } from "./settingsStore";

/** 应用设置（持久化到 Tauri 的 settings.json）。 */
export interface Settings {
  provider: ProviderType;
  apiKey: string;
  modelId: string;
  baseUrl: string;
}

/** 默认设置：默认 Provider、无 Key（→ 演示模式）、默认模型、baseUrl 留空。 */
export const DEFAULT_SETTINGS: Settings = {
  provider: DEFAULT_PROVIDER,
  apiKey: "",
  modelId: DEFAULT_MODEL_ID,
  baseUrl: "",
};

const SETTINGS_FILE = "settings.json";
const SETTINGS_KEY = "settings";

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
