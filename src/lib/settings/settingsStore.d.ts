/**
 * settingsStore 的类型声明（实现见同目录 `settingsStore.js`）。
 *
 * 与 conversationModel 采用同样的「.js 实现 + .d.ts 声明」策略，
 * 使其能被 `node --test` 直接跑而不必预编译。
 */

export interface PersistedSettings {
  apiKey: string;
  modelId: string;
  baseUrl: string;
}

export function normalizeSettings(raw: unknown, defaults: PersistedSettings): PersistedSettings;

export interface SettingsStoreOptions {
  /** 读后端；可能抛错（后端不可用）。 */
  read: () => Promise<unknown>;
  /** 写后端；可能抛错。 */
  write: (value: PersistedSettings) => Promise<unknown>;
  defaults: PersistedSettings;
  /** 降级/失败时的告警回调（默认写 console.warn）。 */
  warn?: (message: string) => void;
}

export interface SettingsStore {
  readonly degraded: boolean;
  readonly warning: string | null;
  readonly backendKind: "persistent" | "memory";
  load: () => Promise<PersistedSettings>;
  save: (patch: Partial<PersistedSettings>) => Promise<boolean>;
  snapshot: () => PersistedSettings;
}

export function createSettingsStore(options: SettingsStoreOptions): SettingsStore;
