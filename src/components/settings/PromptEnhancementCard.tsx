/**
 * PromptEnhancementCard —— 设置 ▸ 提示词增强（结构移植自 PI-Desktop
 * prompt-enhancement-card.tsx + EnhancementModelCard.tsx）。
 *
 * 自定义模板编辑器（{{draft}} 校验 / ≤8000 字符 / 恢复默认）+ 钉住增强模型
 * （跟随当前模型 or 全部已启用服务商的模型）+ 推理等级行。保存走
 * savePromptEnhancementSettings（settings.json "promptEnhancement" 键）。
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, Sparkles, Undo2 } from "lucide-react";
import { useTranslation } from "../../i18n";
import { Button } from "../lw/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../lw/ui/select";
import { Textarea } from "../lw/ui/textarea";
import {
  DEFAULT_PROMPT_ENHANCEMENT_USER_TEMPLATE,
  PROMPT_ENHANCEMENT_DRAFT_VARIABLE,
  PROMPT_ENHANCEMENT_MAX_TEMPLATE_CHARS,
  promptEnhancementTemplateError,
} from "../../lib/promptEnhancement/templates";
import {
  loadPromptEnhancementSettings,
  savePromptEnhancementSettings,
  type PromptEnhancementSettings,
} from "../../lib/promptEnhancement/settings";
import { loadProvidersConfigFromDisk, type ProviderItem } from "../settings/model-provider/types";

const THINKING_LEVELS: Array<{ value: PromptEnhancementSettings["thinkingLevel"]; label: string }> = [
  { value: "off", label: "关闭" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

export function PromptEnhancementCard() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<PromptEnhancementSettings | null>(null);
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [templateProblem, setTemplateProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadPromptEnhancementSettings().then((s) => {
      if (!cancelled) setSettings(s);
    });
    void loadProvidersConfigFromDisk().then((list) => {
      if (!cancelled) setProviders(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const modelOptions = useMemo(() => {
    const out: Array<{ providerId: string; modelId: string; label: string; providerName: string }> = [];
    for (const p of providers) {
      if (!p.enabled) continue;
      for (const m of p.models) {
        if (!m.enabled) continue;
        out.push({ providerId: p.id, modelId: m.id, label: `${p.name} / ${m.name || m.id}`, providerName: p.name });
      }
    }
    return out;
  }, [providers]);

  if (!settings) {
    return (
      <div className="flex items-center justify-center py-16 text-xs text-[var(--text-dim)]">
        <Loader2 className="mr-2 size-4 animate-spin" />
        {t("enhanceLoading")}
      </div>
    );
  }

  const pinnedExists = modelOptions.some(
    (o) => o.providerId === settings.providerId && o.modelId === settings.modelId,
  );
  const pinnedUnavailable = settings.providerId !== "" && settings.modelId !== "" && !pinnedExists;

  const patch = (patch: Partial<PromptEnhancementSettings>) => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
    setSaved(false);
  };

  const patchTemplate = (text: string) => {
    patch({ userTemplate: text });
    setTemplateProblem(text.trim() ? promptEnhancementTemplateError(text) : null);
    setSaved(false);
  };

  const handleSave = async () => {
    if (templateProblem) return;
    setSaving(true);
    try {
      await savePromptEnhancementSettings(settings);
      // 保存时若模板与内置默认完全一致则清空覆盖（对齐 PI：默认模板改进仍能触达用户）
      if (settings.customTemplate && settings.userTemplate === DEFAULT_PROMPT_ENHANCEMENT_USER_TEMPLATE) {
        const cleared = await savePromptEnhancementSettings({ ...settings, customTemplate: false, userTemplate: "" });
        setSettings(cleared);
      } else {
        setSettings(settings);
      }
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <h2 className="mb-6 text-xl font-semibold">{t("enhanceTitle")}</h2>

      {/* 自定义模板 */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">{t("enhanceCustomTemplate")}</div>
            <p className="text-[11px] text-[var(--text-dim)]">{t("enhanceCustomTemplateHint")}</p>
          </div>
          <input
            type="checkbox"
            checked={settings.customTemplate}
            onChange={(e) => patch({ customTemplate: e.target.checked })}
            className="size-4 accent-[var(--brand)]"
          />
        </div>
        {settings.customTemplate ? (
          <div className="space-y-2">
            <Textarea
              variant="plain"
              rows={8}
              value={settings.userTemplate}
              placeholder={DEFAULT_PROMPT_ENHANCEMENT_USER_TEMPLATE}
              className="font-mono text-xs leading-relaxed"
              onChange={(e) => patchTemplate(e.currentTarget.value)}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  patchTemplate(
                    settings.userTemplate
                      ? `${settings.userTemplate} ${PROMPT_ENHANCEMENT_DRAFT_VARIABLE}`
                      : PROMPT_ENHANCEMENT_DRAFT_VARIABLE,
                  )
                }
              >
                {t("enhanceInsertDraftVar")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => patchTemplate("")}>
                <Undo2 className="size-3.5" />
                {t("enhanceRestoreDefault")}
              </Button>
              <span className="text-[11px] text-[var(--text-dim)]">
                {settings.userTemplate.length}/{PROMPT_ENHANCEMENT_MAX_TEMPLATE_CHARS}
              </span>
              {templateProblem ? <span className="text-[11px] text-red-500">{templateProblem}</span> : null}
            </div>
          </div>
        ) : null}
      </div>

      {/* 增强模型 + 推理等级 */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-4 space-y-4">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-[var(--text-dim)]">{t("enhanceModel")}</label>
          <Select
            value={settings.providerId && settings.modelId ? `${settings.providerId}/${settings.modelId}` : "follow"}
            onValueChange={(v) => {
              if (v === "follow") patch({ providerId: "", modelId: "" });
              else {
                const [providerId, ...rest] = v.split("/");
                patch({ providerId, modelId: rest.join("/") });
              }
            }}
          >
            <SelectTrigger className="h-9 w-full rounded-lg px-3 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="follow">{t("enhanceFollowComposer")}</SelectItem>
              {modelOptions.map((o) => (
                <SelectItem key={`${o.providerId}/${o.modelId}`} value={`${o.providerId}/${o.modelId}`}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {pinnedUnavailable ? <p className="text-[11px] text-amber-500">{t("enhancePinnedUnavailable")}</p> : null}
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-[var(--text-dim)]">{t("enhanceThinkingLevel")}</label>
          <Select
            value={settings.thinkingLevel}
            onValueChange={(v) => patch({ thinkingLevel: v as PromptEnhancementSettings["thinkingLevel"] })}
          >
            <SelectTrigger className="h-9 w-full rounded-lg px-3 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THINKING_LEVELS.map((lv) => (
                <SelectItem key={lv.value} value={lv.value}>
                  {lv.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button size="sm" disabled={saving || !!templateProblem} onClick={() => void handleSave()}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
          {t("sttSave")}
        </Button>
        {saved ? <span className="text-xs text-emerald-600 dark:text-emerald-400">{t("enhanceSaved")}</span> : null}
      </div>

      <p className="text-[11px] leading-relaxed text-[var(--text-dim)]">{t("enhanceHint")}</p>
    </div>
  );
}
