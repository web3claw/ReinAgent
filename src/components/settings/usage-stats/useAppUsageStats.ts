/**
 * useAppUsageStats —— 用量快照数据 hook（P1-7）。
 *
 * ZCode 走 service→RPC 拉取；我们直接 invoke `usage_refresh`（先幂等回填再聚合）。
 * 保留 ZCode hook 的两个行为要点：请求版本号防竞态（旧响应不覆盖新响应）、
 * range 切换时保留上一份快照避免面板闪烁。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppUsageRange, AppUsageSnapshot } from "./types";

export function useAppUsageStats(range: AppUsageRange) {
  const [snapshot, setSnapshot] = useState<AppUsageSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersionRef = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++requestVersionRef.current;
    setLoading(true);
    setError(null);
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const tzOffsetMs = -new Date().getTimezoneOffset() * 60_000;
      const data = await invoke<AppUsageSnapshot>("usage_snapshot", { range, timeZone, tzOffsetMs });
      if (version === requestVersionRef.current) {
        setSnapshot(data);
      }
    } catch (err) {
      if (version === requestVersionRef.current) {
        setError(String(err));
      }
    } finally {
      if (version === requestVersionRef.current) {
        setLoading(false);
      }
    }
  }, [range]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { snapshot, loading, error, refresh };
}
