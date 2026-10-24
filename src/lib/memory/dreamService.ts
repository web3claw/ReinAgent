/**
 * Dream 数值巩固服务（记忆升级包，ROADMAP ③）：
 * 24h 周期 + 启动补跑（距上次 dream >24h）；纯数值算法零 token。
 * 单飞防重入；自动运行仅在该开关开启（settings.memory.dreamEnabled）时执行；
 * **首次自动运行前会先做一次 dry-run 并 console.info 报告计划**（不落库），
 * 真正的应用由用户在记忆设置里手动触发——避免升级后第一次就动真实记忆。
 *
 * 复用 createMemoryOrganizerService 的挂载模式（App.tsx 单例 + 卸载 dispose）。
 */

import { memoryOrganizeRunList, memoryDreamRunApi } from "./api";
import { useHubSettings } from "../../store/hubSettingsStore";
import type { MemoryDreamReport } from "./dreamTypes";

const DREAM_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function dreamLastRunAt(): Promise<number | null> {
  try {
    const response = await memoryOrganizeRunList({ limit: 50 });
    const runs = response.runs ?? [];
    const last = (runs ?? [])
      .filter((r) => r.mode === "dream" && (r.status === "succeeded" || r.status === "skipped"))
      .map((r) => r.finishedAt ?? 0)
      .reduce((acc, cur) => Math.max(acc, cur), 0);
    return last > 0 ? last : null;
  } catch (err) {
    console.warn("[memory] dream 上次运行时间读取失败:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function dreamRun(dryRun: boolean): Promise<MemoryDreamReport> {
  return memoryDreamRunApi({ dryRun, trigger: "scheduled" });
}

export function createDreamService() {
  let disposed = false;
  let inFlight = false;

  async function tick(): Promise<void> {
    if (disposed || inFlight) return;
    const settings = useHubSettings.getState().settings.memory;
    if (!settings.dreamEnabled) return;
    const last = await dreamLastRunAt();
    if (last !== null && Date.now() - last < DREAM_INTERVAL_MS) return;
    inFlight = true;
    try {
      // 升级后的首次自动运行只出计划（dry-run，不落库）；应用由用户手动确认。
      const everRan = last !== null;
      const report = await dreamRun(!everRan);
      if (report.merged + report.decayed + report.forgotten > 0) {
        console.info(
          `[memory] dream ${report.dryRun ? "预览（未落库，请在设置中应用）" : "完成"}: merged=${report.merged} decayed=${report.decayed} forgotten=${report.forgotten}`,
        );
      }
    } catch (err) {
      console.warn("[memory] dream 运行失败:", err instanceof Error ? err.message : err);
    } finally {
      inFlight = false;
    }
  }

  const interval = setInterval(() => void tick(), 60 * 60 * 1000); // 每小时探测，间隔判定 24h

  return {
    poke: () => void tick(),
    dispose: () => {
      disposed = true;
      clearInterval(interval);
    },
  };
}
