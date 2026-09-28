// LiveAgent 移植：crates/agent-ui/src/components/ui/toast.ts + toast-manager.ts
// LA 用 Base UI 的 ToastProvider/createToastManager/useToastManager 三件套；
// 这里实现同 API 的极简 toast store（订阅 + 位置分栈 + 结束态过渡），
// 渲染容器见 ./toaster.tsx 的 <Toaster/>。
import type { ReactNode } from "react";

export type ToastPosition = "top-right" | "bottom-right" | "bottom-center";
export type ToastTone = "success" | "warning" | "error";
export type ToastOptions = {
  id?: string;
  position?: ToastPosition;
  description?: ReactNode;
  /** Zero keeps a result visible until dismissed. */
  duration?: number;
  appearance?: "notification" | "notice";
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
};

export type ToastEntry = {
  id: string;
  type: ToastTone;
  /** LA 语义：传了 options.description 时 message 升为 title。 */
  title?: ReactNode;
  description: ReactNode;
  priority: "high" | "low";
  /** 0 表示驻留到手动关闭。 */
  timeout: number;
  appearance: "notification" | "notice";
  action?: ToastOptions["action"];
  onDismiss?: () => void;
  /** UI 过渡态：enter 进场 / idle 停留 / ending 出场（结束动画播完即移除）。 */
  transitionStatus: "enter" | "idle" | "ending";
};

export const TOAST_POSITIONS: readonly ToastPosition[] = [
  "top-right",
  "bottom-right",
  "bottom-center",
];

const state = new Map<ToastPosition, ToastEntry[]>(TOAST_POSITIONS.map((p) => [p, []]));
const autoDismissTimers = new Map<string, ReturnType<typeof setTimeout>>();
const exitTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pausedAt = new Map<string, number>();
const remaining = new Map<string, number>();
const listeners = new Set<() => void>();
let sequence = 0;

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getToasts(position: ToastPosition): readonly ToastEntry[] {
  return state.get(position) ?? [];
}

function findToast(id: string): { position: ToastPosition; entry: ToastEntry } | undefined {
  for (const position of TOAST_POSITIONS) {
    const entry = state.get(position)?.find((candidate) => candidate.id === id);
    if (entry) return { position, entry };
  }
  return undefined;
}

function clearAutoDismiss(id: string) {
  const timer = autoDismissTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    autoDismissTimers.delete(id);
  }
}

function finalize(id: string) {
  for (const position of TOAST_POSITIONS) {
    const list = state.get(position);
    if (!list) continue;
    const index = list.findIndex((entry) => entry.id === id);
    if (index === -1) continue;
    const [entry] = list.splice(index, 1);
    entry.onDismiss?.();
    break;
  }
}

function beginExit(id: string) {
  const found = findToast(id);
  if (!found || found.entry.transitionStatus === "ending") return;
  found.entry.transitionStatus = "ending";
  emit();
  // 出场过渡时长与 Toaster 的 transition duration（feedbackExit ≈ 160ms）一致。
  exitTimers.set(
    id,
    setTimeout(() => {
      exitTimers.delete(id);
      finalize(id);
      emit();
    }, 160),
  );
}

function scheduleAutoDismiss(id: string, timeout: number) {
  clearAutoDismiss(id);
  if (timeout <= 0) return;
  autoDismissTimers.set(
    id,
    setTimeout(() => {
      autoDismissTimers.delete(id);
      beginExit(id);
    }, timeout),
  );
}

/** Hover 暂停（对齐 Base UI Toast 的悬停驻留）。 */
export function pauseToast(id: string) {
  const found = findToast(id);
  if (!found || found.entry.transitionStatus === "ending") return;
  if (!autoDismissTimers.has(id)) return;
  pausedAt.set(id, Date.now());
  remaining.set(id, remaining.get(id) ?? found.entry.timeout);
  clearAutoDismiss(id);
}

export function resumeToast(id: string) {
  if (!pausedAt.has(id)) return;
  const elapsed = Date.now() - (pausedAt.get(id) ?? Date.now());
  const rest = Math.max(0, (remaining.get(id) ?? 0) - elapsed);
  pausedAt.delete(id);
  remaining.delete(id);
  scheduleAutoDismiss(id, rest);
}

function show(type: ToastTone, message: string, options: ToastOptions = {}): string {
  const id = options.id ?? `app-toast-${++sequence}`;
  // 同 id 重复触发：先移除旧条目再插入（视觉上等价 Base UI 的 replace 语义）。
  const existing = findToast(id);
  if (existing) removeImmediate(id, /* silent */ true);
  const position = options.position ?? "top-right";
  const entry: ToastEntry = {
    id,
    type,
    title: options.description !== undefined ? message : undefined,
    description: options.description ?? message,
    priority: type === "error" ? "high" : "low",
    timeout: options.duration ?? 5000,
    appearance: options.appearance ?? "notification",
    action: options.action,
    onDismiss: options.onDismiss,
    transitionStatus: "enter",
  };
  state.get(position)?.push(entry);
  emit();
  // 进场态只持续一帧量级：由 Toaster 在挂载后翻回 idle（驱动 CSS 过渡）。
  setTimeout(() => {
    const found = findToast(id);
    if (found && found.entry.transitionStatus === "enter") {
      found.entry.transitionStatus = "idle";
      emit();
    }
  }, 20);
  scheduleAutoDismiss(id, entry.timeout);
  return id;
}

function removeImmediate(id: string, silent = false) {
  clearAutoDismiss(id);
  const exitTimer = exitTimers.get(id);
  if (exitTimer !== undefined) {
    clearTimeout(exitTimer);
    exitTimers.delete(id);
  }
  pausedAt.delete(id);
  remaining.delete(id);
  for (const position of TOAST_POSITIONS) {
    const list = state.get(position);
    if (!list) continue;
    const index = list.findIndex((entry) => entry.id === id);
    if (index === -1) continue;
    const [entry] = list.splice(index, 1);
    if (!silent) entry.onDismiss?.();
    break;
  }
}

export function dismissToast(id?: string) {
  if (id === undefined) {
    const ids = TOAST_POSITIONS.flatMap((position) =>
      (state.get(position) ?? []).map((entry) => entry.id),
    );
    for (const entryId of ids) removeImmediate(entryId);
  } else {
    const found = findToast(id);
    if (!found) return;
    if (found.entry.transitionStatus === "ending") {
      removeImmediate(id);
    } else {
      beginExit(id);
    }
  }
  emit();
}

export const toast = {
  success: (message: string, options?: ToastOptions) => show("success", message, options),
  warning: (message: string, options?: ToastOptions) => show("warning", message, options),
  error: (message: string, options?: ToastOptions) => show("error", message, options),
  /** 省略 id 时关闭全部 toast（LA/Base UI 的 dismiss() 语义）。 */
  dismiss: (id?: string) => dismissToast(id),
};
