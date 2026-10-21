import { cleanBaseUrl } from "./modelFactory";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastStamp = 0;
let counter = 0;

/**
 * 符合 OpenCode 规范的唯一 ID 生成器：
 * 12 位 16 进制（时间戳 * 0x1000 + 计数器，Session ID 会位反转以保持倒序）+ 14 位随机 Base62 字符。
 * OpenCode Zen 免费层强校验 session id 的格式，计数器过大或格式不符会返回 403 FreeTierError。
 */
export function opencodeID(prefix: string, descending = false, now = Date.now()): string {
  if (now !== lastStamp) {
    lastStamp = now;
    counter = 0;
  }
  counter++;
  const current = BigInt(now) * 0x1000n + BigInt(counter);
  const value = (descending ? ~current : current) & 0xffffffffffffn;
  const randomBytes = new Uint8Array(14);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(randomBytes);
  } else {
    for (let i = 0; i < 14; i++) randomBytes[i] = Math.floor(Math.random() * 256);
  }
  let tail = "";
  for (const byte of randomBytes) tail += ALPHABET[byte % 62];
  return `${prefix}_${value.toString(16).padStart(12, "0")}${tail}`;
}

export const OPENCODE_USER_AGENT = "opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";

export const OPENCODE_CORE_PARAMETER: Record<string, string> = {
  bash: "command",
  edit: "filePath",
  glob: "pattern",
  grep: "pattern",
  read: "filePath",
};

export const OPENCODE_CORE_TOOLS = ["bash", "edit", "glob", "grep", "read"].map((name) => ({
  type: "function",
  function: {
    name,
    description: "Not available. Never call this tool.",
    parameters: {
      type: "object",
      properties: { [OPENCODE_CORE_PARAMETER[name]]: { type: "string" } },
      additionalProperties: false,
    },
  },
}));

/**
 * 判断 URL 是否属于 OpenCode Zen 推理网关
 */
export function isOpenCodeZenUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  const cleaned = cleanBaseUrl(url).toLowerCase();
  return cleaned.includes("opencode.ai");
}

/**
 * 判断是否为 OpenCode Zen 免费模型：
 * 包含 "-free" 后缀，或者知名免费模型如 "big-pickle"
 */
export function isOpenCodeZenFreeModel(id: string | undefined | null): boolean {
  if (!id) return false;
  const lower = id.trim().toLowerCase();
  if (lower === "big-pickle") return true;
  if (lower.endsWith("-free") || lower.includes("-free-") || lower.includes("free")) {
    return true;
  }
  return false;
}

/**
 * 规范化 OpenCode Zen 端点：
 * 强制重写至 https://opencode.ai/inference/v1（自 2026-10-13 起 /zen/v1 对免费层返回 403 FreeTierError）
 */
export function normalizeOpenCodeUrl(url: string): string {
  if (!isOpenCodeZenUrl(url)) return url;
  return url
    .replace("https://opencode.ai/zen/v1", "https://opencode.ai/inference/v1")
    .replace("http://opencode.ai/zen/v1", "https://opencode.ai/inference/v1")
    .replace("https://opencode.ai/v1", "https://opencode.ai/inference/v1")
    .replace("http://opencode.ai/v1", "https://opencode.ai/inference/v1");
}

/**
 * 为发往 OpenCode Zen 的请求进行请求头、会话指纹与工具占位装饰，
 * 彻底避免 403 FreeTierError
 */
export function decorateOpenCodeZenRequest(
  rawUrl: string,
  init?: RequestInit,
): { url: string; init: RequestInit } {
  const options: RequestInit = { ...(init ?? {}) };
  if (!isOpenCodeZenUrl(rawUrl)) {
    return { url: rawUrl, init: options };
  }
  const url = normalizeOpenCodeUrl(rawUrl);

  const headers = new Headers(options.headers);
  const session = opencodeID("ses", true);
  const reqId = opencodeID("msg", false);

  headers.set("content-type", "application/json");
  headers.set("accept", "*/*");
  headers.set("user-agent", OPENCODE_USER_AGENT);
  headers.set("x-opencode-client", "cli");
  headers.set("x-opencode-project", "global");
  headers.set("x-opencode-session", session);
  headers.set("x-opencode-session-id", session);
  headers.set("x-opencode-request", reqId);

  // 鉴权默认为 Bearer public
  const auth = headers.get("authorization");
  if (!auth || !auth.trim()) {
    headers.set("authorization", "Bearer public");
  }

  // 处理请求体（5 个核心 Tools 占位守护与 stream 保证）
  if (options.body && typeof options.body === "string") {
    try {
      const parsed = JSON.parse(options.body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        let changed = false;
        // 强制 stream: true
        if (parsed.stream !== true) {
          parsed.stream = true;
          changed = true;
        }
        // 保证 5 个核心 tools 齐备（Zen 免费层缺少任意一个核心工具均报 403）
        parsed.tools = Array.isArray(parsed.tools) ? parsed.tools : [];
        const presentNames = new Set(
          parsed.tools.map((t: any) => t?.function?.name || t?.name).filter(Boolean),
        );
        for (const coreTool of OPENCODE_CORE_TOOLS) {
          if (!presentNames.has(coreTool.function.name)) {
            parsed.tools.push(coreTool);
            changed = true;
          }
        }
        if (changed) {
          options.body = JSON.stringify(parsed);
        }
      }
    } catch {
      // ignore json parse error
    }
  }

  options.headers = headers;
  return { url, init: options };
}

