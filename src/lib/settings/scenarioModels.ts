/**
 * 场景化默认模型（ROADMAP ⑪，方案 A：统一设置区「场景默认模型」读写各场景现有存储，
 * 零迁移——不新建统一键、不动四个消费链路）：
 * - chat            → settings.json 全局默认（settings.provider + settings.modelId）
 * - embedding       → hubSettings.knowledge { providerId, modelId }（知识库 embedding 绑定）
 * - memoryOrganizer → hubSettings.memory.organizerModel { customProviderId, model }
 * - noteAi          → kv `reinagent-noteai-model` { providerId, modelId }（新增持久键，
 *                     顺带修复笔记 AI 模型选择不持久的历史缺陷）
 * 解析铁律（no-fallback）：场景未配置/绑定失效（服务商或模型被删/禁用）→ 回退聊天默认，
 * UI 明示回退与失效原因，绝不静默发往不存在的模型。
 */

export type ScenarioId = "chat" | "embedding" | "memoryOrganizer" | "noteAi" | "graph";

export interface ScenarioBinding {
  providerId: string;
  modelId: string;
}

/** 绑定失效原因（UI 提示用） */
export type BindingInvalidReason =
  | "providerMissing"
  | "providerDisabled"
  | "modelMissing"
  | "modelDisabled";

/** 服务商/模型最小查找面（ProviderItem 的结构子集，便于单测构造） */
export interface ProviderModelLookup {
  id: string;
  name?: string;
  enabled?: boolean;
  defaultModelId?: string;
  models?: { id: string; name?: string; enabled?: boolean }[] | null;
}

/** 聊天全局默认解析：settings.provider + settings.modelId，modelId 缺省回该服务商 defaultModelId */
export function chatDefaultOf(
  settings: { provider?: string; modelId?: string },
  providers: ProviderModelLookup[],
): ScenarioBinding | null {
  const providerId = (settings.provider ?? "").trim();
  if (!providerId) return null;
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) return { providerId, modelId: (settings.modelId ?? "").trim() };
  const models = provider.models ?? [];
  // defaultModelId 仅在存在且启用时才可作回退（被删/禁用则跳过，取首个启用模型）
  const def = provider.defaultModelId ?? "";
  const defUsable = def !== "" && models.some((m) => m.id === def && m.enabled !== false);
  const modelId =
    (settings.modelId ?? "").trim() ||
    (defUsable ? def : "") ||
    models.find((m) => m.enabled !== false)?.id ||
    "";
  if (!modelId) return null;
  return { providerId, modelId };
}

/** 校验绑定有效性：服务商存在且启用、模型存在且启用（embedding 类手填模型除外，由调用方决定是否跳过模型级校验） */
export function validateBinding(
  binding: ScenarioBinding | null | undefined,
  providers: ProviderModelLookup[],
  opts?: { allowModelNotListed?: boolean },
): BindingInvalidReason | null {
  if (!binding) return null;
  const provider = providers.find((p) => p.id === binding.providerId);
  if (!provider) return "providerMissing";
  if (provider.enabled === false) return "providerDisabled";
  if (!opts?.allowModelNotListed) {
    const model = provider.models?.find((m) => m.id === binding.modelId);
    if (!model) return "modelMissing";
    if (model.enabled === false) return "modelDisabled";
  }
  return null;
}

export interface ScenarioResolution {
  scenario: ScenarioId;
  /** 解析后的实际生效绑定（回退后可能是聊天默认；全空 = 无可用默认） */
  effective: ScenarioBinding | null;
  /** 是否发生了回退（未配置或绑定失效） */
  fallbackUsed: boolean;
  /** 绑定存在但失效时的原因（未配置为 null） */
  invalidReason: BindingInvalidReason | null;
}

/**
 * 统一解析：场景绑定 → 校验 → 失效/未配置回退聊天默认。
 * embedding 场景模型多为手填（不依赖 /models 列表），调用方传 allowModelNotListed。
 */
