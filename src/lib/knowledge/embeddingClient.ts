/**
 * embedding 客户端：通用 OpenAI 兼容 POST {baseUrl}/embeddings（非流式 JSON）。
 *
 * 通道：proxiedFetch（tauri-plugin-http → Rust reqwest，读应用内代理设置、
 * 无 CORS；no-proxy 命中直连——Ollama 127.0.0.1/局域网地址即直连语义）。
 * 不走 buildModel/pi-ai（pi-ai 无 embeddings API），错误文案口径与
 * testConnectivity.ts 一致（401/404 细分、服务端 message 原文透传、不吞错）。
 *
 * 维度（dims）不做任何静态预设：从真实响应学习，全部批次必须一致。
 * fetchImpl 可注入（单测用内存 fake，不 mock 真实网络）。
 */

import { recordUsage } from "../usage/recordUsage";

export interface EmbeddingTarget {
  /** 已含 /v1 前缀的完整基础地址（调用方用 ensureV1BaseUrl 归一化后传入） */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 服务商 id（用量记账用；测试可不传） */
  provider?: string;
}

export interface EmbedResult {
  vectors: number[][];
  dims: number;
}

export const EMBED_BATCH_SIZE = 16;
export const EMBED_TIMEOUT_MS = 60_000;

export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** 服务端错误 → 用户可读文案（口径对齐 testConnectivity.ts）。纯函数可单测。 */
export function formatEmbeddingHttpError(status: number, statusText: string, bodyText: string): string {
  let message = `HTTP ${status} ${statusText}`.trim();
  try {
    const errJson = JSON.parse(bodyText) as { error?: { message?: string }; message?: string };
    if (errJson?.error?.message) {
      message = errJson.error.message;
    } else if (typeof errJson?.message === "string" && errJson.message) {
      message = errJson.message;
    }
  } catch {
    // 响应体不是 JSON：保留 HTTP 状态行原文
  }
  if (status === 401) return `Authentication Failed (401): ${message}`;
  if (status === 404) return `Model or Endpoint Not Found (404): ${message}`;
  return message;
}

interface EmbedApiItem {
  embedding?: unknown;
  index?: number;
}

function parseEmbeddingResponse(json: unknown, expectedCount: number): number[][] {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length !== expectedCount) {
    throw new Error(
      `embedding 响应形状异常：期望 data[${expectedCount}]，实际 ${
        Array.isArray(data) ? `data[${data.length}]` : typeof data
      }`,
    );
  }
  return data.map((item: EmbedApiItem, i) => {
    const vec = item?.embedding;
    if (!Array.isArray(vec) || vec.length === 0 || !vec.every((x) => typeof x === "number")) {
      throw new Error(`embedding 响应形状异常：data[${i}].embedding 不是非空数值数组`);
    }
    return vec as number[];
  });
}

async function embedBatch(
  target: EmbeddingTarget,
  inputs: string[],
  timeoutMs: number,
  fetchImpl: FetchImpl,
): Promise<number[][]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${target.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: target.model, input: inputs }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw new Error(formatEmbeddingHttpError(res.status, res.statusText, bodyText));
    }
    const json = (await res.json()) as unknown;
    // 用量记账（⑧）：OpenAI embeddings 响应的 usage.prompt_tokens（无 output 维度）；
    // 网关不回 usage 则不记（no-fallback）
    const usage = (json as { usage?: { prompt_tokens?: number; total_tokens?: number } }).usage;
    if (usage?.prompt_tokens) {
      void recordUsage({
        source: "embedding",
        provider: target.provider ?? "",
        model: target.model,
        inputTokens: usage.prompt_tokens,
        outputTokens: Math.max(0, (usage.total_tokens ?? usage.prompt_tokens) - usage.prompt_tokens),
      });
    }
    return parseEmbeddingResponse(json, inputs.length);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`embedding 请求超时（${Math.round(timeoutMs / 1000)}s）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 批量向量化：inputs 按 EMBED_BATCH_SIZE 顺序分批，全部成功才返回。 */
export async function embedInputs(
  target: EmbeddingTarget,
  inputs: string[],
  opts?: { batchSize?: number; timeoutMs?: number; fetchImpl?: FetchImpl },
): Promise<EmbedResult> {
  if (!target.baseUrl) throw new Error("embedding 服务商 baseUrl 未配置");
  if (!target.model) throw new Error("embedding 模型未配置");
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("embedding 输入为空");
  }
  if (inputs.some((text) => typeof text !== "string" || text.trim().length === 0)) {
    throw new Error("embedding 输入存在空文本（索引内容异常，拒绝发送）");
  }
  const batchSize = opts?.batchSize ?? EMBED_BATCH_SIZE;
  const timeoutMs = opts?.timeoutMs ?? EMBED_TIMEOUT_MS;
  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as FetchImpl);

  const vectors: number[][] = [];
  let dims = 0;
  for (let start = 0; start < inputs.length; start += batchSize) {
    const batch = inputs.slice(start, start + batchSize);
    const batchVectors = await embedBatch(target, batch, timeoutMs, fetchImpl);
    if (dims === 0) {
      dims = batchVectors[0].length;
    }
    for (const vec of batchVectors) {
      if (vec.length !== dims) {
        throw new Error(`embedding 批次维度不一致（${dims} vs ${vec.length}）`);
      }
      vectors.push(vec);
    }
  }
  return { vectors, dims };
}
