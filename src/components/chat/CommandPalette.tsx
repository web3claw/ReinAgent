/**
 * CommandPalette —— 全局命令面板（P2-G2，Ctrl/Cmd+K 呼出）。
 *
 * 形态：顶部居中浮层（backdrop 点击关闭）+ 过滤输入 + 命令列表。
 * 键盘：↑↓ 移动高亮、Enter 执行、Esc 关闭；大小写不敏感子串过滤
 * （label + keywords）。列表为空/无匹配时显示空态。
 * 命令注册表由 App 层组装（闭包持有各自 handler），本组件只管展示与分发。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search } from "lucide-react";
import { useTranslation } from "../../i18n";

export interface PaletteCommand {
  id: string;
  label: string;
  /** 过滤辅助词（小写即可） */
  keywords?: string;
  /** 执行（调用方负责关闭面板——默认 onClose 由本组件在执行后统一调用） */
  run: () => void;
}

export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 打开时重置并聚焦
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      // 等 portal 挂载后聚焦
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        (c.keywords ? c.keywords.toLowerCase().includes(q) : false),
    );
  }, [commands, query]);

  // 过滤结果变化时高亮回第一项；高亮项滚动进可视区
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, filtered.length]);

  if (!open) return null;

  const runCommand = (index: number) => {
    const command = filtered[index];
    if (!command) return;
    onClose();
    command.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((cur) => (filtered.length === 0 ? 0 : (cur + 1) % filtered.length));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((cur) => (filtered.length === 0 ? 0 : (cur - 1 + filtered.length) % filtered.length));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      runCommand(activeIndex);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-black/40 pt-[12vh] backdrop-blur-[2px]"
      onClick={onClose}
      onKeyDown={onKeyDown}
      role="dialog"
      aria-label={t("paletteTitle")}
    >
      <div
        className="w-[560px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-[var(--capsule-border)] bg-[var(--capsule-bg)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[var(--capsule-border)] px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-[var(--text-dim)]" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("palettePlaceholder")}
            className="w-full bg-transparent text-sm text-[var(--text)] placeholder-[var(--text-dim)] focus:outline-none"
            autoFocus
          />
          <kbd className="rounded border border-[var(--capsule-border)] px-1.5 py-0.5 text-[10px] text-[var(--text-dim)]">
            Esc
          </kbd>
        </div>
        <div ref={listRef} className="max-h-[46vh] overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-[var(--text-dim)]">
              {t("paletteEmpty")}
            </p>
          ) : (
            filtered.map((command, index) => (
              <button
                key={command.id}
                type="button"
                data-active={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => runCommand(index)}
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  index === activeIndex
                    ? "bg-[var(--surface-hover)] text-[var(--text)]"
                    : "text-[var(--text-secondary)] hover:text-[var(--text)]"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{command.label}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
