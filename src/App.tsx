import { useEffect } from "react";
import "./styles/global.css";
import { useConversation } from "./lib/chat/useConversation";
import { useSettings } from "./lib/settings/useSettings";
import { MessageList } from "./components/chat/MessageList";
import { LexicalComposer } from "./components/chat/LexicalComposer";
import { EmptyState } from "./components/chat/EmptyState";
import { TerminalPane } from "./components/terminal/TerminalPane";
import { WorkspaceSidebar } from "./components/sidebar/WorkspaceSidebar";
import { SettingsPage } from "./components/settings/SettingsPage";
import { DEFAULT_SYSTEM_PROMPT } from "./lib/providers/runAgentTurn";
import { useAppStore } from "./store/useAppStore";
import { useTranslation } from "./i18n";
import { getProviderMeta } from "./lib/providers/catalog";
import {
  Terminal, PanelLeftClose, PanelLeft, Minus, Maximize2, X, PlusCircle
} from "lucide-react";

export default function App() {
  const {
    theme,
    isTerminalOpen, toggleTerminal,
    isSidebarOpen, toggleSidebar,
    currentView, setCurrentView,
    activeTaskId,
    createTask, updateTaskTitle,
    selectedProject,
  } = useAppStore();

  const { t } = useTranslation();
  const { settings, status, update } = useSettings();
  
  const isDemo = (settings?.apiKey || "").trim().length === 0;
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

  const handleNewTask = () => {
    clear();
  };

  const handleSend = (text: string) => {
    // If no active task or currently empty, create or name task with user prompt
    if (!activeTaskId || state.messages.length === 0) {
      const summary = text.slice(0, 30).trim() || "新任务";
      if (!activeTaskId) {
        createTask(summary, selectedProject);
      } else {
        updateTaskTitle(activeTaskId, summary);
      }
    }
    return send(text);
  };

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  if (currentView === "settings") {
    return (
      <SettingsPage
        settings={settings}
        status={status}
        onChange={update}
        onBack={() => setCurrentView("workbench")}
      />
    );
  }

  const handleQuickPrompt = (text: string) => {
    handleSend(text);
  };

  const hasMessages = state.messages.length > 0;

  return (
    <div className="flex h-screen w-full bg-[var(--bg)] text-[var(--text)] overflow-hidden">
      {/* Sidebar */}
      {isSidebarOpen && (
        <div className="flex-shrink-0 w-[260px] h-full border-r border-[var(--border)]">
          <WorkspaceSidebar onNewTask={handleNewTask} />
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Topbar */}
        <div className="h-12 border-b border-[var(--border)] flex items-center justify-between px-4 bg-[var(--bg)] flex-shrink-0">
          <div className="flex items-center gap-2">
            <button
              onClick={toggleSidebar}
              className="p-1.5 rounded hover:bg-[var(--surface-hover)] text-[var(--text-dim)] hover:text-[var(--text)] transition-colors"
              title="Toggle Sidebar"
            >
              {isSidebarOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeft className="w-4 h-4" />}
            </button>
          </div>
          <div className="flex items-center gap-2">
            {hasMessages && (
              <button
                type="button"
                onClick={clear}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)] transition-colors"
                title={t("clearHistory")}
              >
                <PlusCircle className="w-3.5 h-3.5" />
                <span>{t("clearHistory")}</span>
              </button>
            )}
            <button
              onClick={toggleTerminal}
              className={`p-1.5 rounded transition-colors flex items-center gap-1 text-sm ${isTerminalOpen ? 'bg-[var(--brand-dim)] text-[var(--brand)]' : 'hover:bg-[var(--surface-hover)] text-[var(--text-dim)] hover:text-[var(--text)]'}`}
              title="Toggle Terminal"
            >
              <Terminal className="w-4 h-4" />
            </button>
            <div className="w-px h-4 bg-[var(--border)] mx-1" />
            <button className="p-1.5 rounded hover:bg-[var(--surface-hover)] text-[var(--text-dim)] transition-colors">
              <Minus className="w-4 h-4" />
            </button>
            <button className="p-1.5 rounded hover:bg-[var(--surface-hover)] text-[var(--text-dim)] transition-colors">
              <Maximize2 className="w-4 h-4" />
            </button>
            <button className="p-1.5 rounded hover:bg-red-500 hover:text-white text-[var(--text-dim)] transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Chat / Composer Area */}
        <div className="flex-1 flex flex-col overflow-hidden relative">
          {!hasMessages ? (
            <div className="flex-1 flex flex-col items-center justify-start pt-28 md:pt-36 px-4 pb-8 overflow-y-auto">
              <div className="w-full px-[120px]">
                <EmptyState demo={isDemo} onQuickPrompt={handleQuickPrompt} />
                <div className="mt-8 w-full">
                  <LexicalComposer
                    isStreaming={isStreaming}
                    onSend={handleSend}
                    onStop={stop}
                    providerName={currentProviderMeta.name}
                    modelId={settings.modelId}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto min-h-0 relative">
              <div className="min-h-full flex flex-col justify-between">
                <div className="w-full px-3 sm:px-4 md:px-6 pt-3 pb-36 flex-1">
                  <MessageList messages={state.messages} onEditSend={handleSend} />
                </div>
                <div className="sticky bottom-0 w-full bg-[var(--bg)] px-3 sm:px-4 md:px-6 pb-2.5 pt-1 z-10 shrink-0">
                  <LexicalComposer
                    isStreaming={isStreaming}
                    onSend={handleSend}
                    onStop={stop}
                    providerName={currentProviderMeta.name}
                    modelId={settings.modelId}
                    hasMessages={true}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Terminal Pane */}
        {isTerminalOpen && (
          <div className="h-64 border-t border-[var(--border)] flex-shrink-0 bg-[var(--bg-sunken)] overflow-hidden">
            <TerminalPane />
          </div>
        )}
      </div>
    </div>
  );
}
