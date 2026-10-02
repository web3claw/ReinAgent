/**
 * 提示词增强设置（移植自 PI-Desktop AppSettings 的 5 个 promptEnhancement* 字段）。
 * 存储走 settings.json 的 "promptEnhancement" 键；系统提示词覆盖一律不落盘（对齐 PI）。
 */

import type { ThinkingLevel } from "./enhance";

export interface PromptEnhancementSettings {
  /** 自定义模板开关；关时保留模板文本（再次打开不丢）。 */
  customTemplate: boolean;
  /** 用户模板：必须含 {{draft}}，≤8000 字符；空 = 未覆盖（回退内置默认）。 */
  userTemplate: string;
  /** 钉住增强模型；空 = 跟随 composer 当前模型。 */
  providerId: string;
  modelId: string;
  /** 增强推理等级；缺省 off，从不继承会话等级。 */
  thinkingLevel: ThinkingLevel;
}

export const DEFAULT_PROMPT_ENHANCEMENT_SETTINGS: PromptEnhancementSettings = {
  customTemplate: false,
  userTemplate: "",
  providerId: "",
  modelId: "",
  thinkingLevel: "off",
};

const SETTINGS_FILE = "settings.json";
const KEY = "promptEnhancement";

export function normalizePromptEnhancementSettings(input: unknown): PromptEnhancementSettings {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  return {
    customTemplate: obj.customTemplate === true,
    userTemplate: typeof obj.userTemplate === "string" ? obj.userTemplate : "",
    providerId: typeof obj.providerId === "string" ? obj.providerId : "",
    modelId: typeof obj.modelId === "string" ? obj.modelId : "",
    thinkingLevel: levels.includes(obj.thinkingLevel as string)
      ? (obj.thinkingLevel as ThinkingLevel)
      : "off",
  };
}

export async function loadPromptEnhancementSettings(): Promise<PromptEnhancementSettings> {
  try {
    const mod = await import("@tauri-apps/plugin-store");
    const store = await mod.load(SETTINGS_FILE, { autoSave: true });
    return normalizePromptEnhancementSettings(await store.get(KEY));
  } catch (err) {
    console.warn("[prompt-enhancement] settings load failed:", err);
    return { ...DEFAULT_PROMPT_ENHANCEMENT_SETTINGS };
  }
}

export async function savePromptEnhancementSettings(
  settings: PromptEnhancementSettings,
): Promise<PromptEnhancementSettings> {
  const normalized = normalizePromptEnhancementSettings(settings);
  const mod = await import("@tauri-apps/plugin-store");
  const store = await mod.load(SETTINGS_FILE, { autoSave: true });
  await store.set(KEY, normalized);
  window.dispatchEvent(new CustomEvent("reinagent-prompt-enhancement-settings-changed"));
  return normalized;
}
