/**
 * 模型/Provider 配置解析（移植自 PI-Desktop packages/shared/src/model-config-import.ts，
 * 裁剪掉 PI 的目录/预设目录依赖，产物直接对齐本方 ProviderItem）。
 *
 * 5 个来源：claude-code / opencode / codex / pi / cc-switch。
 * 密钥留在 Draft（应用内单进程，无跨进程边界）；公共候选剥掉密钥只给 hasSecret。
 */

export type ModelConfigImportSource = "claude-code" | "opencode" | "codex" | "pi" | "cc-switch";

/** 本方 ProviderItem["apiFormat"]。 */
export type ProviderApiFormat =
  | "openai-chat-completions"
  | "openai-completions"
  | "anthropic-messages"
  | "openai-responses"
  | "google-generative-ai";

export interface ModelConfigImportDraft {
  source: ModelConfigImportSource;
  externalId: string;
  name: string;
  baseUrl: string | null;
  apiFormat: ProviderApiFormat;
  modelIds: string[];
  hasSecret: boolean;
  secretValue?: string;
}

export type ModelConfigImportCandidate = Omit<ModelConfigImportDraft, "secretValue">;

export type ModelConfigImportRunResult = { imported: number; skipped: number; failed: number };

export type ModelConfigImportEnv = Record<string, string | undefined>;

/** CC Switch 的一行 provider（~/.cc-switch/cc-switch.db 或 legacy config.json）。 */
export type CcSwitchProviderRow = {
  id: string;
  appType: string;
  name: string;
  settingsConfig: unknown;
};

const MAX_MODELS_PER_PROVIDER = 64;
const MAX_NAME_LENGTH = 80;

/** 外部 apiStyle 别名 → 本方 apiFormat（PI 无对应项的按最接近协议映射）。 */
const API_FORMAT_ALIASES: Record<string, ProviderApiFormat> = {
  chat: "openai-chat-completions",
  chat_completions: "openai-chat-completions",
  "chat-completions": "openai-chat-completions",
  completions: "openai-chat-completions",
  "openai-chat": "openai-chat-completions",
  "openai-completions": "openai-chat-completions",
  openai_completions: "openai-chat-completions",
  responses: "openai-responses",
  "openai-responses": "openai-responses",
  openai_responses: "openai-responses",
  openai_codex_responses: "openai-responses",
  "openai-codex-responses": "openai-responses",
  "openai-codex": "openai-responses",
  anthropic: "anthropic-messages",
  anthropic_messages: "anthropic-messages",
  "anthropic-messages": "anthropic-messages",
  pi_messages: "anthropic-messages",
  "pi-messages": "anthropic-messages",
  google: "google-generative-ai",
  google_generative_ai: "google-generative-ai",
  "google-generative-ai": "google-generative-ai",
  opencode_go: "openai-chat-completions",
  "opencode-go": "openai-chat-completions",
};

export function resolveApiFormat(raw?: string | null): ProviderApiFormat | undefined {
  if (!raw) return undefined;
  const key = raw.trim().toLowerCase().replace(/\s+/g, "-");
  return API_FORMAT_ALIASES[key] ?? API_FORMAT_ALIASES[key.replace(/_/g, "-")];
}

export function normalizeEndpointUrl(url?: string | null): string {
  return (url ?? "").trim().replace(/\/+$/, "");
}

/** 供 UI 列表用的公共候选（剥密钥）。 */
export function publicModelConfigCandidate(draft: ModelConfigImportDraft): ModelConfigImportCandidate {
  const { secretValue: _secretValue, ...rest } = draft;
  return rest;
}

/** 确定性 provider id：重复导入按 id 去重。 */
export function modelConfigImportId(source: ModelConfigImportSource, externalId: string): string {
  return `import-${source}-${externalId}`;
}

// ---------- 去重（endpoint + 协议 + 凭证） ----------

export function existingProviderMatchKey(input: {
  baseUrl?: string | null;
  apiFormat?: string | null;
}): string {
  const url = normalizeEndpointUrl(input.baseUrl);
  const style = (input.apiFormat ?? "").trim().toLowerCase();
  return `${url}|${style}`;
}

