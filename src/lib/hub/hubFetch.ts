// LiveAgent 移植：crates/agent-ui/src/lib/hubFetch.ts（适配本项目 Rust 通道）
//
// Hub（Skills / MCP 商店）浏览类请求的出网适配层。LA 原版经本地反代转发；
// 本项目对齐语义改为统一走 Rust 命令 `hub_fetch_json`（ureq + rustls 直连）：
// WebView 内直接 fetch 公网 API 会受 CORS/CSP 约束，由 Rust 侧代理出网。
//
// 返回真实 Response 对象：LA 调用方（clawHub 的 response.text()/ok/status、
// mcpRegistry 的 response.json() 与 fetchImpl?: typeof fetch 注入）保持不改。
// 非 2xx 不抛错，原样返回 status + body；网络/协议层错误如实 reject（fail fast）。
import { invoke } from "@tauri-apps/api/core";

export async function hubFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {};
  const headerList = new Headers(init?.headers);
  headerList.forEach((value, name) => {
    headers[name] = value;
  });

  let body: string | undefined;
  if (init?.body !== undefined && init.body !== null) {
    if (typeof init.body !== "string") {
      throw new Error(`hubFetch: 不支持的 body 类型 ${typeof init.body}（仅支持 string）`);
    }
    body = init.body;
  }

  const result = await invoke<{ status: number; body: string }>("hub_fetch_json", {
    args: { method, url: typeof input === "string" ? input : input.toString(), headers, body },
  });
  return new Response(result.body, {
    status: result.status,
    headers: { "Content-Type": "application/json" },
  });
}
