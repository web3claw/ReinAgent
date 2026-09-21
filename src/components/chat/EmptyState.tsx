import { useMemo, useEffect, useState } from "react";
import { useTranslation, type TranslationKey } from "../../i18n";
import { Sparkles, BarChart2, Bug, Presentation, Moon } from "lucide-react";

interface EmptyStateProps {
  demo?: boolean;
  onQuickPrompt?: (text: string) => void;
}

export function EmptyState({ demo, onQuickPrompt }: EmptyStateProps) {
  const { t } = useTranslation();
  const [hour, setHour] = useState(new Date().getHours());

  useEffect(() => {
    const interval = setInterval(() => setHour(new Date().getHours()), 60000);
    return () => clearInterval(interval);
  }, []);

  const greetingKey: TranslationKey = useMemo(() => {
    if (hour >= 5 && hour < 12) return "goodMorning";
    if (hour >= 12 && hour < 18) return "goodAfternoon";
    return "goodEvening";
  }, [hour]);

  const prompts: { key: TranslationKey; icon: typeof BarChart2 }[] = [
    { key: "weeklyReport", icon: BarChart2 },
    { key: "bugFix", icon: Bug },
    { key: "pptMake", icon: Presentation },
    { key: "idleTask", icon: Moon },
  ];

  return (
    <div className="flex flex-col items-center relative w-full overflow-hidden">
      {/* Watermark */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-[0.04] select-none text-[var(--brand)]">
        <Sparkles style={{ width: 220, height: 220 }} />
      </div>

      <div className="z-10 flex flex-col items-center">
        <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-[var(--text)] text-center">
          {t(greetingKey)}
        </h2>

        {demo && (
          <p className="mt-2 text-xs text-amber-500/80 bg-amber-500/10 px-3 py-1 rounded-full border border-amber-500/20">
            {t("demoMode")}
          </p>
        )}

        {onQuickPrompt && (
          <div className="flex gap-3 mt-6">
            {prompts.map((p) => {
              const Icon = p.icon;
              return (
                <button
                  key={p.key}
                  onClick={() => onQuickPrompt(t(p.key))}
                  className="flex items-center gap-2 px-4 py-2 rounded-full border border-[var(--chip-border)] bg-[var(--chip-bg)] hover:bg-[var(--chip-hover)] text-[var(--text-primary)] text-sm cursor-pointer transition-colors shadow-sm"
                >
                  <Icon className="w-4 h-4" />
                  <span>{t(p.key)}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