export function resolveScenario(input: {
  scenario: ScenarioId;
  providers: ProviderModelLookup[];
  chatDefault: ScenarioBinding | null;
  binding: ScenarioBinding | null | undefined;
  allowModelNotListed?: boolean;
}): ScenarioResolution {
  const invalidReason = validateBinding(input.binding, input.providers, {
    allowModelNotListed: input.allowModelNotListed,
  });
  if (input.binding && !invalidReason) {
    return { scenario: input.scenario, effective: input.binding, fallbackUsed: false, invalidReason: null };
  }
  return {
    scenario: input.scenario,
    effective: input.chatDefault,
    fallbackUsed: true,
    invalidReason,
  };
}

/** noteAi 持久键（kv `reinagent-noteai-model`，存 JSON；空/清空 = 跟随聊天默认） */
export const NOTEAI_MODEL_KV_KEY = "reinagent-noteai-model";

/** graph 抽取持久键（kv `reinagent-graph-model`；空 = 跟随聊天默认） */
export const GRAPH_MODEL_KV_KEY = "reinagent-graph-model";

/** NoteEditor 的 "providerId/modelId" 字符串 key ⇄ 结构化绑定互转（笔记页本地态格式兼容） */
export function bindingToNoteKey(binding: ScenarioBinding | null | undefined): string {
  if (!binding || !binding.providerId) return "";
  return `${binding.providerId}/${binding.modelId}`;
}

export function noteKeyToBinding(key: string): ScenarioBinding | null {
  const trimmed = key.trim();
  if (!trimmed) return null;
  const idx = trimmed.indexOf("/");
  if (idx <= 0 || idx === trimmed.length - 1) return null;
  return { providerId: trimmed.slice(0, idx), modelId: trimmed.slice(idx + 1) };
}

/** 场景展示元数据（i18n 键，zh/en 双语均定义） */
export const SCENARIO_META: Record<ScenarioId, { labelKey: string; descKey: string }> = {
  chat: { labelKey: "scenarioChatLabel", descKey: "scenarioChatDesc" },
  embedding: { labelKey: "scenarioEmbeddingLabel", descKey: "scenarioEmbeddingDesc" },
  memoryOrganizer: { labelKey: "scenarioOrganizerLabel", descKey: "scenarioOrganizerDesc" },
  noteAi: { labelKey: "scenarioNoteAiLabel", descKey: "scenarioNoteAiDesc" },
  graph: { labelKey: "scenarioGraphLabel", descKey: "scenarioGraphDesc" },
};

/** 场景绑定 → one-shot 调用配置（graph 抽取等独立调用链用）：
 * 绑定有效用绑定；否则回退聊天默认（settings 全局指针）；全无 → null（调用方明示未配置）。 */
export function scenarioBindingToProviderConfig(
  binding: ScenarioBinding | null | undefined,
  providers: (ProviderModelLookup & { apiKey?: string; baseUrl?: string; apiFormat?: string })[],
  fallback: { provider?: string; modelId?: string; apiKey?: string; baseUrl?: string },
): { config: { provider: string; apiKey: string; modelId: string; baseUrl: string; apiFormat?: string } | null; fallbackUsed: boolean } {
  const resolve = (providerId: string, modelId: string) => {
    const p = providers.find((x) => x.id === providerId);
    if (!p || p.enabled === false || !modelId) return null;
    return {
      provider: p.id,
      apiKey: p.apiKey ?? "",
      modelId,
      baseUrl: p.baseUrl ?? "",
      apiFormat: p.apiFormat,
    };
  };
  if (binding) {
    const cfg = resolve(binding.providerId, binding.modelId);
    if (cfg) return { config: cfg, fallbackUsed: false };
  }
  const chat = chatDefaultOf(fallback, providers);
  if (!chat) return { config: null, fallbackUsed: true };
  const cfg = resolve(chat.providerId, chat.modelId) ?? {
    provider: chat.providerId,
    apiKey: fallback.apiKey ?? "",
    modelId: chat.modelId,
    baseUrl: fallback.baseUrl ?? "",
  };
  return { config: cfg, fallbackUsed: true };
}
