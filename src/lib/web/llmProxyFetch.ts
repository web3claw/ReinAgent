/**
 * llmProxyFetch.ts —— LLM 流式请求专用 fetch：改写到 Rust 本地流式反代
 * （`llm_proxy.rs`，127.0.0.1 随机端口 + token 鉴权），上游真实地址经
 * `x-reinagent-upstream-url` 头下发，Rust reqwest 直连上游并流式回传。
 *
 * 为什么（2026-10-05，用户实测 GonkaRouter 流式经常半途无声截断，LiveAgent
 * 同端点同配置却完整）：tauri-plugin-http 的流要经 webview IPC 逐 chunk 搬运，
 * 高吞吐长流下该中继会无声提前关闭（无 [DONE]、无错误行）。本地反代架构下
 * webview 只是一次 localhost 请求（LiveAgent 同款架构，实测完整输出）。
 *
 * Web 演示模式（无 Tauri IPC）回退原生 fetch。
 */
import { invoke } from "@tauri-apps/api/core";

interface LlmProxyInfo {
  baseUrl: string;
  token: string;
}

let infoPromise: Promise<LlmProxyInfo> | null = null;

function getLlmProxyInfo(): Promise<LlmProxyInfo> {
  infoPromise ??= invoke<LlmProxyInfo>("llm_proxy_info");
  return infoPromise;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function llmProxyFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (!isTauri()) {
    return fetch(input, init);
  }
  const info = await getLlmProxyInfo();
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers);
  headers.set("x-reinagent-token", info.token);
  headers.set("x-reinagent-upstream-url", url);
  return fetch(`${info.baseUrl}/proxy`, {
    method: init?.method,
    headers,
    body: init?.body,
    signal: init?.signal,
  });
}