export function draftMatchesExisting(
  draft: Pick<ModelConfigImportDraft, "baseUrl" | "apiFormat" | "secretValue" | "hasSecret">,
  existing: Array<{ baseUrl?: string | null; apiFormat?: string | null; apiKey?: string | null }>,
): boolean {
  const key = existingProviderMatchKey(draft);
  const draftSecret = sanitizeSecret(draft.secretValue);
  return existing.some((row) => {
    if (existingProviderMatchKey(row) !== key) return false;
    const rowSecret = sanitizeSecret(row.apiKey);
    if (draftSecret || rowSecret) return draftSecret === rowSecret;
    return draft.hasSecret !== true;
  });
}

// ---------- JSON / JSONC ----------

export function parseJsonDocument(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // fall through to JSONC
  }
  try {
    return JSON.parse(stripTrailingCommas(stripJsonc(text))) as unknown;
  } catch {
    return null;
  }
}

/** 剥掉 JSON 字符串之外的行/块注释（opencode.jsonc 常见）。 */
function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) inString = false;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 丢弃与收括号之间只有空白的逗号（JSONC 编辑器遗留；JSON.parse 会整文档拒绝）。 */
function stripTrailingCommas(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) inString = false;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === "}" || text[j] === "]") {
        i += 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

// ---------- 各来源解析 ----------

export function parseClaudeCodeModelConfig(
  settings: unknown,
  localSettings?: unknown,
): ModelConfigImportDraft[] {
  const global = asRecord(settings) ?? {};
  const local = asRecord(localSettings) ?? {};
  const env = { ...stringMap(global.env), ...stringMap(local.env) };
  const baseUrl = firstString(env.ANTHROPIC_BASE_URL, env.ANTHROPIC_API_URL);
  const secret = firstSecret(env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN);
  const modelIds = uniqueModelIds([
    firstString(local.model, global.model),
    env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    env.ANTHROPIC_MODEL,
  ]);
  if (modelIds.length === 0) return [];
  if (!baseUrl && !secret) return [];
  const draft = finishDraft({
    source: "claude-code",
    externalId: "default",
    name: "Claude Code",
    baseUrl,
    apiFormat: "anthropic-messages",
    modelIds,
    secretValue: secret,
  });
  return draft ? [draft] : [];
}

export function parseOpenCodeModelConfig(
  config: unknown,
  auth?: unknown,
  env: ModelConfigImportEnv = {},
): ModelConfigImportDraft[] {
  const root = asRecord(config) ?? {};
  const providers = asRecord(root.provider) ?? asRecord(root.providers) ?? {};
  const authMap = asRecord(auth) ?? {};
  const defaultModel = firstString(root.model);
  const drafts: ModelConfigImportDraft[] = [];
  for (const [id, raw] of Object.entries(providers)) {
    const record = asRecord(raw);
    if (!record) continue;
    const options = asRecord(record.options) ?? {};
    const baseUrl = firstString(options.baseURL, options.baseUrl, record.baseURL, record.baseUrl);
    const apiFormat =
      resolveApiFormat(firstString(record.api, options.api, record.apiStyle)) ?? "openai-chat-completions";
    const modelIds = uniqueModelIds([
      ...modelIdsFromUnknown(record.models),
      ...(modelIdsFromUnknown(record.models).length === 0
        ? [defaultModelForProvider(id, defaultModel)]
        : []),
    ]);
    if (modelIds.length === 0) continue;
    const secret = firstSecret(
      resolveSecret(options.apiKey ?? record.apiKey, env),
      authApiKey(authMap[id]),
      secretFromAuthHeader(options.headers ?? record.headers),
    );
    const draft = finishDraft({
      source: "opencode",
      externalId: id,
      name: firstString(record.name, record.label) || id,
      baseUrl,
      apiFormat,
      modelIds,
      secretValue: secret,
    });
    if (draft) drafts.push(draft);
  }
  return drafts;
}

export function parseCodexModelConfig(
  toml: string,
  env: ModelConfigImportEnv = {},
): ModelConfigImportDraft[] {
  const extracted = parseTomlSubset(toml);
  const drafts: ModelConfigImportDraft[] = [];
  const defaultModel = stringValue(extracted.root.model);
  for (const [tableKey, fields] of extracted.tables) {
    if (!tableKey.startsWith("model_providers.")) continue;
    const id = tableKey.slice("model_providers.".length);
    if (!id) continue;
    if (
      fields.requires_openai_auth === true &&
      !stringValue(fields.env_key) &&
      !stringValue(fields.api_key)
    ) {
      continue;
    }
    const baseUrl = stringValue(fields.base_url) ?? stringValue(fields.baseUrl);
    const envKey = stringValue(fields.env_key) ?? stringValue(fields.envKey);
    const secret = firstSecret(
      resolveSecret(stringValue(fields.api_key) ?? stringValue(fields.apiKey), env),
      envKey ? env[envKey] : undefined,
    );
    const wire = stringValue(fields.wire_api) ?? stringValue(fields.wireApi);
    const modelIds = uniqueModelIds([defaultModel, ...splitCsv(stringValue(fields.models))]);
    if (modelIds.length === 0) continue;
    const draft = finishDraft({
      source: "codex",
      externalId: id,
      name: stringValue(fields.name) || id,
      baseUrl,
      apiFormat: resolveApiFormat(wire) ?? "openai-chat-completions",
      modelIds,
      secretValue: secret,
    });
    if (draft) drafts.push(draft);
  }
  return drafts;
}

export function parsePiModelConfig(
  modelsJson: unknown,
  env: ModelConfigImportEnv = {},
): ModelConfigImportDraft[] {
  const root = asRecord(modelsJson) ?? {};
  const providers = asRecord(root.providers) ?? (looksLikeProviderMap(root) ? root : {});
  const drafts: ModelConfigImportDraft[] = [];
  for (const [id, raw] of Object.entries(providers)) {
    if (id === "providers") continue;
    const record = asRecord(raw);
    if (!record) continue;
    const baseUrl = firstString(record.baseUrl, record.baseURL, record.url);
    const apiFormat = resolveApiFormat(firstString(record.api, record.apiStyle, record.type)) ?? "openai-chat-completions";
    const headers = asRecord(record.headers);
    const secret = firstSecret(
      resolveSecret(record.apiKey ?? record.api_key, env),
      secretFromAuthHeader(headers),
    );
    const modelEntries = Array.isArray(record.models) ? record.models : [];
    const modelIds = uniqueModelIds(modelEntries.map(modelIdFromUnknown));
    if (modelIds.length === 0) continue;
    const draft = finishDraft({
      source: "pi",
      externalId: id,
      name: firstString(record.name, record.label) || id,
      baseUrl,
      apiFormat,
      modelIds,
      secretValue: secret,
    });
    if (draft) drafts.push(draft);
  }
  return drafts;
}

const CC_SWITCH_APP_TYPES = [
  "claude",
  "claude-desktop",
  "codex",
  "gemini",
  "grokbuild",
  "opencode",
  "openclaw",
  "hermes",
  "pi",
] as const;

/** 解析 CC Switch legacy `~/.cc-switch/config.json`（MultiAppConfig）。 */
export function parseCcSwitchConfigJson(document: unknown): CcSwitchProviderRow[] {
  const root = asRecord(document);
  if (!root) return [];
  const rows: CcSwitchProviderRow[] = [];
  for (const appType of CC_SWITCH_APP_TYPES) {
    const app = asRecord(root[appType]);
    const providers = asRecord(app?.providers);
    if (!providers) continue;
    for (const [id, raw] of Object.entries(providers)) {
      const record = asRecord(raw);
      if (!record) continue;
      rows.push({
        id: firstString(record.id) || id,
        appType,
        name: firstString(record.name) || id,
        settingsConfig: record.settingsConfig ?? record.settings_config ?? record,
      });
    }
  }
  return rows;
}

export function parseCcSwitchProviders(
  rows: CcSwitchProviderRow[],
  env: ModelConfigImportEnv = {},
): ModelConfigImportDraft[] {
  const drafts: ModelConfigImportDraft[] = [];
  for (const row of rows) {
    drafts.push(...parseCcSwitchProvider(row, env));
  }
  return drafts;
}

function parseCcSwitchProvider(
  row: CcSwitchProviderRow,
  env: ModelConfigImportEnv,
): ModelConfigImportDraft[] {
  const appType = row.appType.trim().toLowerCase();
  if (appType === "claude" || appType === "claude-desktop") {
    const parsed = parseClaudeCodeModelConfig(row.settingsConfig);
    if (parsed.length > 0) return retagCcSwitch(row, parsed);
    const settings = asRecord(row.settingsConfig);
    const envMap = stringMap(settings?.env);
    const secret = firstSecret(envMap.ANTHROPIC_API_KEY, envMap.ANTHROPIC_AUTH_TOKEN);
    const baseUrl = firstString(envMap.ANTHROPIC_BASE_URL, envMap.ANTHROPIC_API_URL);
    if (!baseUrl && !secret) return [];
    const draft = finishDraft({
      source: "cc-switch",
      externalId: `${row.appType}:${row.id}`,
      name: row.name || row.id,
      baseUrl,
      apiFormat: "anthropic-messages",
      modelIds: ["default"],
      secretValue: secret,
    });
    return draft ? [draft] : [];
  }
  if (appType === "opencode" || appType === "hermes") {
    return retagCcSwitch(
      row,
      parseOpenCodeModelConfig({ provider: { [row.id]: row.settingsConfig } }, undefined, env),
    );
  }
  if (appType === "pi") {
    // Pi 的权威配置是它自己的 models.json；CC Switch 只存一次性迁移快照，
    // 交给 pi 扫描源以真源为准（对齐 PI #588）。
    return [];
  }
  if (appType === "codex" || appType === "grokbuild") {
    return parseCcSwitchTomlApp(row, env, appType === "codex" ? "openai-responses" : "openai-chat-completions");
  }
  if (appType === "gemini") {
    return parseCcSwitchGemini(row, env);
  }
  return [];
}

function parseCcSwitchTomlApp(
  row: CcSwitchProviderRow,
  env: ModelConfigImportEnv,
  fallbackFormat: ProviderApiFormat,
): ModelConfigImportDraft[] {
  const settings = asRecord(row.settingsConfig) ?? {};
  const toml = typeof settings.config === "string" ? settings.config : "";
  const auth = asRecord(settings.auth) ?? {};
  const authSecret = firstSecret(firstString(auth.OPENAI_API_KEY, auth.api_key));
  const parsed = parseCodexModelConfig(toml, env);
  const withAuth = parsed.map((draft) => ({
    ...draft,
    secretValue: draft.secretValue ?? authSecret,
    hasSecret: Boolean(draft.secretValue ?? authSecret),
  }));
  if (withAuth.length > 0) return retagCcSwitch(row, withAuth);
  const baseUrl = toml.match(/base_url\s*=\s*"([^"]+)"/)?.[1];
  const model = toml.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1];
  const secret = authSecret;
  if (!baseUrl && !secret) return [];
  const draft = finishDraft({
    source: "cc-switch",
    externalId: `${row.appType}:${row.id}`,
    name: row.name || row.id,
    baseUrl: baseUrl ?? null,
    apiFormat: fallbackFormat,
    modelIds: model ? [model] : ["default"],
    secretValue: secret,
  });
  return draft ? [draft] : [];
}

