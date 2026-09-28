/**
 * useConversationFind —— 会话内查找（P2-A1，对齐 ZCode useConversationTimelineFind
 * 的会话内索引形态）：在当前任务的消息正文/思考/工具结果里做大小写不敏感的子串
 * 匹配，产出按消息聚合的命中列表与上下导航游标；跳转由调用方把命中消息 id 交给
 * MessageList 既有 scrollTargetMessageId 机制（滚动定位 + 高亮）。
 */

import { useMemo, useState } from "react";
import type { TimelineEntry } from "../../lib/chat/conversationModel.js";

export interface FindHit {
  messageId: string;
  /** 该消息内的命中次数。 */
  count: number;
  /** 命中的字段（用于调试/展示）。 */
  fields: ("text" | "thinking" | "toolResult")[];
}

function entryHaystack(entry: TimelineEntry): { field: FindHit["fields"][number]; text: string }[] {
  const parts: { field: FindHit["fields"][number]; text: string }[] = [];
  if (entry.text) parts.push({ field: "text", text: entry.text });
  if (entry.thinking) parts.push({ field: "thinking", text: entry.thinking });
  if (entry.role === "tool" && entry.resultText) {
    parts.push({ field: "toolResult", text: entry.resultText });
  }
  return parts;
}

/** 纯函数：消息列表 + 查询词 → 按消息聚合的命中列表（导出便于单测）。 */
export function findInTimeline(messages: TimelineEntry[], query: string): FindHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: FindHit[] = [];
  for (const entry of messages) {
    let count = 0;
    const fields: FindHit["fields"][number][] = [];
    for (const { field, text } of entryHaystack(entry)) {
      let index = 0;
      const lower = text.toLowerCase();
      let fieldHits = 0;
      while ((index = lower.indexOf(needle, index)) !== -1) {
        count += 1;
        fieldHits += 1;
        index += needle.length;
      }
      if (fieldHits > 0) fields.push(field);
    }
    if (count > 0) hits.push({ messageId: entry.id, count, fields });
  }
  return hits;
}

export function useConversationFind(messages: TimelineEntry[]) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  const hits = useMemo(() => findInTimeline(messages, query), [messages, query]);

  /** query 变化时游标复位由调用方在 setQuery 包装里处理（这里派生安全值）。 */
  const safeCursor = hits.length === 0 ? 0 : Math.min(cursor, hits.length - 1);

  const goNext = () => {
    if (hits.length === 0) return;
    setCursor((c) => (c + 1 >= hits.length ? 0 : c + 1));
  };
  const goPrev = () => {
    if (hits.length === 0) return;
    setCursor((c) => (c - 1 < 0 ? hits.length - 1 : c - 1));
  };
  const reset = () => {
    setQuery("");
    setCursor(0);
  };

  const currentHit = hits[safeCursor] ?? null;

  return { query, setQuery: (q: string) => { setQuery(q); setCursor(0); }, hits, cursor: safeCursor, currentHit, goNext, goPrev, reset };
}
