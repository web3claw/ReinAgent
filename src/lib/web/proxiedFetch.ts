/**
 * proxiedFetch.ts —— 出站 HTTP 统一走 tauri-plugin-http（Rust reqwest，无 CORS 概念）。
 *
 * 为什么（2026-10-04，用户实测 api.gonkarouter.io 拿不到模型列表）：
 * - webview 里原生 fetch 受浏览器同源策略约束——服务端不返回 CORS 头时请求在
 *   鉴权之前就被引擎掐断（preflight blocked），模型列表/对话流/标题生成全部失败；
 * - 原生 fetch 也不读应用内「联网代理」设置——代理成了摆设。
 *
 * 方案：插件 fetch 与原生 fetch 同形（Response/ReadableStream/abort 全兼容），
 * 请求实际由 Rust reqwest 执行；代理设置经 init.proxy 注入（读 kv
 * `reinagent-web-proxy` + `reinagent-web-proxy-no-proxy`，no-proxy 命中直连）。
 * Web 环境（无 Tauri IPC）回退原生 fetch（无代理，如实现状）。
 */
import { fetch as pluginFetch, type ClientOptions } from "@tauri-apps/plugin-http";
import { kvGet } from "../storage/db";

export const WEB_PROXY_KEY = "reinagent-web-proxy";
export const WEB_PROXY_NO_PROXY_KEY = "reinagent-web-proxy-no-proxy";

/** 判断 url 的 host 是否命中 no-proxy 规则（后缀/通配/精确，与 Rust 侧语义一致）。 */
function matchesNoProxy(url: string, noProxy: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return noProxy
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean)
    .some((rule) => {
      if (rule === "*") return true;
      // 通配前缀：192.168.* / *.lan
      if (rule.includes("*")) {
        const pattern = rule.replace(/\*/g, "");
        return host.includes(pattern);
      }
      // 后缀匹配（example.com 命中 a.example.com 与 example.com 本身）
      return host === rule || host.endsWith(`.${rule}`);
    });
}

/** isTauri：无 Tauri IPC 时（浏览器/web 演示模式）回退原生 fetch。 */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 与全局 fetch 同形；Tauri 下走 Rust reqwest 并注入应用内代理设置。 */
export async function proxiedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!isTauri()) {
    return fetch(input, init);
  }
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const proxyUrl = (kvGet(WEB_PROXY_KEY) ?? "").trim();
  const noProxy = (kvGet(WEB_PROXY_NO_PROXY_KEY) ?? "").trim();
  const useProxy = proxyUrl !== "" && !matchesNoProxy(url, noProxy);
  const initExtra = { ...(init ?? {}) } as RequestInit & ClientOptions;
  if (useProxy) {
    // no-proxy 规则我们在 matchesNoProxy 已判定（命中则不走代理）；
    // 插件的 Proxy.all 只接受字符串或 ProxyConfig，配置态带 noProxy 需经 ProxyConfig 形状
    initExtra.proxy =
      noProxy !== ""
        ? { all: { url: proxyUrl, noProxy } }
        : { all: proxyUrl };
  } else {
    // kv 未配置代理 = 「留空直连」语义：显式压制 reqwest 从系统环境变量继承的代理。
    // ⚠ noProxy 写法坑（hyper-util 匹配器实测）："*" 只对域名主机生效，IP 字面量
    // （如 Ollama http://192.168.3.27:8787）必须走 IP 子网规则——两者合并：
    // "0.0.0.0/0,::/0,*" = IPv4 全部 + IPv6 全部 + 全部域名 → 稳定全直连。
    // （"http://direct" 是占位代理 URL，命中 noProxy 即不使用。）
    initExtra.proxy = { all: { url: "http://direct", noProxy: "0.0.0.0/0,::/0,*" } };
  }
  return pluginFetch(input, initExtra);
}