function parseCcSwitchGemini(
  row: CcSwitchProviderRow,
  env: ModelConfigImportEnv,
): ModelConfigImportDraft[] {
  const settings = asRecord(row.settingsConfig) ?? {};
  const envMap = stringMap(settings.env);
  const config = asRecord(settings.config) ?? {};
  const baseUrl = firstString(
    envMap.GOOGLE_GEMINI_BASE_URL,
    envMap.GEMINI_BASE_URL,
    envMap.GOOGLE_API_BASE,
  );
  const secret = firstSecret(
    resolveSecret(envMap.GEMINI_API_KEY, env),
    resolveSecret(envMap.GOOGLE_API_KEY, env),
  );
  const modelIds = uniqueModelIds([
    firstString(config.model, settings.model, envMap.GEMINI_MODEL, envMap.GOOGLE_MODEL),
  ]);
  if (!baseUrl && !secret) return [];
  const draft = finishDraft({
    source: "cc-switch",
    externalId: `${row.appType}:${row.id}`,
    name: row.name || row.id,
    baseUrl,
    apiFormat: baseUrl ? "openai-chat-completions" : "google-generative-ai",
    modelIds: modelIds.length > 0 ? modelIds : ["default"],
    secretValue: secret,
  });
  return draft ? [draft] : [];
}

