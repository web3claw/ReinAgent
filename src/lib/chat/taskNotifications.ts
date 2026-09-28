/**
 * taskNotifications.ts —— 后台任务完成系统通知 + 提示音（对齐 ZCode
 * taskNotificationOrchestrator 的最小可用版）。
 *
 * 触发条件（避免打扰）：
 * - 任务跑到**终态**（done/error/stopped）且**不是当前正在看的任务**（或窗口不可见）；
 * - 同一任务同一轮只通知一次（runId 去重）。
 *
 * 提示音：WebAudio 合成短 beep（无音频资源依赖）；开关持久化 kv。
 */

import { kvGet, kvSet } from "../storage/db";

const SOUND_ENABLED_KEY = "reinagent-notification-sound";

export function isNotificationSoundEnabled(): boolean {
  return kvGet(SOUND_ENABLED_KEY) !== "false"; // 缺省开启
}

export function setNotificationSoundEnabled(enabled: boolean): void {
  kvSet(SOUND_ENABLED_KEY, enabled ? "true" : "false");
}

/** WebAudio 合成双音提示（约 0.25s；失败静默——音频不可用不应打断主流程）。 */
export function playNotificationSound(): void {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const gain = ctx.createGain();
    gain.gain.value = 0.06;
    gain.connect(ctx.destination);
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.connect(gain);
    // 两段音：880Hz → 1320Hz（上行双音，听感「完成」）
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1320, ctx.currentTime + 0.12);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
    osc.onended = () => void ctx.close();
  } catch {
    // 无声环境/自动播放策略：忽略
  }
}

/** 发系统通知（Tauri notification 插件；Web 模式不可达时静默跳过）。 */
export async function sendSystemNotification(title: string, body: string): Promise<void> {
  try {
    const mod = await import("@tauri-apps/plugin-notification");
    let granted = await mod.isPermissionGranted();
    if (!granted) {
      granted = (await mod.requestPermission()) === "granted";
    }
    if (granted) {
      await mod.sendNotification({ title, body });
    }
  } catch (err) {
    console.warn("[notify] system notification unavailable:", err);
  }
}

/** 终态摘要（通知正文）：取最后一条 assistant 文本，截 120 字。 */
export function summarizeOutcome(
  outcome: "done" | "error" | "stopped",
  lastAssistantText: string | undefined,
  error: string | undefined,
): string {
  if (outcome === "error") return (error ?? "任务执行失败").slice(0, 120);
  if (outcome === "stopped") return "任务已停止";
  const text = (lastAssistantText ?? "").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text.slice(0, 120) : "任务已完成";
}
