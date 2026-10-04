/**
 * messageTheme.ts —— 消息区主题（message-theme）：仅作用于消息/对话列表的
 * 独立配色 + 等宽字体。antigravity = 现状默认；opencode = opencode v2 默认主题
 * （MIT）配色 + IBM Plex Mono。持久化 kv `reinagent-message-theme`，
 * 切换经 window 事件广播（设置页 → MessageList 即时生效，无重启）。
 */
import { kvGet, kvSet } from "../storage/db";

export type MessageTheme = "antigravity" | "opencode";

const KEY = "reinagent-message-theme";
const CHANGE_EVENT = "reinagent-message-theme-change";

export function getMessageTheme(): MessageTheme {
  return kvGet(KEY) === "opencode" ? "opencode" : "antigravity";
}

export function setMessageTheme(theme: MessageTheme): void {
  kvSet(KEY, theme);
  window.dispatchEvent(new CustomEvent<MessageTheme>(CHANGE_EVENT, { detail: theme }));
}

/** 订阅切换（返回退订函数）。 */
export function subscribeMessageTheme(cb: (theme: MessageTheme) => void): () => void {
  const handler = (e: Event): void => cb((e as CustomEvent<MessageTheme>).detail);
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}
