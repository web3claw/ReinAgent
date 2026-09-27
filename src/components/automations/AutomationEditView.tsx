/**
 * AutomationEditView —— 自动化任务的创建/编辑页（对齐 ZCode AutomationEditView
 * 一期子集）：名称 / 频率构建器（每小时·每天·工作日·每周·每月·自定义，完整移植
 * 频率预设 + 自定义间隔/星期/月日/时间）/ 提示词 / 模型选择 / 工作区（只读）。
 */

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "../../i18n";
import { describeRule, inferPreset } from "../../lib/automations/types";
import type { Automation, AutomationUpsert, FrequencyPreset, ScheduleRule } from "../../lib/automations/types";
import type { ProviderItem } from "../settings/model-provider/types";

export interface AutomationEditViewProps {
  /** null = 新建 */
  automation: Automation | null;
  providers: ProviderItem[];
  defaultProviderId: string;
  defaultModelId: string;
  workspacePath?: string;
  onCancel: () => void;
  onSaved: (upsert: AutomationUpsert) => Promise<void>;
}

const WEEKDAY_LABELS_ZH = ["日", "一", "二", "三", "四", "五", "六"];

export function AutomationEditView(props: AutomationEditViewProps) {
  const { t } = useTranslation();
  const { automation, providers, defaultProviderId, defaultModelId, workspacePath, onCancel, onSaved } = props;

  const [title, setTitle] = useState(automation?.title ?? "");
  const [prompt, setPrompt] = useState(automation?.prompt ?? "");
  const [rule, setRule] = useState<ScheduleRule>(
    automation?.scheduleRule ?? { unit: "daily", interval: 1, hour: 9, minute: 0, weekdays: null, monthDays: null },
  );
  const [preset, setPreset] = useState<FrequencyPreset>(
    inferPreset(automation?.scheduleRule ?? { unit: "daily", interval: 1, hour: 9, minute: 0 }),
  );
  const [providerId, setProviderId] = useState(automation?.modelProvider ?? defaultProviderId);
  const [modelId, setModelId] = useState(automation?.modelId ?? defaultModelId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enabledModels = useMemo(() => {
    const provider = providers.find((p) => p.id === providerId);
    return (provider?.models ?? []).filter((m) => m.enabled !== false);
  }, [providers, providerId]);

  const applyPresetPill = (next: FrequencyPreset) => {
    setPreset(next);
    setRule((cur) => {
      switch (next) {
        case "hourly":
          return { ...cur, unit: "hourly", interval: 1, weekdays: null, monthDays: null };
        case "daily":
          return { ...cur, unit: "daily", interval: 1, weekdays: null, monthDays: null };
        case "weekdays":
          return { ...cur, unit: "weekly", interval: 1, weekdays: [1, 2, 3, 4, 5], monthDays: null };
        case "weekly":
          return {
            ...cur,
            unit: "weekly",
            interval: 1,
            weekdays: cur.weekdays && cur.weekdays.length === 1 ? cur.weekdays : [1],
            monthDays: null,
          };
        case "monthly":
          return {
            ...cur,
            unit: "monthly",
            interval: 1,
            weekdays: null,
            monthDays: cur.monthDays && cur.monthDays.length === 1 ? cur.monthDays : [1],
          };
        case "custom":
          return cur;
      }
    });
  };

  const handleSave = async () => {
    if (!title.trim()) {
      setError(t("automationsErrorTitleRequired"));
      return;
    }
    if (!prompt.trim()) {
      setError(t("automationsErrorPromptRequired"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSaved({
        title: title.trim(),
        prompt: prompt.trim(),
        scheduleRule: rule,
        modelProvider: providerId,
        modelId,
        workspacePath: workspacePath ?? null,
        enabled: automation?.enabled ?? true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  const timeInputs = (
    <div className="flex items-center gap-1.5 text-ui-xs text-[var(--text-dim)]">
      <span>{t("automationsFreqTime")}</span>
      <NumberInput value={rule.hour} min={0} max={23} onChange={(v) => setRule((c) => ({ ...c, hour: v }))} width="w-14" />
      <span>:</span>
      <NumberInput value={rule.minute} min={0} max={59} onChange={(v) => setRule((c) => ({ ...c, minute: v }))} width="w-14" />
    </div>
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden text-[var(--text)]">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--border)] px-6 pb-4 pt-5">
        <h1 className="text-ui-lg font-semibold text-[var(--text)]">
          {automation ? t("automationsEditTitleEdit") : t("automationsEditTitleCreate")}
        </h1>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto flex max-w-2xl flex-col gap-5">
          {/* 名称 */}
          <Field label={t("automationsFieldName")}>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("automationsTitlePlaceholder")}
              className="h-9 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-card)] px-3 text-ui-sm text-[var(--text)] placeholder-[var(--text-dim)] focus:border-[var(--brand)] focus:outline-none"
            />
          </Field>

          {/* 频率：预设 pills + 构建器（完整移植 ZCode 频率预设 + 自定义） */}
          <Field label={t("automationsFieldFrequency")}>
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  "hourly",
                  "daily",
                  "weekdays",
                  "weekly",
                  "monthly",
                  "custom",
                ] as FrequencyPreset[]
              ).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => applyPresetPill(p)}
                  className={`rounded-full px-3 py-1 text-ui-xs font-medium transition-colors cursor-pointer ${
                    preset === p
                      ? "bg-[var(--brand)] text-white"
                      : "border border-[var(--border)] text-[var(--text-dim)] hover:bg-[var(--surface-hover)]"
                  }`}
                >
                  {t(`automationsFreq_${p}` as never)}
                </button>
              ))}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2.5 text-ui-xs text-[var(--text)]">
              <span className="rounded-md bg-[var(--brand-dim)] px-2 py-0.5 text-[var(--brand)]">
                {describeRule(rule)}
              </span>
              {rule.unit === "minute" || preset === "custom" ? (
                <IntervalInput
                  label={t("automationsFreqEvery")}
                  value={rule.interval}
                  onChange={(v) => setRule((c) => ({ ...c, interval: Math.max(1, v) }))}
                  unit={
                    rule.unit === "minute"
                      ? t("automationsFreqUnitMinute")
                      : rule.unit === "hourly"
                        ? t("automationsFreqUnitHour")
                        : rule.unit === "daily"
                          ? t("automationsFreqUnitDay")
                          : rule.unit === "weekly"
                            ? t("automationsFreqUnitWeek")
                            : t("automationsFreqUnitMonth")
                  }
                />
              ) : null}
              {rule.unit === "hourly" ? (
                <div className="flex items-center gap-1.5 text-[var(--text-dim)]">
                  <span>{t("automationsFreqAtMinute")}</span>
                  <NumberInput value={rule.minute} min={0} max={59} onChange={(v) => setRule((c) => ({ ...c, minute: v }))} width="w-14" />
                </div>
              ) : null}
              {rule.unit === "weekly" ? (
                <div className="flex items-center gap-1">
                  {WEEKDAY_LABELS_ZH.map((label, dow) => {
                    const active = (rule.weekdays ?? []).includes(dow);
                    return (
                      <button
                        key={dow}
                        type="button"
                        onClick={() =>
                          setRule((c) => {
                            const set = new Set(c.weekdays ?? []);
                            if (set.has(dow)) set.delete(dow);
                            else set.add(dow);
                            return { ...c, weekdays: Array.from(set).sort((a, b) => a - b) };
                          })
                        }
                        className={`h-7 w-7 rounded-full text-xs transition-colors cursor-pointer ${
                          active
                            ? "bg-[var(--brand)] text-white"
                            : "border border-[var(--border)] text-[var(--text-dim)] hover:bg-[var(--surface-hover)]"
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {rule.unit === "monthly" ? (
                <div className="flex flex-wrap items-center gap-1">
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => {
                    const active = (rule.monthDays ?? []).includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        onClick={() =>
                          setRule((c) => {
                            const set = new Set(c.monthDays ?? []);
                            if (set.has(day)) set.delete(day);
                            else set.add(day);
                            return { ...c, monthDays: Array.from(set).sort((a, b) => a - b) };
                          })
                        }
                        className={`h-7 w-7 rounded-md text-xs transition-colors cursor-pointer ${
                          active
                            ? "bg-[var(--brand)] text-white"
                            : "border border-[var(--border)] text-[var(--text-dim)] hover:bg-[var(--surface-hover)]"
                        }`}
                      >
                        {day}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {rule.unit === "daily" || rule.unit === "weekly" || rule.unit === "monthly"
                ? timeInputs
                : null}
              {rule.unit === "minute" || rule.unit === "hourly" ? null : null}
            </div>
          </Field>

          {/* 提示词 */}
          <Field label={t("automationsFieldPrompt")}>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t("automationsFieldPromptPlaceholder")}
              rows={5}
              className="w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2 text-ui-sm leading-relaxed text-[var(--text)] placeholder-[var(--text-dim)] focus:border-[var(--brand)] focus:outline-none"
            />
          </Field>

          {/* 模型 */}
          <Field label={t("automationsFieldModel")}>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <select
                  value={providerId}
                  onChange={(e) => {
                    setProviderId(e.target.value);
                    const p = providers.find((x) => x.id === e.target.value);
                    const firstEnabled = (p?.models ?? []).find((m) => m.enabled !== false);
                    setModelId(firstEnabled?.id ?? "");
                  }}
                  className="h-9 w-full appearance-none rounded-xl border-0 bg-[var(--bg-hover)] px-3 pr-8 text-ui-sm text-[var(--text)] focus:outline-none"
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-[var(--text-dim)]" />
              </div>
              <div className="relative flex-1">
                <select
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  className="h-9 w-full appearance-none rounded-xl border-0 bg-[var(--bg-hover)] px-3 pr-8 text-ui-sm text-[var(--text)] focus:outline-none"
                >
                  {enabledModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-[var(--text-dim)]" />
              </div>
            </div>
          </Field>

          {/* 工作区（只读，一期取创建时的当前工作区） */}
          <Field label={t("automationsFieldWorkspace")}>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2 text-ui-xs text-[var(--text-dim)]">
              {workspacePath || t("automationsFieldWorkspaceDefault")}
            </div>
          </Field>

          {error ? (
            <div className="rounded-lg border border-[var(--danger)] bg-[var(--danger)]/10 px-3 py-2 text-ui-xs text-[var(--danger)]">
              {error}
            </div>
          ) : null}

          {/* 动作 */}
          <div className="flex items-center justify-end gap-2 pb-4">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-full border border-[var(--border)] px-5 py-1.5 text-ui-sm text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] cursor-pointer"
            >
              {t("automationsCancel")}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleSave()}
              className="rounded-full bg-[var(--brand)] px-6 py-1.5 text-ui-sm font-medium text-white transition-colors hover:bg-[var(--accent)] cursor-pointer disabled:opacity-50"
            >
              {t("automationsSave")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-ui-xs font-medium text-[var(--text-dim)]">{label}</span>
      {children}
    </div>
  );
}

function NumberInput({
  value,
  min,
  max,
  onChange,
  width = "w-16",
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  width?: string;
}) {
  return (
    <input
      type="number"
      min={min}
      max={max}
      value={value}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, Math.round(v))));
      }}
      className={`${width} rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-0.5 text-center text-ui-xs text-[var(--text)] focus:border-[var(--brand)] focus:outline-none`}
    />
  );
}

function IntervalInput({
  label,
  value,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 text-[var(--text-dim)]">
      <span>{label}</span>
      <NumberInput value={value} min={1} max={200} onChange={onChange} width="w-16" />
      <span>{unit}</span>
    </div>
  );
}
