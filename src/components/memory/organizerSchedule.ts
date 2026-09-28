// LiveAgent 移植：crates/agent-ui/src/lib/settings/themeAndMemory.ts（仅记忆整理
// 排程纯函数部分：normalizeMemoryOrganizerWeekday + computeNextMemoryOrganizerRunAt）。
// 适配：schedule 类型收敛为 hubSettingsStore 的 MemoryScheduleSettings。

import type { MemoryScheduleSettings } from "../../store/hubSettingsStore";

function normalizeMemoryOrganizerWeekday(input: unknown) {
  const value = typeof input === "number" ? input : Number(input);
  return Number.isInteger(value) && value >= 0 && value <= 6 ? value : 1;
}

export function computeNextMemoryOrganizerRunAt(
  schedule: MemoryScheduleSettings,
  from = Date.now(),
): number | undefined {
  if (schedule.frequency === "none") {
    return undefined;
  }

  const [hourRaw, minuteRaw] = schedule.timeLocal.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const base = new Date(from);
  const candidate = new Date(base);
  candidate.setSeconds(0, 0);
  candidate.setHours(
    Number.isInteger(hour) ? hour : 3,
    Number.isInteger(minute) ? minute : 0,
    0,
    0,
  );

  if (schedule.frequency === "weekly") {
    const targetWeekday = normalizeMemoryOrganizerWeekday(schedule.weekday);
    const currentWeekday = candidate.getDay();
    let days = (targetWeekday - currentWeekday + 7) % 7;
    if (days === 0 && candidate.getTime() <= from) {
      days = 7;
    }
    candidate.setDate(candidate.getDate() + days);
    return candidate.getTime();
  }

  if (candidate.getTime() <= from) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.getTime();
}
