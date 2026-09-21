/**
 * useSettings —— 设置加载/保存的 React 胶水层。
 *
 * 职责：
 *   - 挂载时构造环境存储（plugin-store 或降级内存）并 load；
 *   - `update(patch)` 更新内存态并自动写回；
 *   - 暴露 `status`（是否就绪、是否持久化、降级警示文案）供 UI 醒目提示。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createEnvSettingsStore, DEFAULT_SETTINGS } from "./store";
import type { Settings } from "./store";
import type { SettingsStore } from "./settingsStore";

export interface SettingsStatus {
  /** 是否已完成首次加载。 */
  ready: boolean;
  /** 持久化是否真的可用（false → 仅内存，重启会丢）。 */
  persistent: boolean;
  /** 降级/失败的警示文案（null 表示正常）。 */
  warning: string | null;
}

export interface UseSettingsResult {
  settings: Settings;
  status: SettingsStatus;
  update: (patch: Partial<Settings>) => void;
}

export function useSettings(): UseSettingsResult {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<SettingsStatus>({ ready: false, persistent: true, warning: null });

  const storeRef = useRef<SettingsStore | null>(null);
  // 首次从磁盘加载完成后会触发一次 settings 变化；跳过这次回写，避免无谓写入。
  const skipNextSave = useRef(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const store = await createEnvSettingsStore();
      if (cancelled) return;
      storeRef.current = store;
      const loaded = await store.load();
      if (cancelled) return;
      skipNextSave.current = true;
      setSettings({ ...DEFAULT_SETTINGS, ...loaded });
      setStatus({ ready: true, persistent: !store.degraded, warning: store.warning });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  // settings 变化后自动写回；写失败会把 status 刷新为「仅内存 + 警示」。
  useEffect(() => {
    const store = storeRef.current;
    if (store === null || !status.ready) return;
    if (skipNextSave.current) {
      skipNextSave.current = false;
      return;
    }
    void store.save(settings).then(() => {
      setStatus((prev) => ({ ...prev, persistent: !store.degraded, warning: store.warning }));
    });
  }, [settings, status.ready]);

  return { settings, status, update };
}
