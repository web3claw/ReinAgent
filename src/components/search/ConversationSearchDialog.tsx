/**
 * ConversationSearchDialog —— 全局会话搜索弹窗（**逐像素对齐 LiveAgent
 * ConversationSearchDialog**）：14 高搜索框区（左图标/加载态 + 输入 + 右 Esc kbd）→
 * 结果区（分组标题行 11px「⏱ 最近会话 / 搜索结果」+ 任务行：标题 14px medium +
 * 片段预览 line-clamp-2（`[...]` 标记渲染为 <mark>）+ 元信息行 11px「路径 · 时间」）
 * → 底部快捷键提示条。防抖 180ms、键盘导航、空态图标居中。数据源 Rust
 * `chat_history_search`（标题/全文 LIKE，[...] 片段）。
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Clock3, Loader2, MessageSquareText, Search } from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useTranslation } from "../../i18n";

interface SearchHit {
  taskId: string;
  msgId: string;
  seq: number;
  role: string;
  snippet: string;
  timestamp?: number | null;
}

interface SearchGroup {
  taskId: string;
  taskTitle: string;
  taskCwd: string;
  titleMatch: boolean;
  taskUpdatedAt?: number | null;
  hits: SearchHit[];
  totalHits: number;
}

interface SearchResponse {
  groups: SearchGroup[];
  totalHits: number;
}

const DEBOUNCE_MS = 180;

/** 右下角时间（对齐 LiveAgent formatUpdatedAt：9月27日 08:54 / Sep 27, 08:54） */
function formatUpdatedAt(value: number | undefined | null, zh: boolean): string {
  if (!value || !Number.isFinite(value)) return "";
  const d = new Date(value);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (zh) {
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
  }
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}, ${hhmm}`;
}

/** 任务显示路径：项目路径（无项目 = 用户主目录下的 DefaultProject，与工作区决议一致） */
function resolveDisplayCwd(cwd: string): string {
  if (cwd) return cwd;
  const home =
    typeof window !== "undefined"
      ? (window as unknown as { __reinagentHome?: string }).__reinagentHome ?? ""
      : "";
  return home ? `${home}/.ReinAgent/DefaultProject` : "";
}

/** 片段渲染：`[...]` 标记渲染为 <mark>（对齐 LiveAgent renderSearchPreview） */
function renderSearchPreview(value: string) {
  const parts = value.split(/(\[\.\.\.\])/g).filter(Boolean);
  return parts.map((part, index) =>
    part === "[...]" ? (
      <mark key={index} className="rounded-sm bg-[var(--brand-dim)] px-0.5 text-[var(--text)]">
        [...]
      </mark>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    ),
  );
}

type SearchStatus = "idle" | "loading" | "ready" | "error";

export function ConversationSearchDialog({
  open,
  onOpenChange,
  onOpenTask,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 点击结果：taskId + 命中消息 id（用于跳转后滚动定位到该消息） */
  onOpenTask: (taskId: string, messageId?: string) => void;
}) {
  const { t, locale } = useTranslation();
  const zh = locale === "zh-CN";
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchGroup[]>([]);
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [activeIndex, setActiveIndex] = useState(0);
  const requestSequenceRef = useRef(0);
  const resultsListRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = query.trim();

  const performSearch = useCallback(async (searchQuery: string) => {
    const requestSequence = ++requestSequenceRef.current;
    setStatus("loading");
    try {
      const res = await invoke<SearchResponse>("chat_history_search", {
        query: searchQuery,
        limit: 20,
      });
      if (requestSequence !== requestSequenceRef.current) return;
      setResults(res.groups);
      setStatus("ready");
    } catch {
      if (requestSequence !== requestSequenceRef.current) return;
      setResults([]);
      setStatus("error");
    }
  }, []);

  // 打开重置 + 立即拉最近会话（空查询 = 最近任务）
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setStatus("idle");
      setActiveIndex(0);
      void performSearch("");
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      requestSequenceRef.current += 1;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open 变化触发
  }, [open]);

  // 防抖搜索
  useEffect(() => {
    if (!open) return;
    if (!normalizedQuery) {
      // 查询清空 → 回到最近会话空态
      const timer = window.setTimeout(() => void performSearch(""), DEBOUNCE_MS);
      return () => window.clearTimeout(timer);
    }
    setStatus("loading");
    const timer = window.setTimeout(() => void performSearch(normalizedQuery), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [normalizedQuery, open, performSearch]);

  // 平铺可导航条目（分组顺序即导航顺序）
  const flatItems = useMemo(() => results.map((group) => ({ group })), [results]);

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, flatItems.length - 1)));
  }, [flatItems.length]);

  useEffect(() => {
    resultsListRef.current
      ?.querySelector<HTMLElement>(`[data-conversation-search-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const selectTask = (taskId: string, messageId?: string) => {
    onOpenChange(false);
    onOpenTask(taskId, messageId);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => Math.min(flatItems.length - 1, Math.max(0, current + 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(0, current - 1));
    } else if (event.key === "Enter") {
      const selected = flatItems[activeIndex];
      if (selected) {
        event.preventDefault();
        const firstHit = selected.group.hits[0];
        selectTask(selected.group.taskId, firstHit?.msgId);
      }
    }
  };

  const groupLabel = normalizedQuery
    ? t("searchResults")
    : t("searchRecentConversations");
  const GroupIcon = normalizedQuery ? Search : Clock3;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[90] bg-black/50" />
        <DialogPrimitive.Content className="fixed left-1/2 top-[calc(50vh-320px)] z-[91] flex max-h-[min(640px,calc(100vh-2rem))] w-[600px] max-w-[92vw] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-2xl">
          <DialogPrimitive.Title className="sr-only">{t("searchConversations")}</DialogPrimitive.Title>

          {/* 搜索框区（h-14，对齐 LiveAgent 头部） */}
          <div className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--border)] px-4">
            {status === "loading" ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--text-dim)]" />
            ) : (
              <Search className="h-4 w-4 shrink-0 text-[var(--text-dim)]" />
            )}
            <input
              ref={inputRef}
              autoFocus
              type="text"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleKeyDown}
              placeholder={t("searchConversations")}
              aria-label={t("searchConversations")}
              className="h-auto flex-1 bg-transparent text-[15px] text-[var(--text)] placeholder:text-[var(--text-dim)]/70 focus:outline-none"
            />
            <kbd className="hidden rounded-md border border-[var(--border)] bg-[var(--bg-elev)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-dim)] sm:inline-flex">
              Esc
            </kbd>
          </div>

          {/* 结果区 */}
          <div
            ref={resultsListRef}
            className="min-h-[220px] flex-1 overflow-y-auto overscroll-contain p-2"
            role="listbox"
          >
            {status === "error" ? (
              <div className="flex min-h-[200px] flex-col items-center justify-center gap-3 px-8 text-center text-sm text-[var(--danger)]">
                <span>{t("searchFailed")}</span>
                <button
                  type="button"
                  onClick={() => void performSearch(normalizedQuery)}
                  className="cursor-pointer rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)]"
                >
                  {t("searchRetry")}
                </button>
              </div>
            ) : normalizedQuery && status === "ready" && results.length === 0 ? (
              <div className="flex min-h-[200px] flex-col items-center justify-center px-8 text-center">
                <MessageSquareText className="mb-3 h-8 w-8 text-[var(--text-dim)]/35" />
                <div className="text-sm font-medium text-[var(--text)]">{t("searchNoResults")}</div>
                <div className="mt-1 text-xs text-[var(--text-dim)]">{t("searchConversationsDesc")}</div>
              </div>
            ) : !normalizedQuery && flatItems.length === 0 ? (
              <div className="flex min-h-[200px] flex-col items-center justify-center px-8 text-center">
                <Search className="mb-3 h-8 w-8 text-[var(--text-dim)]/35" />
                <div className="text-sm text-[var(--text-dim)]">{t("searchConversationsDesc")}</div>
              </div>
            ) : (
              <fieldset className="m-0 border-0 p-0">
                {/* 分组标题行（11px 弱色 + 图标，对齐 LiveAgent） */}
                <div className="flex h-8 items-center gap-2 px-2 text-[11px] font-medium text-[var(--text-dim)]/75">
                  <GroupIcon className="h-3.5 w-3.5" />
                  <span>{groupLabel}</span>
                </div>
                <div className="space-y-0.5">
                  {flatItems.map(({ group }, index) => {
                    const updatedAt = formatUpdatedAt(group.taskUpdatedAt, zh);
                    const cwd = resolveDisplayCwd(group.taskCwd);
                    const meta = [cwd, updatedAt].filter(Boolean).join("  ·  ");
                    return (
                      <button
                        key={group.taskId}
                        type="button"
                        role="option"
                        aria-selected={index === activeIndex}
                        data-conversation-search-index={index}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => selectTask(group.taskId, group.hits[0]?.msgId)}
                        className={`w-full rounded-xl px-3 py-2.5 text-left outline-none transition-colors cursor-pointer ${
                          index === activeIndex
                            ? "bg-[var(--surface-hover)] text-[var(--text)]"
                            : "text-[var(--text)]/90 hover:bg-[var(--surface-hover)]/45"
                        }`}
                      >
                        <div className="truncate text-sm font-medium leading-5">{group.taskTitle}</div>
                        {/* 命中片段预览（最多 2 条，[...] 高亮） */}
                        {group.hits.slice(0, 2).map((hit) => (
                          <div key={hit.msgId} className="mt-0.5 line-clamp-2 text-xs leading-5 text-[var(--text-dim)]">
                            {renderSearchPreview(hit.snippet)}
                          </div>
                        ))}
                        {meta ? (
                          <div className="mt-1 truncate text-[11px] leading-4 text-[var(--text-dim)]/70" title={meta}>
                            {meta}
                          </div>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            )}
          </div>

          {/* 底部快捷键提示条（对齐 LiveAgent 无此条？截图有：↑↓ 选择 · ↵ 打开 · Esc 关闭） */}
          <div className="flex h-10 shrink-0 items-center justify-between border-t border-[var(--border)] px-4 text-[11px] text-[var(--text-dim)]">
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-1.5">
                <kbd className="rounded border border-[var(--border)] px-1 font-sans">↑</kbd>
                <kbd className="rounded border border-[var(--border)] px-1 font-sans">↓</kbd>
                {t("searchNavigate")}
              </span>
              <span className="flex items-center gap-1.5">
                <kbd className="rounded border border-[var(--border)] px-1 font-sans">↵</kbd>
                {t("searchOpen")}
              </span>
            </div>
            <span className="flex items-center gap-1.5">
              <kbd className="rounded border border-[var(--border)] px-1 font-sans">Esc</kbd>
              {t("searchClose")}
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
