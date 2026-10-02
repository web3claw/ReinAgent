// LiveAgent 移植：crates/agent-ui/src/components/ui/toaster.tsx
// 渲染 toast.ts 的 store：右下/右上/底部居中三个分栈，视觉类名对齐 LA toaster.tsx。
// i18n 铁律：LA 的关闭按钮 aria-label（t("common.dismissNotification")）改为必填
// props dismissLabel，页面层负责传入 i18n 值。
import { useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, X, XCircle } from "lucide-react";

import { cn } from "../lib/utils";
import {
  getToasts,
  pauseToast,
  resumeToast,
  subscribeToasts,
  TOAST_POSITIONS,
  toast,
  type ToastEntry,
  type ToastPosition,
} from "./toast";

const POSITION_CLASSES: Record<ToastPosition, string> = {
  "top-right": "right-4 top-4 items-end",
  "bottom-right": "bottom-5 right-4 items-end sm:right-6",
  "bottom-center":
    "bottom-4 left-1/2 -translate-x-1/2 items-center max-sm:bottom-safe-bottom-offset",
};

// LA lib/shared/motion.ts 的 UI_MOTION_TRANSITION（feedback / feedbackExit）。
const FEEDBACK_TRANSITION = { duration: 0.2, ease: "cubic-bezier(0.2, 0, 0, 1)" } as const;
const FEEDBACK_EXIT_TRANSITION = { duration: 0.16, ease: "cubic-bezier(0.4, 0, 1, 1)" } as const;

export function Toaster(props: {
  /** 关闭按钮的无障碍文案，页面需传 i18n 值。 */
  dismissLabel: string;
}) {
  const [version, setVersion] = useState(0);
  useEffect(() => subscribeToasts(() => setVersion((v) => v + 1)), []);
  const lists = useMemo(
    () =>
      TOAST_POSITIONS.map((position) => ({
        position,
        entries: [...getToasts(position)].reverse(),
        // eslint-disable-next-line react-hooks/exhaustive-deps
      })),
    // version 变化时重新读取 store 快照。
    [version],
  );
  return (
    <>
      {lists.map(({ position, entries }) => (
        <div
          key={position}
          role="region"
          aria-label={props.dismissLabel}
          data-toast-position={position}
          className={cn(
            "layer-toast pointer-events-none fixed z-50 flex max-h-[calc(100dvh-2rem)] flex-col gap-2 overflow-y-auto",
            POSITION_CLASSES[position],
          )}
        >
          {entries.map((entry) => (
            <ToastEntryView key={entry.id} entry={entry} dismissLabel={props.dismissLabel} />
          ))}
        </div>
      ))}
    </>
  );
}

// ⚠️ 不可 memo：toast.ts 原地变更 entry.transitionStatus（引用不变），memo 会拦截
// enter→idle 的重渲染，toast 永远停在 opacity-0（隐形）。text/边框/背景一律走语义变量。
function ToastEntryView(props: {
  entry: ToastEntry;
  dismissLabel: string;
}) {
  const { entry: notification, dismissLabel } = props;
  const prefersReducedMotion = useReducedMotion();

  const isWarning = notification.type === "warning";
  const isSuccess = notification.type === "success";
  const notice = notification.appearance === "notice";
  const ending = notification.transitionStatus === "ending";

  return (
    <div
      role="status"
      aria-live={notification.priority === "high" ? "assertive" : "polite"}
      onMouseEnter={() => pauseToast(notification.id)}
      onMouseLeave={() => resumeToast(notification.id)}
      style={{
        transitionDuration: prefersReducedMotion ? "0s" : `${FEEDBACK_TRANSITION.duration}s`,
        transitionTimingFunction: prefersReducedMotion
          ? undefined
          : ending
            ? FEEDBACK_EXIT_TRANSITION.ease
            : FEEDBACK_TRANSITION.ease,
      }}
      className={cn(
        "pointer-events-auto flex shrink-0 items-start gap-2.5 rounded-lg border",
        notice ? "w-96 max-w-[calc(100vw-2rem)]" : "w-notification",
        "px-3 py-2.5 text-sm",
        notice ? "bg-background" : "bg-[var(--bg-elev)] shadow-lg backdrop-blur-xl",
        "transition-[opacity,translate] motion-reduce:transition-none",
        ending || notification.transitionStatus === "enter" ? "opacity-0" : "opacity-100",
        !prefersReducedMotion && notification.transitionStatus === "enter" && "translate-x-5",
        !prefersReducedMotion && ending && "translate-x-5",
        // 类型色只上边框（背景/文字走语义变量，双主题可读）
        isWarning
          ? "border-amber-500/40"
          : isSuccess
            ? "border-emerald-500/40"
            : "border-red-500/40",
      )}
    >
      {isWarning ? (
        <AlertTriangle
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-amber-500 dark:text-amber-400"
        />
      ) : isSuccess ? (
        <CheckCircle2
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-emerald-500 dark:text-emerald-400"
        />
      ) : (
        <XCircle
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-red-500 dark:text-red-400"
        />
      )}
      <div className="min-w-0 flex-1">
        {notification.title ? (
          <div className="font-medium text-[var(--text)]">{notification.title}</div>
        ) : null}
        <div
          className={cn(
            "whitespace-pre-wrap break-words leading-relaxed text-[var(--text)]",
            notice && notification.title ? "mt-0.5 max-h-40 overflow-y-auto text-xs text-[var(--text-dim)]" : "",
          )}
        >
          {notification.description}
        </div>
        {notification.action ? (
          <button
            type="button"
            className="mt-2 rounded-md border border-[var(--border)] bg-[var(--bg-elev)] px-2.5 py-1 text-xs text-[var(--text)]"
            onClick={() => {
              notification.action?.onClick();
              toast.dismiss(notification.id);
            }}
          >
            {notification.action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        aria-label={dismissLabel}
        className={cn(
          "mt-0.5 shrink-0 rounded p-0.5 opacity-50 transition-opacity",
          "hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current focus-visible:ring-offset-1 focus-visible:ring-offset-transparent",
        )}
        onClick={() => toast.dismiss(notification.id)}
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}
