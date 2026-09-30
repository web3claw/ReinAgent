/**
 * SubagentEditorSheet —— 子智能体新增/编辑侧滑编辑器。
 * PI-Desktop 移植：apps/desktop/src/components/settings/SubagentEditorSheet.tsx（字段子集）。
 * v1 取舍（如实呈现）：无 fallbackModels / maxTokens（本仓运行时未实现，不做假开关）；
 * 无 inheritTools（运行时未实现合并语义）；工具直接白名单勾选。
 */

import { useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import {
  MAX_SUBAGENT_BYTES,
  builtinSubagentDefinitions,
  subagentSlug,
  type SubagentDefinition,
  type UserSubagentRecord,
} from "../../lib/subagents/subagentDefinitions";
import { cn } from "../lw/lib/utils";
import { Checkbox } from "../lw/ui/checkbox";
import { Input } from "../lw/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../lw/ui/select";
import { Dialog, DialogContent, DialogHeader } from "../lw/ui/dialog";
import { Textarea } from "../lw/ui/textarea";
import { Button } from "../lw/ui/button";
import {
  ModelPicker,
  type ModelPickerOption,
} from "../lw/settings/ModelPicker";

export interface SubagentDraft {
  editingId: string | null;
  name: string;
  description: string;
  tools: string[];
  model: string;
  thinkingLevel: string;
  prompt: string;
  enabled: boolean;
}

export function emptySubagentDraft(): SubagentDraft {
  return {
    editingId: null,
    name: "",
    description: "",
    tools: ["read_file", "glob", "grep"],
    model: "",
    thinkingLevel: "",
    prompt: "",
    enabled: true,
  };
}

export function draftFromRecord(record: UserSubagentRecord): SubagentDraft {
  return {
    editingId: record.id,
    name: record.name,
    description: record.description,
    tools: [...record.tools],
    model: record.model ?? "",
    thinkingLevel: record.thinkingLevel ?? "",
    prompt: record.prompt,
    enabled: record.enabled,
  };
}

export function draftFromDefinition(definition: SubagentDefinition): SubagentDraft {
  return {
    editingId: null,
    name: definition.name,
    description: definition.description,
    tools: [...definition.tools],
    model: definition.model ?? "",
    thinkingLevel: definition.thinkingLevel ?? "",
    prompt: definition.prompt,
    enabled: true,
  };
}

/** 新建命名后首次自动种子指令正文（PI subagentTemplate 同语义）。 */
export function subagentTemplate(name: string): string {
  return `You are the "${name}" subagent. Follow the task from the caller and use only the granted tools.\n\n- \n- \n\nReport: your final message is the deliverable — make it complete and self-contained.`;
}

const PRESET_NAME_KEYS: Record<string, string> = {
  explorer: "subagentPresetExplorerName",
  "code-reviewer": "subagentPresetReviewerName",
  "test-runner": "subagentPresetTestRunnerName",
  fixer: "subagentPresetFixerName",
  "ui-designer": "subagentPresetUiDesignerName",
};

/** 校验草稿，返回第一个错误文案（无错误 → null）。 */
export function subagentDraftError(draft: SubagentDraft, t: (key: string) => string): string | null {
  if (!draft.name.trim()) return t("subagentErrorName");
  if (!subagentSlug(draft.name.trim())) return t("subagentErrorSlug");
  if (!draft.description.trim()) return t("subagentErrorDescription");
  if (draft.tools.length === 0) return t("subagentErrorTools");
  if (!draft.prompt.trim()) return t("subagentErrorBody");
  if (new TextEncoder().encode(draft.prompt).length > MAX_SUBAGENT_BYTES) {
    return t("subagentErrorTooBig");
  }
  return null;
}

export function SubagentEditorSheet({
  draft,
  setDraft,
  modelOptions,
  isCreate,
  saving,
  onClose,
  onSave,
}: {
  draft: SubagentDraft;
  setDraft: (draft: SubagentDraft) => void;
  modelOptions: ModelPickerOption[];
  isCreate: boolean;
  saving: boolean;
  onClose: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  // 动态键（PRESET_NAME_KEYS 查表）与 hub 合并键（chat.searchModel 等）需要 string 签名
  const tf = t as unknown as (key: string) => string;
  const [error, setError] = useState<string | null>(null);

  const presets = useMemo(() => builtinSubagentDefinitions().definitions, []);
  const byteCount = new TextEncoder().encode(draft.prompt).length;
  const byteRatio = byteCount / MAX_SUBAGENT_BYTES;

  const applyPreset = (presetId: string) => {
    const preset = presets.find((p) => p.name === presetId);
    if (!preset) return;
    setError(null);
    setDraft({
      ...draft,
      name: preset.name,
      description: preset.description,
      tools: [...preset.tools],
      prompt: preset.prompt,
    });
  };

  const handleName = (value: string) => {
    setError(null);
    const next = { ...draft, name: value };
    // 正文为空时随命名种子模板（PI 同语义；重复触发无害——只在正文为空时）
    if (value.trim() && !draft.prompt.trim()) {
      next.prompt = subagentTemplate(value.trim());
    }
    setDraft(next);
  };

  const toggleTool = (tool: string) => {
    setError(null);
    const tools = draft.tools.includes(tool)
      ? draft.tools.filter((item) => item !== tool)
      : [...draft.tools, tool];
    setDraft({ ...draft, tools });
  };

  const saveDisabled = saving || !draft.name.trim() || subagentDraftError(draft, (k) => k) !== null;

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent
        className="flex h-[min(46rem,calc(100dvh-2rem))] max-w-xl flex-col"
        closeDisabled={saving}
        closeLabel={t("cancel")}
        showCloseButton
      >
        <DialogHeader className="gap-1 pb-3">
          <h2 className="text-base font-semibold">
            {isCreate ? t("subagentAddTitle") : t("subagentEditTitle")}
          </h2>
          <p className="text-xs leading-5 text-muted-foreground">{t("subagentSheetSubtitle")}</p>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-6 pb-4">
          {isCreate ? (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--text-dim)]">
                {t("subagentPresetLabel")}
              </label>
              <div className="flex flex-wrap gap-1.5">
                {presets.map((preset) => {
                  const selected = draft.name === preset.name && draft.prompt === preset.prompt;
                  return (
                    <button
                      key={preset.name}
                      type="button"
                      onClick={() => applyPreset(preset.name)}
                      className={cn(
                        "rounded-lg border px-2.5 py-1 text-xs transition-colors",
                        selected
                          ? "border-[var(--brand)] bg-[var(--brand-dim)] text-[var(--text)]"
                          : "border-[var(--border)] bg-settings-tile text-[var(--text-dim)] hover:text-[var(--text)]",
                      )}
                    >
                      {tf(PRESET_NAME_KEYS[preset.name] ?? preset.name)}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <label htmlFor="subagent-name" className="text-xs font-medium text-[var(--text-dim)]">
              {t("subagentName")}
            </label>
            <Input
              variant="plain"
              id="subagent-name"
              value={draft.name}
              placeholder="doc-reviewer"
              onChange={(e) => handleName(e.currentTarget.value)}
            />
            {subagentSlug(draft.name) ? (
              <p className="text-[11px] text-[var(--text-dim)]">
                {t("subagentSlugHint").replace("{id}", subagentSlug(draft.name))}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="subagent-description"
              className="text-xs font-medium text-[var(--text-dim)]"
            >
              {t("subagentDescriptionLabel")}
            </label>
            <Textarea
              variant="plain"
              id="subagent-description"
              value={draft.description}
              rows={2}
              placeholder={t("subagentDescriptionPlaceholder")}
              onChange={(e) => {
                setError(null);
                setDraft({ ...draft, description: e.currentTarget.value });
              }}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[var(--text-dim)]">{t("subagentTools")}</label>
            <div className="grid grid-cols-2 gap-1.5">
              {(
                [
                  "read_file",
                  "list_dir",
                  "glob",
                  "grep",
                  "webfetch",
                  "websearch",
                  "exec_command",
                  "write_file",
                  "edit_file",
                ] as const
              ).map((tool) => {
                const mutating = tool === "exec_command" || tool === "write_file" || tool === "edit_file";
                const on = draft.tools.includes(tool);
                return (
                  <label
                    key={tool}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors",
                      on
                        ? mutating
                          ? "border-amber-500/40 bg-amber-500/[0.06] text-[var(--text)]"
                          : "border-[var(--brand)]/50 bg-[var(--brand-dim)] text-[var(--text)]"
                        : "border-[var(--border)] bg-settings-tile text-[var(--text-dim)] hover:text-[var(--text)]",
                    )}
                  >
                    <Checkbox checked={on} onCheckedChange={() => toggleTool(tool)} />
                    <code className="font-mono">{tool}</code>
                    {mutating && on ? (
                      <span className="ml-auto text-[10px] text-amber-600 dark:text-amber-400">✎</span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor="subagent-body" className="text-xs font-medium text-[var(--text-dim)]">
                {t("subagentBody")}
              </label>
              <span
                className={cn(
                  "font-mono text-[11px] tabular-nums",
                  byteRatio > 1
                    ? "text-red-500"
                    : byteRatio > 0.8
                      ? "text-amber-500"
                      : "text-[var(--text-dim)]",
                )}
              >
                {Math.round(byteCount / 102.4) / 10} / {Math.round(MAX_SUBAGENT_BYTES / 1024)} KB
              </span>
            </div>
            <Textarea
              variant="plain"
              id="subagent-body"
              value={draft.prompt}
              rows={10}
              className="font-mono text-xs leading-relaxed"
              onChange={(e) => {
                setError(null);
                setDraft({ ...draft, prompt: e.currentTarget.value });
              }}
            />
            <p className="text-[11px] text-[var(--text-dim)]">{t("subagentBodyHint")}</p>
          </div>

          <div className="space-y-3 rounded-xl bg-settings-tile p-4">
            <p className="text-xs font-semibold">{t("subagentAdvanced")}</p>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--text-dim)]">
                {t("subagentModel")}
              </label>
              <ModelPicker
                options={modelOptions}
                value={draft.model}
                onChange={(value) => {
                  setError(null);
                  setDraft({ ...draft, model: value });
                }}
                placeholder={t("subagentModelInherit")}
                noneLabel={t("subagentModelInherit")}
                variant="plain"
                searchPlaceholder={tf("chat.searchModel")}
                emptyLabel={tf("chat.noModelFound")}
                collapseProviderLabel={tf("chat.collapseProvider")}
                expandProviderLabel={tf("chat.expandProvider")}
              />
              <p className="text-[11px] text-[var(--text-dim)]">{t("subagentModelHint")}</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--text-dim)]">
                {t("subagentThinking")}
              </label>
              <Select
                value={draft.thinkingLevel}
                onValueChange={(value) => {
                  setError(null);
                  setDraft({ ...draft, thinkingLevel: value });
                }}
              >
                <SelectTrigger className="h-9 w-full justify-between rounded-lg bg-settings-tile-hover px-3 shadow-none">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">{t("subagentThinkingInherit")}</SelectItem>
                  <SelectItem value="off">off</SelectItem>
                  <SelectItem value="low">low</SelectItem>
                  <SelectItem value="medium">medium</SelectItem>
                  <SelectItem value="high">high</SelectItem>
                  <SelectItem value="xhigh">xhigh</SelectItem>
                  <SelectItem value="max">max</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label className="flex cursor-pointer items-center justify-between text-xs">
              <span>{t("subagentEnabledLabel")}</span>
              <Checkbox
                checked={draft.enabled}
                onCheckedChange={(checked) => setDraft({ ...draft, enabled: checked })}
              />
            </label>
          </div>

          {error ? <p className="text-xs text-red-500">{error}</p> : null}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border)] px-6 py-4">
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            {t("cancel")}
          </Button>
          <Button
            size="sm"
            disabled={saveDisabled}
            onClick={() => {
              const problem = subagentDraftError(draft, (key) => t(key as never) as string);
              if (problem) {
                setError(problem);
                return;
              }
              onSave();
            }}
          >
            {t("save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