function retagCcSwitch(row: CcSwitchProviderRow, drafts: ModelConfigImportDraft[]): ModelConfigImportDraft[] {
  return drafts.map((draft) => ({
    ...draft,
    source: "cc-switch",
    externalId:
      drafts.length === 1
        ? `${row.appType}:${row.id}`
        : `${row.appType}:${row.id}:${draft.externalId}`,
    name: clipName(row.name || draft.name),
  }));
}

type DraftSeed = {
  source: ModelConfigImportSource;
  externalId: string;
  name: string;
  baseUrl?: string | null;
  apiFormat: ProviderApiFormat;
  modelIds: string[];
  secretValue?: string;
};

function finishDraft(seed: DraftSeed): ModelConfigImportDraft | null {
  const modelIds = uniqueModelIds(seed.modelIds).slice(0, MAX_MODELS_PER_PROVIDER);
  if (modelIds.length === 0) return null;
  // 归一化（剥尾斜杠）：写进 provider 的 baseUrl 统一形态，去重键也按此比较
  const trimmedUrl = normalizeEndpointUrl(seed.baseUrl) || null;
  const secret = sanitizeSecret(seed.secretValue);
  return {
    source: seed.source,
    externalId: seed.externalId.trim() || "default",
    name: clipName(seed.name || seed.externalId),
    baseUrl: trimmedUrl,
    apiFormat: seed.apiFormat,
    modelIds,
    hasSecret: Boolean(secret),
    secretValue: secret,
  };
}

