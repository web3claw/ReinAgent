/**
 * 场景默认模型区块（ROADMAP ⑪ 方案 A）：设置 ▸ 通用的一张卡片，统一读写
 * 四个场景的模型绑定——背后各写各的现有存储（零迁移）：
 * chat=settings.json 全局默认 / embedding=hubSettings.knowledge /
 * memoryOrganizer=hubSettings.memory.organizerModel / noteAi=kv（新键）。
 * 未配置或绑定失效（服务商/模型被删禁）→ 回退聊天默认并明示（no-fallback）。
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation, type TranslationKey } from "../../i18n";
import { useSettings } from "../../lib/settings/useSettings";
import { kvGetJSON, kvSetJSON } from "../../lib/storage/db";
import {
  GRAPH_MODEL_KV_KEY,
  WIKI_MODEL_KV_KEY,
  NOTEAI_MODEL_KV_KEY,
  SCENARIO_META,
  chatDefaultOf,
  resolveScenario,
  validateBinding,
  type BindingInvalidReason,
  type ScenarioBinding,
  type ScenarioId,
} from "../../lib/settings/scenarioModels";
import { loadProvidersConfigFromDisk, type ProviderItem } from "./model-provider/types";
import { useHubSettings } from "../../store/hubSettingsStore";
import type { ProviderType } from "../../lib/providers/catalog";

/** i18n 值插值（对齐 BranchSwitcher 的 fmt 惯例） */
const fmt = (template: string, params: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? ""));

const INVALID_REASON_KEYS: Record<BindingInvalidReason, TranslationKey> = {
  providerMissing: "scenarioInvalidProviderMissing",
  providerDisabled: "scenarioInvalidProviderDisabled",
  modelMissing: "scenarioInvalidModelMissing",
  modelDisabled: "scenarioInvalidModelDisabled",
};

