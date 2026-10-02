/**
 * 模型/Provider 配置导入 IO 层：扫 5 个外部来源 → 候选（无密钥）→ 导入写入
 * provider_config.json（saveProvidersConfigToDisk 全量保存）。
 */

import { invoke } from "@tauri-apps/api/core";
import { getStoredUserHome } from "../storage/db";
import { homeJoin, type ImportFs } from "./fsApi";
import { tauriImportFs } from "./scan";
import {
  draftMatchesExisting,
  modelConfigImportId,
  parseCcSwitchConfigJson,
  parseCcSwitchProviders,
  parseClaudeCodeModelConfig,
  parseCodexModelConfig,
  parseJsonDocument,
  parseOpenCodeModelConfig,
  parsePiModelConfig,
  publicModelConfigCandidate,
  type CcSwitchProviderRow,
  type ModelConfigImportCandidate,
  type ModelConfigImportDraft,
  type ModelConfigImportEnv,
  type ModelConfigImportRunResult,
  type ModelConfigImportSource,
} from "./modelConfigParse";
import { loadProvidersConfigFromDisk, saveProvidersConfigToDisk, type ProviderItem } from "../../components/settings/model-provider/types";

/** 预取的环境变量名（各来源的固定引用；Codex env_key 另按需补查）。 */
const KNOWN_ENV_NAMES = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GEMINI_BASE_URL",
  "GEMINI_BASE_URL",
  "GOOGLE_API_BASE",
  "GEMINI_MODEL",
  "GOOGLE_MODEL",
];

async function lookupEnv(names: string[]): Promise<ModelConfigImportEnv> {
  try {
    return await invoke<Record<string, string>>("import_env_lookup", { names });
  } catch {
    return {};
  }
}

async function readJsonFile(fs: ImportFs, path: string): Promise<unknown | null> {
  const text = await fs.readText(path);
  if (text == null) return null;
  return parseJsonDocument(text);
}

async function scanCcSwitch(home: string, env: ModelConfigImportEnv): Promise<ModelConfigImportDraft[]> {
  const dbPath = homeJoin(home, ".cc-switch", "cc-switch.db");
  try {
    const rows = await invoke<Array<{ id: string; appType: string; name: string; settingsConfig: string }>>(
      "ccswitch_read_providers",
      { dbPath },
    );
    if (rows.length > 0) {
      const parsed: CcSwitchProviderRow[] = rows.map((row) => ({
        id: String(row.id ?? ""),
        appType: String(row.appType ?? ""),
        name: String(row.name || row.id || ""),
        settingsConfig: parseJsonDocument(String(row.settingsConfig ?? "{}")),
      }));
      return parseCcSwitchProviders(parsed, env);
    }
  } catch (err) {
    console.warn("[import] cc-switch sqlite scan failed:", err);
  }
  const json = await readJsonFile(tauriImportFs, homeJoin(home, ".cc-switch", "config.json"));
  return parseCcSwitchProviders(parseCcSwitchConfigJson(json), env);
}

export async function scanModelConfigs(): Promise<ModelConfigImportCandidate[]> {
  const home = getStoredUserHome() ?? "";
  if (!home) return [];
  const fs = tauriImportFs;
  const baseEnv = await lookupEnv(KNOWN_ENV_NAMES);

  const [ccSwitch, claude, opencode, codexToml, piModels] = await Promise.all([
    scanCcSwitch(home, baseEnv),
    (async () => {
      const settings = await readJsonFile(fs, homeJoin(home, ".claude", "settings.json"));
      const local = await readJsonFile(fs, homeJoin(home, ".claude", "settings.local.json"));
      return parseClaudeCodeModelConfig(settings, local);
    })(),
    (async () => {
      const configDir = homeJoin(home, ".config", "opencode");
      const config =
        (await readJsonFile(fs, homeJoin(configDir, "opencode.json"))) ??
        (await readJsonFile(fs, homeJoin(configDir, "opencode.jsonc")));
      const auth =
        (await readJsonFile(fs, homeJoin(home, ".local", "share", "opencode", "auth.json"))) ??
        (await readJsonFile(fs, homeJoin(configDir, "auth.json")));
      return parseOpenCodeModelConfig(config, auth, baseEnv);
    })(),
    (async () => {
      const toml = await fs.readText(homeJoin(home, ".codex", "config.toml"));
      if (toml == null) return [] as ModelConfigImportDraft[];
      // env_key 引用的变量名先从 TOML 里收集出来补查一次，再带着完整 env 解析
      const envKeyNames = [...toml.matchAll(/env_key\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
      const env = { ...baseEnv, ...(await lookupEnv(envKeyNames)) };
      return parseCodexModelConfig(toml, env);
    })(),
    (async () => {
      const models =
        (await readJsonFile(fs, homeJoin(home, ".pi", "agent", "models.json"))) ??
        (await readJsonFile(fs, homeJoin(home, ".pi", "models.json")));
      return parsePiModelConfig(models, baseEnv);
    })(),
  ]);

  // cc-switch 优先；其余来源去掉与 cc-switch 重复的项（endpoint+协议+凭证一致）
  const extra = [...claude, ...opencode, ...codexToml, ...piModels].filter(
    (draft) => !ccSwitch.some((candidate) => draftMatchesExisting(draft, [candidateToExisting(candidate)])),
  );
  return [...ccSwitch, ...extra].map(publicModelConfigCandidate);
}

function candidateToExisting(draft: ModelConfigImportDraft): {
  baseUrl: string | null;
  apiFormat: string;
  apiKey: string | null;
} {
  return { baseUrl: draft.baseUrl, apiFormat: draft.apiFormat, apiKey: draft.secretValue ?? null };
}

/**
 * 导入所选 provider：已存在（同 id 或 endpoint+协议+凭证一致）= skipped；
 * 新增条目 enabled、模型全启用、defaultModelId 取第一个。
 */
export async function importModelConfigs(drafts: ModelConfigImportDraft[]): Promise<ModelConfigImportRunResult> {
  const existingProviders = await loadProvidersConfigFromDisk();
  const providers = [...existingProviders];
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  for (const draft of drafts) {
    try {
      const id = modelConfigImportId(draft.source, draft.externalId);
      const duplicateById = providers.some((p) => p.id === id);
      const duplicateByEndpoint = draftMatchesExisting(
        draft,
        providers.map((p) => ({ baseUrl: p.baseUrl, apiFormat: p.apiFormat, apiKey: p.apiKey })),
      );
      if (duplicateById || duplicateByEndpoint) {
        skipped += 1;
        continue;
      }
      const provider: ProviderItem = {
        id,
        name: draft.name,
        apiFormat: draft.apiFormat,
        baseUrl: draft.baseUrl ?? "",
        apiKey: draft.secretValue ?? "",
        enabled: true,
        models: draft.modelIds.map((mid) => ({ id: mid, name: mid, enabled: true })),
        isCustom: true,
        defaultModelId: draft.modelIds[0],
      };
      providers.push(provider);
      imported += 1;
    } catch (err) {
      console.error("[import] provider import failed:", draft.source, draft.externalId, err);
      failed += 1;
    }
  }
  if (imported > 0) {
    await saveProvidersConfigToDisk(providers);
  }
  return { imported, skipped, failed };
}

export type { ModelConfigImportCandidate, ModelConfigImportSource };
