/**
 * AssistantChip —— 工作台顶栏的「当前助手」切换器。
 * 点击弹出助手菜单：选中即写入当前任务（assistantId + 采用其模型预设）；
 * 底部入口跳转助手管理页。
 */
import { useEffect, useState } from "react";
import { Bot, ChevronDown, Settings2 } from "lucide-react";
import { useTranslation } from "../../i18n";
import { useAppStore } from "../../store/useAppStore";
import {
  loadAssistantCatalog,
  type AssistantDef,
} from "../../lib/assistants/assistantDefs";

export function AssistantChip({
  assistantId,
  onPick,
}: {
  assistantId: string;
  onPick: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [defs, setDefs] = useState<AssistantDef[]>([]);

  // 挂载即加载目录（5s 缓存），否则未打开过弹层时 current 恒为空、label 永远回退「通用助手」
  useEffect(() => {
    void loadAssistantCatalog().then((cat) => setDefs(cat.assistants));
  }, [open]);

  const current = defs.find((d) => d.id === assistantId);
  const label = current?.name ?? t("assistantGeneral");

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] transition-colors select-none"
        title={t("assistantChipTitle")}
      >
        <Bot className="h-3.5 w-3.5" />
        <span className="max-w-[120px] truncate">{label}</span>
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] shadow-xl">
            <div className="max-h-72 overflow-y-auto py-1">
              {defs.map((def) => (
                <button
                  key={def.id}
                  type="button"
                  onClick={() => {
                    onPick(def.id);
                    setOpen(false);
                  }}
                  className={`flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--surface-hover)] ${
                    def.id === assistantId ? "bg-[var(--brand-dim)]" : ""
                  }`}
                >
                  <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--text-dim)]" />
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium text-[var(--text)]">
                      {def.name}
                    </span>
                    <span className="block truncate text-[11px] text-[var(--text-dim)]">
                      {def.description}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                useAppStore.getState().setCurrentView("assistants");
              }}
              className="flex w-full items-center gap-2 border-t border-[var(--border)] px-3 py-2 text-xs text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            >
              <Settings2 className="h-3.5 w-3.5" />
              {t("assistantManage")}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
