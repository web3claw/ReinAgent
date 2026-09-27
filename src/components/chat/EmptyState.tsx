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

  // 快捷动作卡：按钮显示 i18n 标签，点击**只预填**对应的固定提示词进输入框（不自动发送）。
  // fill 为用户定档的固定文案（2026-09-27）；idleTask 待自动化页面移植后改为页面导航。
  const prompts: { key: TranslationKey; icon: typeof BarChart2; fill: string }[] = [
    { key: "weeklyReport", icon: BarChart2, fill: "每周五总结这一周发生的事情。" },
    {
      key: "bugFix",
      icon: Bug,
      fill: "请分析以下终端报错日志，找出导致该错误的根本原因，并提供可以直接运行的修复代码示例。",
    },
    {
      key: "pptMake",
      icon: Presentation,
      fill: "先完整阅读所有文档和代码，掌握整个开发流程和进度，严格遵守开发规则，等待新需求",
    },
    { key: "idleTask", icon: Moon, fill: "闲时任务" },
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
                  onClick={() => onQuickPrompt(p.fill)}
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
