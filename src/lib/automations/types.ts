/**
 * automations/types —— 自动化定时任务的 TS 类型（与 Rust `automation.rs` 的
 * serde camelCase DTO 一一对应）与调度规则的展示辅助。
 */

export type AutomationUnit = "minute" | "hourly" | "daily" | "weekly" | "monthly";

/** 结构化调度规则（调度权威；cronExpr 仅展示兼容） */
export interface ScheduleRule {
  unit: AutomationUnit;
  interval: number;
  hour: number;
  minute: number;
  /** 0=周日 … 6=周六（weekly 用） */
  weekdays?: number[] | null;
  /** 1-31（monthly 用） */
  monthDays?: number[] | null;
}

export interface Automation {
  automationId: string;
  title: string;
  cronExpr: string;
  scheduleRule: ScheduleRule;
  prompt: string;
  modelProvider?: string | null;
  modelId?: string | null;
  workspacePath?: string | null;
  enabled: boolean;
  lifecycleStatus: "active" | "paused" | "completed" | "failed";
  runCount: number;
  nextRunAt?: number | null;
  lastRunAt?: number | null;
  lastError?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AutomationRun {
  runId: string;
  automationId: string;
  scheduledAt?: number | null;
  trigger: "schedule" | "manual";
  status: "running" | "succeeded" | "failed" | "stopped";
  taskId?: string | null;
  error?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AutomationUpsert {
  title: string;
  prompt: string;
  scheduleRule: ScheduleRule;
  modelProvider?: string | null;
  modelId?: string | null;
  workspacePath?: string | null;
  enabled: boolean;
}

/** Rust `automation-due` 事件 payload（AutomationDuePayload） */
export interface AutomationDuePayload {
  runId: string;
  automationId: string;
  title: string;
  prompt: string;
  workspacePath?: string | null;
  modelProvider?: string | null;
  modelId?: string | null;
}

export type FrequencyPreset = "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "custom";

/** 由规则推断预设（无匹配 → custom）；仅用于高亮 pill，编辑以 rule 为准 */
export function inferPreset(rule: ScheduleRule): FrequencyPreset {
  if (rule.unit === "hourly" && rule.interval === 1) return "hourly";
  if (rule.unit === "daily" && rule.interval === 1) return "daily";
  if (rule.unit === "weekly" && rule.interval === 1) {
    const wd = [...(rule.weekdays ?? [])].sort((a, b) => a - b);
    if (wd.join(",") === "1,2,3,4,5") return "weekdays";
    if (wd.length === 1) return "weekly";
  }
  if (rule.unit === "monthly" && rule.interval === 1 && (rule.monthDays?.length ?? 0) === 1) {
    return "monthly";
  }
  return "custom";
}

/** 应用一个预设到当前规则（保留时间字段，便于微调） */
export function applyPreset(preset: FrequencyPreset, rule: ScheduleRule): ScheduleRule {
  switch (preset) {
    case "hourly":
      return { ...rule, unit: "hourly", interval: 1, weekdays: null, monthDays: null };
    case "daily":
      return { ...rule, unit: "daily", interval: 1, weekdays: null, monthDays: null };
    case "weekdays":
      return {
        ...rule,
        unit: "weekly",
        interval: 1,
        weekdays: [1, 2, 3, 4, 5],
        monthDays: null,
      };
    case "weekly":
      return {
        ...rule,
        unit: "weekly",
        interval: 1,
        weekdays: rule.weekdays && rule.weekdays.length === 1 ? rule.weekdays : [1],
        monthDays: null,
      };
    case "monthly":
      return {
        ...rule,
        unit: "monthly",
        interval: 1,
        weekdays: null,
        monthDays: rule.monthDays && rule.monthDays.length === 1 ? rule.monthDays : [1],
      };
    case "custom":
      return { ...rule };
  }
}

const WEEKDAY_ZH = ["日", "一", "二", "三", "四", "五", "六"];

/** 规则的中文摘要（列表徽标 / 编辑页回显；对齐 ZCode cardSchedule 摘要语义） */
export function describeRule(rule: ScheduleRule): string {
  const time = `${String(rule.hour).padStart(2, "0")}:${String(rule.minute).padStart(2, "0")}`;
  switch (rule.unit) {
    case "minute":
      return `每 ${rule.interval} 分钟`;
    case "hourly":
      return rule.interval === 1
        ? `每小时（第 ${rule.minute} 分）`
        : `每 ${rule.interval} 小时（第 ${rule.minute} 分）`;
    case "daily":
      return rule.interval === 1 ? `每天 ${time}` : `每 ${rule.interval} 天 ${time}`;
    case "weekly": {
      const wd = (rule.weekdays ?? []).map((d) => WEEKDAY_ZH[d] ?? "?").join("、");
      return rule.interval === 1 ? `每周${wd} ${time}` : `每 ${rule.interval} 周 · ${wd} ${time}`;
    }
    case "monthly": {
      const md = (rule.monthDays ?? []).map((d) => `${d} 日`).join("、");
      return rule.interval === 1 ? `每月 ${md} ${time}` : `每 ${rule.interval} 月 · ${md} ${time}`;
    }
  }
}
