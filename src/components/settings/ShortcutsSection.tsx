/**
 * ShortcutsSection —— 全局快捷键管理（P2-G2 尾巴）。
 *
 * 每行：动作名 + 当前绑定 + 「录制」（点击进入监听态，下一个按键组合即新绑定）
 * + 「重置默认」。冲突检测：新绑定与其它动作重复 → 拒绝并提示冲突对象。
 * 保存即时生效（G1 handler 每次按键实时查 kv 缓存，无需重启）。
 */

import { useEffect, useState } from "react";
import { Ban, RotateCcw } from "lucide-react";
import { useTranslation } from "../../i18n";
import {
  SHORTCUT_ACTIONS,
  getShortcutBindings,
  setShortcutBinding,
  shortcutFromEvent,
  type ShortcutBindings,
} from "../../lib/shortcuts/shortcuts";

export function ShortcutsSection() {
  const { t } = useTranslation();
  // 注册表 labelKey 是动态串，放宽 t 的键型（与 AssistantCodeCommentCards 的 tt 同模式）
  const tt = t as (key: string) => string;
  const [bindings, setBindings] = useState<ShortcutBindings>({});
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const refresh = () => setBindings(getShortcutBindings());
  useEffect(() => {
    refresh();
  }, []);

  // 录制态：window 捕获下一个按键组合
  useEffect(() => {
    if (!recordingId) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const binding = shortcutFromEvent(e);
      if (binding === null) return; // 无修饰键的按键忽略（等待有效组合）
      // 冲突检测：与其它动作的当前绑定比对
      const conflict = SHORTCUT_ACTIONS.find(
        (a) => a.id !== recordingId && (bindings[a.id] ?? a.defaultBinding) === binding,
      );
      if (conflict) {
        setFeedback(
          t("shortcutConflict")
            .replace("{binding}", binding)
            .replace("{action}", tt(conflict.labelKey)),
        );
        setRecordingId(null);
        return;
      }
      setShortcutBinding(recordingId, binding);
      setFeedback(null);
      setRecordingId(null);
      refresh();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true } as EventListenerOptions);
  }, [recordingId, bindings, t]);

  const reset = (id: string) => {
    const def = SHORTCUT_ACTIONS.find((a) => a.id === id);
    if (!def) return;
    setShortcutBinding(id, def.defaultBinding);
    setFeedback(null);
    refresh();
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--text-dim)]">{t("shortcutHint")}</p>
      {feedback ? (
        <p className="flex items-center gap-1.5 rounded-lg border border-[var(--warn-border)] bg-[var(--warn-bg)] px-3 py-2 text-xs text-[var(--warn-text)]">
          <Ban className="h-3.5 w-3.5 shrink-0" />
          {feedback}
        </p>
      ) : null}
      <div className="space-y-1.5">
        {SHORTCUT_ACTIONS.map((action) => {
          const binding = bindings[action.id] ?? action.defaultBinding;
          const recording = recordingId === action.id;
          return (
            <div
              key={action.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-2"
            >
              <span className="text-sm text-[var(--text)]">{tt(action.labelKey)}</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setFeedback(null);
                    setRecordingId(recording ? null : action.id);
                  }}
                  className={`min-w-[110px] rounded-lg border px-3 py-1 text-center font-mono text-xs transition-colors ${
                    recording
                      ? "border-[var(--brand)] bg-[var(--brand-dim)] text-[var(--brand)]"
                      : "border-[var(--border)] text-[var(--text)] hover:border-[var(--brand)]"
                  }`}
                >
                  {recording ? t("shortcutRecording") : binding}
                </button>
                <button
                  type="button"
                  onClick={() => reset(action.id)}
                  aria-label={t("shortcutReset")}
                  title={t("shortcutReset")}
                  className="rounded p-1 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