export function ScenarioModelsSection() {
  const { t } = useTranslation();
  const { settings, update } = useSettings();
  const hubSettings = useHubSettings((s) => s.settings);
  const setHubSettings = useHubSettings((s) => s.setSettings);
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [noteAiBinding, setNoteAiBinding] = useState<ScenarioBinding | null>(null);
  const [graphBinding, setGraphBinding] = useState<ScenarioBinding | null>(null);
  const [wikiBinding, setWikiBinding] = useState<ScenarioBinding | null>(null);

  useEffect(() => {
    void loadProvidersConfigFromDisk(settings)
      .then((list) => setProviders(list))
      .catch((err) => console.warn("[scenario-models] loadProvidersConfigFromDisk failed:", err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    for (const [key, setter] of [
      [NOTEAI_MODEL_KV_KEY, setNoteAiBinding],
      [GRAPH_MODEL_KV_KEY, setGraphBinding],
      [WIKI_MODEL_KV_KEY, setWikiBinding],
    ] as const) {
      const saved = kvGetJSON<ScenarioBinding>(key);
      if (saved && typeof saved.providerId === "string" && typeof saved.modelId === "string") {
        setter(saved);
      }
    }
  }, []);

  const chatDefault = useMemo(() => chatDefaultOf(settings, providers), [settings, providers]);
  const enabledProviders = useMemo(() => providers.filter((p) => p.enabled !== false), [providers]);

  const embeddingBinding: ScenarioBinding | null =
    hubSettings.knowledge.providerId && hubSettings.knowledge.modelId
      ? { providerId: hubSettings.knowledge.providerId, modelId: hubSettings.knowledge.modelId }
      : null;
  const organizerBinding: ScenarioBinding | null =
    hubSettings.memory.organizerModel?.customProviderId && hubSettings.memory.organizerModel?.model
      ? {
          providerId: hubSettings.memory.organizerModel.customProviderId,
          modelId: hubSettings.memory.organizerModel.model,
        }
      : null;

  // 各场景绑定写入（分发到各自现有存储）
  const writeBinding = (scenario: ScenarioId, binding: ScenarioBinding | null) => {
    if (scenario === "chat") return; // chat 行由专用 handler 写 settings
    if (scenario === "embedding") {
      setHubSettings((prev) => ({
        ...prev,
        knowledge: binding
          ? { ...prev.knowledge, providerId: binding.providerId, modelId: binding.modelId }
          : { ...prev.knowledge, providerId: "", modelId: "" },
      }));
      return;
    }
    if (scenario === "memoryOrganizer") {
      setHubSettings((prev) => ({
        ...prev,
        memory: {
          ...prev.memory,
          organizerModel: binding ? { customProviderId: binding.providerId, model: binding.modelId } : null,
        },
      }));
      return;
    }
    // noteAi / graph：kv 持久（消费端打开时读取）
    if (scenario === "noteAi") {
      setNoteAiBinding(binding);
      kvSetJSON(NOTEAI_MODEL_KV_KEY, binding ?? { providerId: "", modelId: "" });
    } else if (scenario === "graph") {
      setGraphBinding(binding);
      kvSetJSON(GRAPH_MODEL_KV_KEY, binding ?? { providerId: "", modelId: "" });
    } else {
      setWikiBinding(binding);
      kvSetJSON(WIKI_MODEL_KV_KEY, binding ?? { providerId: "", modelId: "" });
    }
  };

  const scenarios: {
    id: ScenarioId;
    binding: ScenarioBinding | null;
    allowModelNotListed?: boolean;
  }[] = [
    { id: "chat", binding: chatDefault },
    { id: "embedding", binding: embeddingBinding, allowModelNotListed: true },
    { id: "memoryOrganizer", binding: organizerBinding },
    { id: "noteAi", binding: noteAiBinding },
    { id: "graph", binding: graphBinding },
    { id: "wiki", binding: wikiBinding },
  ];

  return (
    <div className="p-4 bg-[var(--bg-elev)] rounded-xl border border-[var(--border)] space-y-4">
      <div>
        <div className="font-medium">{t("scenarioModelsTitle")}</div>
        <div className="text-sm text-[var(--text-dim)]">{t("scenarioModelsDesc")}</div>
      </div>
      {scenarios.map(({ id, binding, allowModelNotListed }) => {
        const resolution = resolveScenario({ scenario: id, providers, chatDefault, binding, allowModelNotListed });
        const isChat = id === "chat";
        const selectedProvider = enabledProviders.find((p) => p.id === binding?.providerId) ?? null;
        const models = selectedProvider?.models?.filter((m) => m.enabled !== false) ?? [];
        return (
          <div key={id} className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">{t(SCENARIO_META[id].labelKey as TranslationKey)}</div>
                <div className="text-xs text-[var(--text-dim)]">{t(SCENARIO_META[id].descKey as TranslationKey)}</div>
              </div>
              <div className="flex items-center gap-1.5">
                <select
                  value={binding?.providerId ?? ""}
                  disabled={isChat && !enabledProviders.length}
                  onChange={(e) => {
                    const providerId = e.target.value;
                    if (isChat) {
                      // chat = 全局默认指针：换服务商重置 modelId（回 defaultModelId 链）
                      update({ provider: providerId as ProviderType, modelId: "" });
                      return;
                    }
                    writeBinding(id, providerId ? { providerId, modelId: "" } : null);
                  }}
                  aria-label={t(SCENARIO_META[id].labelKey as TranslationKey)}
                  className="max-w-40 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-xs text-[var(--text)] focus:outline-none"
                >
                  <option value="">{t("scenarioFollowChat")}</option>
                  {enabledProviders.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name || p.id}
                    </option>
                  ))}
                </select>
                {allowModelNotListed ? (
                  // embedding 模型多为手填（不依赖 /models 列表）：datalist 可选可输
                  <input
                    list={`scenario-models-${id}`}
                    value={binding?.modelId ?? ""}
                    disabled={!binding?.providerId}
                    placeholder={t("scenarioModelPlaceholder")}
                    onChange={(e) => writeBinding(id, binding?.providerId ? { providerId: binding.providerId, modelId: e.target.value } : null)}
                    className="w-36 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-xs text-[var(--text)] focus:outline-none disabled:opacity-50"
                  />
                ) : (
                  <select
                    value={binding?.modelId ?? ""}
                    disabled={!binding?.providerId}
                    onChange={(e) => writeBinding(id, binding?.providerId ? { providerId: binding.providerId, modelId: e.target.value } : null)}
                    aria-label={t("scenarioModelPlaceholder")}
                    className="max-w-44 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-xs text-[var(--text)] focus:outline-none disabled:opacity-50"
                  >
                    <option value="">—</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name || m.id}
                      </option>
                    ))}
                  </select>
                )}
                {allowModelNotListed ? (
                  <datalist id={`scenario-models-${id}`}>
                    {models.map((m) => (
                      <option key={m.id} value={m.id} />
                    ))}
                  </datalist>
                ) : null}
              </div>
            </div>
            {/* 状态说明行：未配置跟随默认 / 绑定失效回退 / 生效展示 */}
            <div className="text-xs">
              {isChat ? (
                <span className="text-[var(--text-dim)]">
                  {resolution.effective
                    ? fmt(t("scenarioChatEffective"), { model: `${resolution.effective.providerId} / ${resolution.effective.modelId}` })
                    : t("scenarioNoDefault")}
                </span>
              ) : resolution.invalidReason ? (
                <span className="text-[var(--warn-text)]">
                  {t(INVALID_REASON_KEYS[resolution.invalidReason])} · {fmt(t("scenarioFallbackNow"), { model: resolution.effective ? `${resolution.effective.providerId} / ${resolution.effective.modelId}` : "—" })}
                </span>
              ) : !binding ? (
                <span className="text-[var(--text-dim)]">
                  {resolution.effective ? fmt(t("scenarioFollowChatWith"), { model: `${resolution.effective.providerId} / ${resolution.effective.modelId}` }) : t("scenarioNoDefault")}
                </span>
              ) : (
                <span className="text-[var(--text-dim)]">{t("scenarioBound")}</span>
              )}
            </div>
          </div>
        );
      })}
      <p className="text-xs text-[var(--text-dim)]">{t("scenarioEmbeddingNote")}</p>
    </div>
  );
}

/** validateBinding 单独暴露给需要即时校验的调用方（保持模块导出面最小） */
export { validateBinding };
