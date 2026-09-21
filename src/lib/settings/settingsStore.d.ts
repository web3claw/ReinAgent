import type { ProviderType } from "../providers/catalog";

export interface PersistedSettings {
  provider: ProviderType;
  apiKey: string;
  modelId: string;
  baseUrl: string;
}

export function normalizeSettings(raw: unknown, defaults: PersistedSettings): PersistedSettings;

export interface SettingsStoreOptions {
  read: () => Promise<unknown>;
  write: (value: PersistedSettings) => Promise<unknown>;
  defaults: PersistedSettings;
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
