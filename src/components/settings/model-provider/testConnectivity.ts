import type { ProviderItem } from "./types";
import { cleanBaseUrl, ensureV1BaseUrl } from "../../../lib/providers/modelFactory";

export interface ConnectivityResult {
  success: boolean;
  latencyMs?: number;
  error?: string;
}

export async function testModelConnectivity(
  provider: ProviderItem,
  modelId: string
): Promise<ConnectivityResult> {
  const startTime = Date.now();
  const cleanedBase = cleanBaseUrl(provider.baseUrl);
  const apiKey = (provider.apiKey || "").trim();

  if (!cleanedBase) {
    return { success: false, error: "Base URL is required" };
  }

  // 针对需要 Key 的服务商检查
  if (provider.id !== "ollama" && !apiKey) {
    return { success: false, error: "API Key is required" };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    let res: Response;

    if (provider.apiFormat === "anthropic-messages") {
      const endpoint = `${ensureV1BaseUrl(cleanedBase)}/messages`;
      res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: controller.signal,
      });
    } else if (provider.apiFormat === "google-generative-ai") {
      const endpoint = `${cleanedBase}/models/${modelId}:generateContent?key=${apiKey}`;
      res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
        signal: controller.signal,
      });
    } else if (provider.apiFormat === "openai-responses") {
      const endpoint = `${ensureV1BaseUrl(cleanedBase)}/responses`;
      res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: modelId,
          input: "hi",
          max_output_tokens: 16,
        }),
        signal: controller.signal,
      });
    } else {
      // 默认 openai-chat-completions / openai-completions 兼容接口：标准 /v1/chat/completions
      const endpoint = `${ensureV1BaseUrl(cleanedBase)}/chat/completions`;
      res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
        }),
        signal: controller.signal,
      });
    }

    clearTimeout(timeoutId);

    const latencyMs = Date.now() - startTime;

    if (res.ok) {
      return { success: true, latencyMs };
    }

    // 解析错误
    let errMsg = `HTTP ${res.status} ${res.statusText}`;
    try {
      const errJson = await res.json();
      if (errJson?.error?.message) {
        errMsg = errJson.error.message;
      } else if (typeof errJson?.message === "string") {
        errMsg = errJson.message;
      }
    } catch {
      // ignore json parse error
    }

    if (res.status === 401) {
      errMsg = `Authentication Failed (401): ${errMsg}`;
    } else if (res.status === 404) {
      errMsg = `Model or Endpoint Not Found (404): ${errMsg}`;
    }

    return { success: false, latencyMs, error: errMsg };
  } catch (err: unknown) {
    const latencyMs = Date.now() - startTime;
    if (err instanceof Error) {
      if (err.name === "AbortError") {
        return { success: false, latencyMs, error: "Connection timed out (12s)" };
      }
      return { success: false, latencyMs, error: err.message };
    }
    return { success: false, latencyMs, error: String(err) };
  }
}
