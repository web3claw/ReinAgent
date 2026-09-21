import { useTranslation } from "../../i18n";
import { Sparkles, Terminal, Code2 } from "lucide-react";

export function EmptyState({ demo }: { demo: boolean }) {
  const { t } = useTranslation();

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center max-w-lg mx-auto">
      <div className="w-12 h-12 rounded-2xl bg-[var(--accent)]/10 text-[var(--accent)] flex items-center justify-center mb-4">
        <Sparkles className="w-6 h-6" />
      </div>
      <h2 className="text-xl font-bold text-[var(--text-primary)] mb-2">
        {t("emptyTitle")}
      </h2>
      <p className="text-sm text-[var(--text-secondary)] mb-6 leading-relaxed">
        {demo
          ? "当前为演示模式：未填入 API Key，已连接合成数据与沙箱工具。"
          : t("emptySubtitle")}
      </p>

      <div className="grid grid-cols-2 gap-3 w-full text-left">
        <div className="p-3 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] hover:border-[var(--accent)]/50 transition-colors">
          <div className="flex items-center gap-2 font-medium text-xs text-[var(--text-primary)] mb-1">
            <Code2 className="w-4 h-4 text-blue-500" />
            <span>智能代码编写</span>
          </div>
          <p className="text-[11px] text-[var(--text-secondary)]">精准定位与安全单处修改</p>
        </div>
        <div className="p-3 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] hover:border-[var(--accent)]/50 transition-colors">
          <div className="flex items-center gap-2 font-medium text-xs text-[var(--text-primary)] mb-1">
            <Terminal className="w-4 h-4 text-emerald-500" />
            <span>集成 PTY 终端</span>
          </div>
          <p className="text-[11px] text-[var(--text-secondary)]">直接在底部执行 Shell 调试</p>
        </div>
      </div>
    </div>
  );
}
