import { useEffect } from "react";
import "./styles/global.css";
import { useConversation } from "./lib/chat/useConversation";
import { useSettings } from "./lib/settings/useSettings";
import { MessageList } from "./components/chat/MessageList";
import { LexicalComposer } from "./components/chat/LexicalComposer";
import { EmptyState } from "./components/chat/EmptyState";
import { ProviderForm } from "./components/settings/ProviderForm";
import { TerminalPane } from "./components/terminal/TerminalPane";
import { DEFAULT_SYSTEM_PROMPT } from "./lib/providers/runAgentTurn";
import { useAppStore } from "./store/useAppStore";
import { useTranslation } from "./i18n";
import {
  Sun,
  Moon,
  Languages,
  Terminal,
  Settings,
  PlusCircle,
  Cpu,
  Sparkles,
} from "lucide-react";
import { getProviderMeta } from "./lib/providers/catalog";

export default function App() {
  const { settings, status, update } = useSettings();
  const theme = useAppStore((s) => s.theme);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const locale = useAppStore((s) => s.locale);
  const toggleLocale = useAppStore((s) => s.toggleLocale);
  const isTerminalOpen = useAppStore((s) => s.isTerminalOpen);
  const toggleTerminal = useAppStore((s) => s.toggleTerminal);
  const isSettingsOpen = useAppStore((s) => s.isSettingsOpen);
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const { t } = useTranslation();

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const isDemo = settings.apiKey.trim().length === 0;
  const source = isDemo ? "faux" : (settings.provider || "deepseek");
  const currentProviderMeta = getProviderMeta(settings.provider || "deepseek");

  const { state, send, stop, clear, isStreaming } = useConversation({
    source,
    config: {
      provider: settings.provider,
      apiKey: settings.apiKey,
      modelId: settings.modelId,
      baseUrl: settings.baseUrl,
    },
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
  });

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[var(--bg)] text-[var(--text)] select-none">
      <header className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border)] bg-[var(--bg-elev)] shrink-0 z-10">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 font-bold text-sm text-[var(--accent)] tracking-tight">
            <Sparkles className="w-4 h-4" />
            <span>ReinAgent</span>
          </div>

          <div className="h-4 w-px bg-[var(--border)]" />

          <div className="flex items-center gap-2">
            <span
              className={`px-2 py-0.5 rounded-full text-xs font-medium flex items-center gap-1.5 ${
                isDemo
                  ? "bg-amber-500/10 text-amber-500 border border-amber-500/20"
                  : "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20"
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  isDemo ? "bg-amber-500" : "bg-emerald-500 animate-pulse"
                }`}
              />
              <span>{isDemo ? t("demoMode") : t("realMode")}</span>
            </span>

            <span className="text-xs text-[var(--text-dim)] font-mono flex items-center gap-1">
              <Cpu className="w-3.5 h-3.5" />
              <span>{currentProviderMeta.name} / {settings.modelId}</span>
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1.5 text-xs">
          {state.messages.length > 0 && (
            <button
              type="button"
              onClick={clear}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[var(--bg-elev-2)] transition-colors"
              title={t("clearHistory")}
            >
              <PlusCircle className="w-3.5 h-3.5" />
              <span>{t("clearHistory")}</span>
            </button>
          )}

          <button
            type="button"
            onClick={toggleTerminal}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-md transition-colors ${
              isTerminalOpen
                ? "bg-[var(--accent)] text-white"
                : "text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[var(--bg-elev-2)]"
            }`}
            title={t("terminal")}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>{t("terminal")}</span>
          </button>

          <button
            type="button"
            onClick={toggleLocale}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[var(--bg-elev-2)] transition-colors"
            title="Switch Language"
          >
            <Languages className="w-3.5 h-3.5" />
            <span>{locale === "zh-CN" ? "EN" : "中"}</span>
          </button>

          <button
            type="button"
            onClick={toggleTheme}
            className="p-1.5 rounded-md text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[var(--bg-elev-2)] transition-colors"
            title={theme === "dark" ? t("lightMode") : t("darkMode")}
          >
            {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          <button
            type="button"
            onClick={toggleSettings}
            className={`p-1.5 rounded-md transition-colors ${
              isSettingsOpen
                ? "bg-[var(--accent)] text-white"
                : "text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[var(--bg-elev-2)]"
            }`}
            title={t("settings")}
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </header>

      {isSettingsOpen && (
        <div className="shrink-0 max-h-[50vh] overflow-y-auto border-b border-[var(--border)] shadow-md">
          <ProviderForm settings={settings} status={status} onChange={update} />
        </div>
      )}

      <main className="flex-1 flex flex-col min-h-0 relative">
        {state.messages.length === 0 ? (
          <EmptyState demo={isDemo} />
        ) : (
          <MessageList messages={state.messages} />
        )}

        <LexicalComposer isStreaming={isStreaming} onSend={send} onStop={stop} />

        <TerminalPane />
      </main>
    </div>
  );
}