function clipName(name: string): string {
  const trimmed = name.replace(/\s+/g, " ").trim();
  if (!trimmed) return "Imported provider";
  return trimmed.length > MAX_NAME_LENGTH ? `${trimmed.slice(0, MAX_NAME_LENGTH - 1)}...` : trimmed;
}

// ---------- 通用小工具 ----------

function resolveSecret(raw: unknown, env: ModelConfigImportEnv): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("env:")) {
    const name = trimmed.slice(4).trim();
    return name ? sanitizeSecret(env[name]) : undefined;
  }
  const braced = trimmed.match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (braced) return sanitizeSecret(env[braced[1]]);
  return sanitizeSecret(trimmed);
}

function isPlaceholderSecret(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(trimmed)) return true;
  if (/your[_-]?api[_-]?key/i.test(trimmed)) return true;
  if (/^changeme$/i.test(trimmed)) return true;
  if (/^x+$/i.test(trimmed)) return true;
  return false;
}

function sanitizeSecret(value?: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || isPlaceholderSecret(trimmed)) return undefined;
  return trimmed;
}

function firstSecret(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    const secret = sanitizeSecret(value);
    if (secret) return secret;
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function uniqueModelIds(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const id = value?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringMap(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === "string" && raw.trim()) out[key] = raw;
  }
  return out;
}

function modelIdsFromUnknown(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(modelIdFromUnknown).filter((id): id is string => !!id);
  const record = asRecord(value);
  if (!record) return [];
  return Object.keys(record).filter((key) => key.trim());
}

function modelIdFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  const record = asRecord(value);
  return firstString(record?.id, record?.model, record?.modelID, record?.modelId);
}

function defaultModelForProvider(providerId: string, model?: string): string | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0) return model;
  const prefix = model.slice(0, slash);
  const id = model.slice(slash + 1);
  return prefix === providerId ? id : undefined;
}

function authApiKey(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const kind = firstString(record.type, record.kind)?.toLowerCase();
  if (kind && kind !== "api" && kind !== "apikey" && kind !== "api_key") return undefined;
  return firstString(record.key, record.apiKey, record.token);
}

