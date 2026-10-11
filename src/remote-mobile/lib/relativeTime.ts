/**
 * relativeTime —— ZCode lib/taskListItemPresentation.ts 的 formatTaskRelativeTime 直移
 * （intl.formatMessage → 本仓 formatRemoteMessage）。
 */
import { formatRemoteMessage, type RemoteLocale } from "../i18n";

export function formatTaskRelativeTime(timestamp: number, locale: RemoteLocale): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return formatRemoteMessage(locale, "taskList.justNow");
  if (minutes < 60) {
    return formatRemoteMessage(locale, "taskList.minutesAgo", { minutes: String(minutes) });
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return formatRemoteMessage(locale, "taskList.hoursAgo", { hours: String(hours) });
  }

  const days = Math.floor(hours / 24);
  return formatRemoteMessage(locale, "taskList.daysAgo", { days: String(days) });
}
