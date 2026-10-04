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

import { invoke } from "@tauri-apps/api/core";
import { kvGet, kvSet } from "../storage/db";

const SOUND_ENABLED_KEY = "reinagent-notification-sound";

export function isNotificationSoundEnabled(): boolean {
  return kvGet(SOUND_ENABLED_KEY) !== "false"; // 缺省开启
}

export function setNotificationSoundEnabled(enabled: boolean): void {
  kvSet(SOUND_ENABLED_KEY, enabled ? "true" : "false");
}

/** 共享 AudioContext（首次创建后复用；suspended 起始态由 resume 兜底）。 */
let sharedAudioCtx: AudioContext | null = null;

function getSharedAudioCtx(): AudioContext | null {
  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedAudioCtx || sharedAudioCtx.state === "closed") {
    sharedAudioCtx = new Ctx();
  }
  return sharedAudioCtx;
}

/** 三音上行完成提示音（约 0.45s，gain 峰值 0.38——用户定档：比系统提示音略响，仍留爆音余量）。 */
export function playNotificationSound(): void {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    const play = () => {
      const t0 = ctx.currentTime;
      const gain = ctx.createGain();
      // 缓入缓出包络：避免起止爆音；峰值 0.38（用户定档）
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.38, t0 + 0.02);
      gain.gain.setValueAtTime(0.38, t0 + 0.28);
      gain.gain.linearRampToValueAtTime(0, t0 + 0.42);
      gain.connect(ctx.destination);
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.connect(gain);
      // A5 → C#6 → E6 上行三音（「完成」听感）
      osc.frequency.setValueAtTime(880, t0);
      osc.frequency.setValueAtTime(1108.73, t0 + 0.14);
      osc.frequency.setValueAtTime(1318.51, t0 + 0.28);
      osc.start();
      osc.stop(t0 + 0.45);
    };
    // Windows/Chromium 的 AudioContext 起始可能是 suspended（自动播放策略）：
    // 先 resume 再播；resume 期间无声直接播会静默失败。
    if (ctx.state === "suspended") {
      void ctx.resume().then(play).catch(() => {
        // resume 失败（无音频设备等）：静默
      });
    } else {
      play();
    }
  } catch {
    // 无声环境/自动播放策略：忽略
  }
}

/**
 * 发系统通知（Rust `notify_send` 直发，Windows Toast + Linux freedesktop）。
 *
 * 为什么不走 tauri-plugin-notification：其 Windows 实现仅在 exe 不位于
 * `target/debug|release`（安装版）时才设置 AppUserModelID——dev/本地构建的
 * Toast 无 AppId 会被系统静默丢弃（API 返回成功但通知中心无内容）。
 * `notify_send` 在 Windows 显式携带 AUMID `com.reinagent.app`，Linux 走
 * notify-rust（org.freedesktop.Notifications），dev 与安装版行为一致。
 * `taskId` 用于点击通知回跳（Rust 发 `notify-activate` 事件）。
 * 失败如实 console.warn（No-Fallback：不静默伪装成功）。
 */
export async function sendSystemNotification(
  title: string,
  body: string,
  taskId?: string,
): Promise<void> {
  try {
    await invoke("notify_send", { args: { title, body, taskId: taskId ?? null } });
  } catch (err) {
    console.warn("[notify] system notification failed:", err);
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
