/**
 * taskNotifications.ts —— 后台任务完成系统通知 + 提示音（对齐 ZCode
 * taskNotificationOrchestrator 的最小可用版）。
 *
 * 触发条件（避免打扰）：
 * - 任务跑到**终态**（done/error/stopped）且**不是当前正在看的任务**（或窗口不可见）；
 * - 同一任务同一轮只通知一次（runId 去重）。
 *
 * 提示音：双平台共用打包内资源 task-done.wav（Linux 经 Rust pw-play 播放，
 * Windows/macOS 经 WebAudio 解码播放）；开关持久化 kv。
 */

import { invoke } from "@tauri-apps/api/core";
import { kvGet, kvSet } from "../storage/db";
import taskDoneWavUrl from "../../assets/sounds/task-done.wav";

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

/** 任务提示音：双平台播放**同一个 wav 资源**（src/assets/sounds/task-done.wav，
 * 用户自选 Mixkit "Software Interface Start" 前 1s，PCM16 44.1kHz，结尾 60ms 淡出）。
 *
 * Linux：WebKitGTK 的 WebAudio 引擎故障（AudioContext 起始即 suspended 且 resume()
 * 的 Promise 永不 settle，实测 libwebkit2gtk 2.52.6，关沙箱复现相同），WebAudio 无法
 * 出声——改调 Rust `notify_beep`（编译期 include_bytes 嵌入同一文件 → pw-play 播放）。
 * Windows/macOS：fetch + decodeAudioData 经共享 AudioContext 播放（保留 suspended
 * resume 兜底）。失败如实 console.warn（No-Fallback：不静默伪装成功）。 */
let cachedNotifyBuffer: AudioBuffer | null = null;

export function playNotificationSound(): void {
  if (navigator.userAgent.includes("Linux")) {
    invoke("notify_beep").catch((err: unknown) => {
      // No-Fallback：真实失败如实输出，不静默伪装成功
      console.warn("[notify] 提示音播放失败:", err);
    });
    return;
  }
  void playWavNotificationSound();
}

/** Windows/macOS：解码并播放打包内提示音 wav（解码结果缓存，重复播放零解码开销）。 */
async function playWavNotificationSound(): Promise<void> {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    // Windows/Chromium 的 AudioContext 起始可能是 suspended（自动播放策略）：
    // 先 resume 再播；resume 期间无声直接播会静默失败。
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    if (!cachedNotifyBuffer) {
      const res = await fetch(taskDoneWavUrl);
      if (!res.ok) throw new Error(`提示音资源加载失败: HTTP ${res.status}`);
      cachedNotifyBuffer = await ctx.decodeAudioData(await res.arrayBuffer());
    }
    const src = ctx.createBufferSource();
    src.buffer = cachedNotifyBuffer;
    src.connect(ctx.destination);
    src.start();
  } catch (err) {
    // No-Fallback：真实失败如实输出，不静默伪装成功
    console.warn("[notify] 提示音播放失败:", err);
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
