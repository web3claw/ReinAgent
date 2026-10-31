import { describe, it, expect } from "bun:test";
import {
  formatModelKey,
  parseModelKey,
  resolveActiveModelInfo,
  MODEL_KEY_DELIMITER,
} from "./modelKeyResolver";
import type { ProviderItem } from "../../components/settings/model-provider/types";

describe("modelKeyResolver Unit Tests", () => {
  it("1. formatModelKey combines providerId and modelId safely with delimiter", () => {
    const key = formatModelKey("custom-1791416422975", "workbuddy/deepseek-v4.1-flash");
    expect(key).toBe(`custom-1791416422975${MODEL_KEY_DELIMITER}workbuddy/deepseek-v4.1-flash`);
  });

  it("2. parseModelKey safely extracts modelId containing slashes with ::: delimiter", () => {
    const key = `custom-1791416422975:::workbuddy/deepseek-v4.1-flash`;
    const parsed = parseModelKey(key);
    expect(parsed).toEqual({
      providerId: "custom-1791416422975",
      modelId: "workbuddy/deepseek-v4.1-flash",
    });
  });

  it("3. parseModelKey backward compatible with legacy single-slash formatted keys with slashes in modelId", () => {
    // 即使历史格式仅用第一个斜杠，也能保留后续完整的 modelId
    const legacyKey = "custom-1791416422975/workbuddy/deepseek-v4.1-flash";
    const parsed = parseModelKey(legacyKey);
    expect(parsed).toEqual({
      providerId: "custom-1791416422975",
      modelId: "workbuddy/deepseek-v4.1-flash",
    });
  });

  it("4. resolveActiveModelInfo correctly resolves metadata including 1M ctx and supportsImage", () => {
    const mockProviders: ProviderItem[] = [
      {
        id: "custom-1791416422975",
        name: "WorkBuddy",
        enabled: true,
        models: [
          {
            id: "workbuddy/deepseek-v4.1-flash",
            name: "workbuddy/deepseek-v4.1-flash",
            contextWindow: 1048576, // 1M
            supportsImage: true,
            enabled: true,
          },
        ],
      },
    ];

    const result = resolveActiveModelInfo({
      selectedModelKey: "custom-1791416422975:::workbuddy/deepseek-v4.1-flash",
      defaultProviderId: "deepseek",
      defaultModelId: "deepseek-chat",
      providers: mockProviders,
    });

    expect(result.providerId).toBe("custom-1791416422975");
    expect(result.modelId).toBe("workbuddy/deepseek-v4.1-flash");
    expect(result.displayName).toBe("workbuddy/deepseek-v4.1-flash");
    expect(result.ctxLabel).toBe("1M");
    expect(result.supportsImage).toBe(true);
    expect(result.isExplicitlySelected).toBe(true);
  });

  it("5. resolveActiveModelInfo gracefully falls back to default model and provider when selectedModelKey is empty", () => {
    const mockProviders: ProviderItem[] = [
      {
        id: "deepseek",
        name: "DeepSeek",
        enabled: true,
        models: [
          {
            id: "deepseek-chat",
            name: "DeepSeek V3",
            contextWindow: 65536, // 64K
            supportsImage: false,
            enabled: true,
          },
        ],
      },
    ];

    const result = resolveActiveModelInfo({
      selectedModelKey: "",
      defaultProviderId: "deepseek",
      defaultModelId: "deepseek-chat",
      providers: mockProviders,
    });

    expect(result.providerId).toBe("deepseek");
    expect(result.modelId).toBe("deepseek-chat");
    expect(result.displayName).toBe("DeepSeek V3");
    expect(result.ctxLabel).toBe("65.5K");
    expect(result.supportsImage).toBe(false);
    expect(result.isExplicitlySelected).toBe(false);
  });

  it("6. Red/Break Check: corrupted or empty model key does not throw and handles safely", () => {
    expect(parseModelKey("")).toBeNull();
    expect(parseModelKey("   ")).toBeNull();
    // @ts-expect-error test invalid types
    expect(parseModelKey(null)).toBeNull();
    // @ts-expect-error test invalid types
    expect(parseModelKey(undefined)).toBeNull();

    const emptyResult = resolveActiveModelInfo({
      selectedModelKey: "   ",
      defaultProviderId: "",
      defaultModelId: "",
      providers: [],
    });
    expect(emptyResult.displayName).toBe("默认模型");
    expect(emptyResult.ctxLabel).toBeNull();
    expect(emptyResult.supportsImage).toBe(false);
  });
});