function secretFromAuthHeader(headers: unknown): string | undefined {
  const record = asRecord(headers);
  const value = firstString(
    record?.Authorization,
    record?.authorization,
    record?.["x-api-key"],
    record?.["X-Api-Key"],
  );
  if (!value) return undefined;
  const bearer = value.match(/^Bearer\s+(.+)$/i);
  return sanitizeSecret(bearer ? bearer[1] : value);
}

function looksLikeProviderMap(root: Record<string, unknown>): boolean {
  return Object.values(root).some((value) => {
    const record = asRecord(value);
    return Boolean(record && (record.baseUrl || record.baseURL || record.models || record.api));
  });
}

function splitCsv(value?: string): string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function stringValue(value: TomlValue | undefined): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

type TomlValue = string | number | boolean;

type TomlExtract = {
  root: Record<string, TomlValue>;
  tables: Map<string, Record<string, TomlValue>>;
};

/** Codex `config.toml` 极简读取器：根键 + `[table]` 赋值；表数组与内联表忽略。 */
export function parseTomlSubset(text: string): TomlExtract {
  const root: Record<string, TomlValue> = {};
  const tables = new Map<string, Record<string, TomlValue>>();
  let current: Record<string, TomlValue> = root;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    if (line.startsWith("[[")) continue;
    if (line.startsWith("[")) {
      const header = parseTomlTableHeader(line);
      if (!header) continue;
      const existing = tables.get(header) ?? {};
      tables.set(header, existing);
      current = existing;
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^["']|["']$/g, "");
    const parsed = parseTomlValue(line.slice(eq + 1));
    if (!key || !parsed) continue;
    current[key] = parsed.value;
  }
  return { root, tables };
}

function parseTomlTableHeader(line: string): string | null {
  if (!line.startsWith("[") || !line.endsWith("]")) return null;
  const inner = line.slice(1, -1).trim();
  const parts: string[] = [];
  let rest = inner;
  while (rest.length > 0) {
    rest = rest.trimStart();
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const quoted = parseQuoted(rest, rest[0] as '"' | "'");
      if (!quoted) return null;
      parts.push(quoted.value);
      rest = quoted.rest.trimStart();
      if (rest.startsWith(".")) rest = rest.slice(1);
      continue;
    }
    const match = rest.match(/^([A-Za-z0-9_-]+)/);
    if (!match) return null;
    parts.push(match[1]);
    rest = rest.slice(match[1].length).trimStart();
    if (rest.startsWith(".")) rest = rest.slice(1);
  }
  return parts.join(".");
}

function stripTomlComment(line: string): string {
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function parseQuoted(input: string, quote: "'" | '"'): { value: string; rest: string } | null {
  if (!input.startsWith(quote)) return null;
  if (quote === "'") {
    const end = input.indexOf("'", 1);
    if (end < 0) return null;
    return { value: input.slice(1, end), rest: input.slice(end + 1) };
  }
  let out = "";
  for (let i = 1; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "\\") {
      const next = input[i + 1];
      if (next === undefined) return null;
      const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" };
      out += map[next] ?? next;
      i += 1;
      continue;
    }
    if (ch === '"') return { value: out, rest: input.slice(i + 1) };
    out += ch;
  }
  return null;
}

function parseTomlValue(raw: string): { value: TomlValue; rest: string } | null {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    return parseQuoted(trimmed, trimmed[0] as '"' | "'");
  }
  if (trimmed.startsWith("true") && isValueBoundary(trimmed[4])) {
    return { value: true, rest: trimmed.slice(4) };
  }
  if (trimmed.startsWith("false") && isValueBoundary(trimmed[5])) {
    return { value: false, rest: trimmed.slice(5) };
  }
  const num = trimmed.match(/^-?\d+(?:\.\d+)?/);
  if (num && isValueBoundary(trimmed[num[0].length])) {
    return { value: Number(num[0]), rest: trimmed.slice(num[0].length) };
  }
  return null;
}

function isValueBoundary(ch: string | undefined): boolean {
  return !ch || /[\s#,}\]]/.test(ch);
}
