import { Plus } from "lucide-react";
import { ProviderLogo } from "./ProviderLogo";
import type { ProviderItem } from "./types";
import { isProviderUsable } from "./types";
import { useTranslation } from "../../../i18n";

interface ProviderNavigationProps {
  providers: ProviderItem[];
  selectedId: string;
  onSelect: (id: string) => void;
  onAddProvider: () => void;
}

export function ProviderNavigation({
  providers,
  selectedId,
  onSelect,
  onAddProvider,
}: ProviderNavigationProps) {
  const { locale } = useTranslation();
  const isZh = locale === "zh-CN";

  const presetProviders = providers.filter((p) => !p.isCustom);
  const customProviders = providers.filter((p) => p.isCustom);

  return (
    <div className="flex flex-col w-64 border-r border-[var(--border)] bg-[var(--sidebar-bg)] h-full overflow-hidden select-none">
      {/* Header with Title and Add Button */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <span className="text-xs font-semibold text-[var(--sidebar-text-active)] uppercase tracking-wider">
          {isZh ? "模型服务商" : "Providers"}
        </span>
        <button
          type="button"
          onClick={onAddProvider}
          className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md text-[var(--accent)] hover:bg-[var(--sidebar-hover)] transition-colors cursor-pointer"
          title={isZh ? "添加自定义服务商" : "Add Custom Provider"}
        >
          <Plus className="w-3.5 h-3.5" />
          <span>{isZh ? "添加" : "Add"}</span>
        </button>
      </div>

      {/* Nav List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-4">
        {/* Preset Group */}
        <div>
          <div className="px-2 pb-1 text-[11px] font-medium text-[var(--sidebar-text)] opacity-60">
            {isZh ? "主流服务商" : "Preset Providers"}
          </div>
          <div className="space-y-0.5">
            {presetProviders.map((p) => {
              const isSelected = p.id === selectedId;
              const isConfigured = isProviderUsable(p);

              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onSelect(p.id)}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-all cursor-pointer ${
                    isSelected
                      ? "bg-[var(--sidebar-hover)] text-[var(--sidebar-text-active)] font-medium shadow-xs"
                      : "text-[var(--sidebar-text)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)]"
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <ProviderLogo id={p.id} className="w-4 h-4 shrink-0" />
                    <span className="truncate">{p.name}</span>
                  </div>
                  {/* Status Indicator */}
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 transition-colors ${
                      isConfigured
                        ? "bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.4)]"
                        : "bg-[var(--border)] opacity-60"
                    }`}
                    title={isConfigured ? (isZh ? "已配置并启用" : "Configured") : (isZh ? "未配置或未启用" : "Unconfigured")}
                  />
                </button>
              );
            })}
          </div>
        </div>

        {/* Custom Group (if any) */}
        {customProviders.length > 0 && (
          <div>
            <div className="px-2 pb-1 text-[11px] font-medium text-[var(--sidebar-text)] opacity-60">
              {isZh ? "自定义服务商" : "Custom Providers"}
            </div>
            <div className="space-y-0.5">
              {customProviders.map((p) => {
                const isSelected = p.id === selectedId;
                const isConfigured = isProviderUsable(p);

                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onSelect(p.id)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-all cursor-pointer ${
                      isSelected
                        ? "bg-[var(--sidebar-hover)] text-[var(--sidebar-text-active)] font-medium shadow-xs"
                        : "text-[var(--sidebar-text)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)]"
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <ProviderLogo id={p.id} className="w-4 h-4 shrink-0" />
                      <span className="truncate">{p.name}</span>
                    </div>
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        isConfigured
                          ? "bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.4)]"
                          : "bg-[var(--border)] opacity-60"
                      }`}
                      title={isConfigured ? "Configured" : "Unconfigured"}
                    />
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
