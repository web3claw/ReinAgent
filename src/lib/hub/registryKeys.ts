/**
 * registryKeys —— MCP Registry 源的 API Key 持久化（kv）。
 *
 * 背景：Glama 的 /api/mcp/v1/servers 自 2026-09 起强制 API Key
 * （401 响应体指引 glama.ai/settings/api-keys 创建；LiveAgent 原版同样受影响）。
 * Key 在 kv "reinagent-mcp-registry-keys" 下按源存放，请求时注入 Authorization。
 */

import { kvGet, kvSetJSON } from "../storage/db";

const KV_KEY = "reinagent-mcp-registry-keys";

interface RegistryKeys {
  glama?: string;
}

function load(): RegistryKeys {
  const raw = kvGet(KV_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as RegistryKeys;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    console.error("[registryKeys] parse failed");
    return {};
  }
}

function save(keys: RegistryKeys): void {
  kvSetJSON(KV_KEY, keys);
}

export function getGlamaApiKey(): string {
  return (load().glama ?? "").trim();
}

export function setGlamaApiKey(key: string): void {
  save({ ...load(), glama: key.trim() });
}

export function clearGlamaApiKey(): void {
  save({ ...load(), glama: "" });
}
