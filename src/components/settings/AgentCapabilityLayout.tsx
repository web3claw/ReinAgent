/**
 * AgentCapabilityLayout —— 子智能体设置页布局原语。
 * PI-Desktop 移植：apps/desktop/src/components/settings/AgentCapabilityLayout.tsx（取子智能体页所需子集）。
 * 适配：PI 的 settings.css 专属类改写为本仓语义 token 的 Tailwind 类（视觉对齐 PI 截图）。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { cn } from "../lw/lib/utils";
import { AgentActivationSwitch } from "../lw/settings/AgentActivationSwitch";

/** 大小写不敏感子串匹配（任一字段命中即真）。 */
export function matchesCapabilitySearch(query: string, ...fields: Array<string | undefined>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((field) => (field ?? "").toLowerCase().includes(q));
}

/** 两击确认删除：3.2s 后自动解除（PI useArmedDelete 同参）。 */
export function useArmedDelete(): { armed: string | null; setArmed: (id: string | null) => void } {
  const [armed, setArmed] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const setArmedTimed = (id: string | null) => {
    if (timer.current) clearTimeout(timer.current);
    setArmed(id);
    if (id) {
      timer.current = setTimeout(() => setArmed(null), 3200);
    }
  };
  return { armed, setArmed: setArmedTimed };
}

export function AgentCapabilityPage({
  toolbar,
  children,
  className,
}: {
  toolbar?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-5", className)}>
      {toolbar}
      {children}
    </div>
  );
}

export function CapabilityToolbar({
  search,
  onSearchChange,
  searchPlaceholder,
  actions,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-[var(--text-dim)]" />
        <input
          type="text"
          value={search}
          placeholder={searchPlaceholder}
          onChange={(e) => onSearchChange(e.currentTarget.value)}
          className="h-8 w-64 rounded-lg border border-[var(--border)] bg-settings-tile pl-8 pr-7 text-xs text-[var(--text)] placeholder-[var(--text-dim)] focus:border-[var(--brand)] focus:outline-none"
        />
        {search ? (
          <button
            type="button"
            aria-label="clear search"
            onClick={() => onSearchChange("")}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-[var(--text-dim)] hover:text-[var(--text)]"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function CapabilityPanel({
  loading,
  loadingLabel,
  children,
}: {
  loading?: boolean;
  loadingLabel?: string;
  children: ReactNode;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-settings-tile px-4 py-8 text-xs text-[var(--text-dim)]">
        {loadingLabel}
      </div>
    );
  }
  return <div className="space-y-2">{children}</div>;
}

export function CapabilityGroupHeader({
  label,
  path,
  count,
}: {
  label: string;
  path?: string;
  count: number;
}) {
  return (
    <div className="flex items-center justify-between gap-3 pt-2 pb-1 first:pt-0">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-xs font-medium text-[var(--text-dim)]">{label}</span>
        {path ? (
          <code className="truncate rounded bg-[var(--bg)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-dim)]">
            {path}
          </code>
        ) : null}
      </div>
      <span className="shrink-0 rounded-full bg-[var(--bg)] px-2 py-0.5 text-[11px] tabular-nums text-[var(--text-dim)]">
        {count}
      </span>
    </div>
  );
}

export function CapabilityRow({
  glyph,
  name,
  badges,
  command,
  description,
  meta,
  actions,
  off,
}: {
  glyph: ReactNode;
  name: string;
  badges?: ReactNode;
  command?: string;
  description?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  off?: boolean;
}) {
  return (
    <div
      className={cn(
        "group/row flex items-start gap-3 rounded-xl bg-settings-tile p-4 transition-opacity",
        off && "opacity-55",
      )}
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--bg)] text-[var(--text-dim)]">
        {glyph}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("truncate text-sm font-semibold", off && "line-through opacity-70")}>
            {name}
          </span>
          {badges}
        </div>
        {command ? (
          <div className="mt-0.5 truncate font-mono text-xs text-[var(--text-dim)]">{command}</div>
        ) : null}
        {description ? (
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{description}</p>
        ) : null}
        {meta ? <div className="mt-2 flex flex-wrap gap-1">{meta}</div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">{actions}</div>
    </div>
  );
}

/** 工具 chip（meta code；PI 同款等宽小圆角）。 */
export function CapabilityToolChip({ tool }: { tool: string }) {
  return (
    <code className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-dim)]">
      {tool}
    </code>
  );
}

/** 「内置」/「仅全局」徽标。 */
export function CapabilityBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--bg)] px-2 py-0.5 text-[11px] font-medium tracking-wide text-[var(--text-dim)]">
      {label}
    </span>
  );
}

export function CapabilityEmpty({
  message,
  action,
}: {
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl bg-settings-tile px-4 py-8 text-center">
      <p className="text-xs text-[var(--text-dim)]">{message}</p>
      {action ? <div className="mt-3 flex justify-center">{action}</div> : null}
    </div>
  );
}

/** 行尾启用开关（复用 Hooks 页同款薄包装；busy 防抖由调用方控制）。 */
export function CapabilityToggle({
  checked,
  label,
  busy,
  onChange,
}: {
  checked: boolean;
  label: string;
  busy?: boolean;
  onChange: () => void;
}) {
  return (
    <AgentActivationSwitch
      checked={checked}
      title={label}
      disabled={busy}
      onToggle={onChange}
    />
  );
}
