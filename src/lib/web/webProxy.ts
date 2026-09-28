/**
 * webProxy.ts —— webfetch / websearch 出网代理设置（kv 持久化）。
 *
 * Rust 侧 web_tools.rs 每次请求时读取 kv `reinagent-web-proxy`：
 * 设置值优先 → 环境变量（HTTP(S)_PROXY/ALL_PROXY）→ 直连。
 * 空串 = 不用代理（直连）。
 */

import { kvGet, kvSet } from "../storage/db";

export const WEB_PROXY_KEY = "reinagent-web-proxy";

export function getWebProxy(): string {
  return kvGet(WEB_PROXY_KEY) ?? "";
}

export function setWebProxy(url: string): void {
  kvSet(WEB_PROXY_KEY, url.trim());
}
