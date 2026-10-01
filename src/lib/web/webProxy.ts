/**
 * webProxy.ts —— webfetch / websearch 出网代理 + No Proxy 设置（kv 持久化）。
 *
 * Rust 侧 web_tools.rs 每次请求时读取 kv：
 * - `reinagent-web-proxy`：出网代理（设置值优先 → 环境变量 → 直连；空 = 直连）
 * - `reinagent-web-proxy-no-proxy`：不使用代理的地址（逗号分隔；命中直连）
 * 命令工具（fs_execute 子进程）代理环境变量同样由这两个键驱动。
 */

import { kvGet, kvSet } from "../storage/db";

export const WEB_PROXY_KEY = "reinagent-web-proxy";
export const WEB_PROXY_NO_PROXY_KEY = "reinagent-web-proxy-no-proxy";

export function getWebProxy(): string {
  return kvGet(WEB_PROXY_KEY) ?? "";
}

export function setWebProxy(url: string): void {
  kvSet(WEB_PROXY_KEY, url.trim());
}

/** 默认 no-proxy：本地 + 常见局域网网段（与 Rust 侧 KV_WEB_PROXY_NO_PROXY_DEFAULT 一致）。 */
export const WEB_NO_PROXY_DEFAULT =
  "localhost,127.0.0.1,::1,192.168.*,10.*,172.16.*,.lan,.local";

export function getWebNoProxy(): string {
  return kvGet(WEB_PROXY_NO_PROXY_KEY)?.trim() || WEB_NO_PROXY_DEFAULT;
}

export function setWebNoProxy(value: string): void {
  kvSet(WEB_PROXY_NO_PROXY_KEY, value.trim());
}
