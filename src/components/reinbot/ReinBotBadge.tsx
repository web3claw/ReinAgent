import { useState } from "react";
import { CheckCircle2, Edit2, Link2, MessageSquare, ShieldCheck, Cpu } from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import { useTranslation } from "../../i18n";

export function ReinBotBadge() {
  const { reinBotName, setReinBotName } = useAppStore();
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const [tempName, setTempName] = useState(reinBotName);

  const handleSaveName = () => {
    if (tempName.trim()) {
      setReinBotName(tempName.trim());
    }
    setIsEditing(false);
  };

  return (
    <div className="flex flex-col items-center w-full px-4 pt-2 pb-6 select-none">
      {/* 挂绳夹扣金属件 */}
      <div className="flex flex-col items-center -mb-2 z-10">
        {/* 银灰色吊环 */}
        <div className="w-5 h-7 rounded-t-full border-2 border-[var(--border)] bg-[var(--bg-sunken)] shadow-sm" />
        {/* 金属卡扣方块 */}
        <div className="w-7 h-3 rounded-sm bg-[var(--border)] border border-[var(--border)] shadow-xs -mt-1" />
      </div>

      {/* 工牌主体卡片 */}
      <div className="relative w-full max-w-[340px] rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-lg overflow-hidden transition-all duration-200 hover:shadow-xl hover:border-[var(--brand)]/40">
        {/* 顶部挂孔镂空视觉 */}
        <div className="absolute top-2 left-1/2 -translate-x-1/2 w-8 h-1.5 rounded-full bg-[var(--bg)] border border-[var(--border)]" />

        {/* 卡片内层装饰背景 */}
        <div className="absolute -right-8 -bottom-8 w-32 h-32 rounded-full bg-[var(--brand)]/5 pointer-events-none blur-2xl" />

        <div className="flex items-center gap-4 mt-2">
          {/* 机器人头像 / 芯片方块 */}
          <div className="relative flex items-center justify-center w-16 h-16 rounded-xl bg-[var(--bg-sunken)] border border-[var(--border)] shadow-inner group">
            <div className="flex flex-col items-center justify-center">
              <Cpu className="w-8 h-8 text-[var(--brand)]" />
              <div className="flex items-center gap-1 mt-1">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--success-text)]" />
                <span className="text-[9px] font-mono text-[var(--text-muted)]">AI</span>
              </div>
            </div>
            {/* 绿标认证角标 */}
            <span className="absolute -bottom-1 -right-1 flex items-center justify-center w-5 h-5 rounded-full bg-[var(--surface)] border border-[var(--border)] shadow-xs text-[var(--success-text)]">
              <CheckCircle2 className="w-3.5 h-3.5 fill-[var(--success-text)] text-[var(--surface)]" />
            </span>
          </div>

          {/* 右侧信息区 */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 text-[10px] font-bold tracking-wider uppercase text-[var(--text-muted)]">
              <ShieldCheck className="w-3 h-3 text-[var(--brand)]" />
              <span>REINAGENT</span>
            </div>

            {/* 名称与改名 */}
            <div className="flex items-center gap-1.5 mt-0.5">
              {isEditing ? (
                <div className="flex items-center gap-1 w-full">
                  <input
                    type="text"
                    value={tempName}
                    onChange={(e) => setTempName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSaveName();
                      if (e.key === "Escape") setIsEditing(false);
                    }}
                    autoFocus
                    className="w-full text-base font-bold bg-[var(--bg)] border border-[var(--brand)] rounded px-1.5 py-0.5 text-[var(--text)] outline-none"
                  />
                  <button
                    onClick={handleSaveName}
                    className="px-2 py-0.5 text-xs bg-[var(--brand)] text-[var(--brand-fg)] rounded hover:opacity-90"
                  >
                    OK
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2 group/name cursor-pointer" onClick={() => setIsEditing(true)}>
                  <h3 className="text-lg font-bold text-[var(--text)] truncate hover:text-[var(--brand)] transition-colors">
                    {reinBotName}
                  </h3>
                  <button
                    type="button"
                    title={t("reinbotEditName")}
                    className="opacity-0 group-hover/name:opacity-100 text-[var(--text-muted)] hover:text-[var(--text)] transition-opacity"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>

            {/* 工号/编号 */}
            <div className="text-xs text-[var(--text-muted)] font-mono mt-0.5">
              {t("reinbotBadgeId")}
            </div>
          </div>
        </div>

        {/* 底部连接状态横条 */}
        <div className="mt-4 pt-3 border-t border-[var(--border)] flex items-center justify-between text-xs text-[var(--text-muted)]">
          <div className="flex items-center gap-1.5">
            <Link2 className="w-3.5 h-3.5 text-[var(--brand)]" />
            <span className="font-medium text-[var(--text)]">{t("reinbotStatusRemote")}</span>
          </div>

          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1 text-[11px] text-[var(--success-text)] bg-[var(--success-bg)]/20 px-2 py-0.5 rounded-full border border-[var(--success-border)]/30">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--success-text)]" />
              {t("reinbotStatusDaemon")}
            </span>
            <MessageSquare className="w-3.5 h-3.5 text-[var(--brand)] opacity-80" />
          </div>
        </div>
      </div>
    </div>
  );
}
