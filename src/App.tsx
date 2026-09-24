import { useState, useEffect, useRef } from "react";
import "./styles/global.css";
import { useConversation } from "./lib/chat/useConversation";
import { useSettings } from "./lib/settings/useSettings";
import { MessageList } from "./components/chat/MessageList";
import { ConversationNavigator } from "./components/chat/ConversationNavigator";
import { CodeViewerPaneHost } from "./preview/CodeViewerPaneHost";
import { LexicalComposer } from "./components/chat/LexicalComposer";
import { EmptyState } from "./components/chat/EmptyState";
import { TerminalPane } from "./components/terminal/TerminalPane";
import { WorkspaceSidebar } from "./components/sidebar/WorkspaceSidebar";
import { SettingsPage } from "./components/settings/SettingsPage";
import { DEFAULT_SYSTEM_PROMPT } from "./lib/providers/runAgentTurn";
import { resolveWorkspaceRoot, initUserHome } from "./lib/agent/workspace";
import { useAppStore } from "./store/useAppStore";
import { useTranslation } from "./i18n";
import { getProviderMeta } from "./lib/providers/catalog";
import { generateSessionTitle } from "./lib/chat/titleGenerator";
import { loadProvidersConfigFromDisk, type ProviderItem, type ModelItem } from "./components/settings/model-provider/types";
import {
  Terminal, PanelLeftClose, PanelLeft, Minus, Maximize2, X, AlertTriangle
} from "lucide-react";

export default function App() {
  const {
    theme,
    isTerminalOpen, toggleTerminal,
    isSidebarOpen, toggleSidebar,
    currentView, setCurrentView,
    activeTaskId, setActiveTaskId,
    createTask, updateTaskTitle, updateTaskModel,
    selectedProject, setSelectedProject,
    thinkingLevel,
  } = useAppStore();

  const { t } = useTranslation();
  const { settings, status, update } = useSettings();
  
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  useEffect(() => {
    loadProvidersConfigFromDisk(settings).then(setProviders).catch(console.error);
  }, [settings?.provider, settings?.modelId, currentView]);

  // 会话级当前模型选择（初始跟随当前任务或系统默认，聊天框切换时仅修改当前任务模型，绝不覆盖系统默认模型）
  const [sessionProviderId, setSessionProviderId] = useState<string>(settings.provider || "deepseek");
  const [sessionModelId, setSessionModelId] = useState<string>(settings.modelId || "");

  // 当系统默认设置更新时（例如用户在“服务商设置”中点击了“设为系统默认”）：
  // 若当前处于草稿模式或当前任务未自定义模型，同步更新会话模型
  const prevSettingsModelRef = useRef(settings.modelId);
  const prevSettingsProviderRef = useRef(settings.provider);
  useEffect(() => {
    if (prevSettingsModelRef.current !== settings.modelId || prevSettingsProviderRef.current !== settings.provider) {
      prevSettingsModelRef.current = settings.modelId;
      prevSettingsProviderRef.current = settings.provider;

      const currentTask = activeTaskId ? useAppStore.getState().tasks.find((t) => t.id === activeTaskId) : null;
      if (!currentTask || (!currentTask.providerId && !currentTask.modelId)) {
        setSessionProviderId(settings.provider || "deepseek");
        setSessionModelId(settings.modelId || "");
      }
    }
  }, [settings.provider, settings.modelId, activeTaskId]);

  const activeProviderId = sessionProviderId || settings.provider || "deepseek";
  const activeModelId = sessionModelId || settings.modelId || "";

  const currentProvider = providers.find((p) => p.id === activeProviderId);
  const currentModel: ModelItem | null = currentProvider?.models.find((m) => m.id === activeModelId) || null;
  // 推理能力兜底（对齐 LiveAgent）：未声明 effort 元数据的模型乐观视为支持思考
  // （等级选择器可用、默认档位走全局 thinkingLevel、可切 off 关闭）。
  // 思考内容仍然只渲染服务端真实流下来的，绝不伪造。
  const isReasoningSupported = true;

  // 当切换模型或配置加载完成时，若模型支持 effort 且定义了 defaultLevel，自动切换全局 thinkingLevel
  const prevModelIdRef = useRef<string>(activeModelId);
  useEffect(() => {
    const isModelChanged = prevModelIdRef.current !== activeModelId;
    prevModelIdRef.current = activeModelId;

    if (isReasoningSupported && currentModel?.effort) {
      const supported = currentModel.effort.supportedLevels || [];
      const currentLevel = useAppStore.getState().thinkingLevel;
      // 如果模型发生切换，或者当前等级不在支持列表中，强制对齐到模型 defaultLevel 或支持的第一项
      if (isModelChanged || !supported.includes(currentLevel as any)) {
        const nextLevel =
          (currentModel.effort.defaultLevel && supported.includes(currentModel.effort.defaultLevel))
            ? currentModel.effort.defaultLevel
            : supported[0] || "low";
        useAppStore.getState().setThinkingLevel(nextLevel);
      }
    }
  }, [activeModelId, isReasoningSupported, currentModel?.effort?.defaultLevel, currentModel?.effort?.supportedLevels]);

  const activeApiKey = currentProvider?.apiKey ?? settings.apiKey ?? "";
  const activeBaseUrl = currentProvider?.baseUrl ?? settings.baseUrl ?? "";
  const isDemo = activeApiKey.trim().length === 0;
  const source: import("./lib/providers/runAgentTurn").AgentSource = isDemo ? "faux" : (activeProviderId as any);
  const currentProviderMeta = getProviderMeta(activeProviderId as any);

  const [focusTrigger, setFocusTrigger] = useState(0);

  const maxSteps =
    thinkingLevel === "max"
      ? 70
      : thinkingLevel === "xhigh"
      ? 60
      : thinkingLevel === "high"
      ? 50
      : thinkingLevel === "medium"
      ? 40
      : thinkingLevel === "low"
      ? 30
      : 20; // default 为 20 步

  // 用户主目录：先读本地缓存保证首屏可用，再从 Tauri 后端拉取真实值刷新缓存（No-Fallback：拿不到则 UI 告警）
  const [userHome, setUserHome] = useState<string | null>(() => {
    try {
      return localStorage.getItem("reinagent-user-home");
    } catch {
      return null;
    }
  });
  useEffect(() => {
    initUserHome().then((home) => {
      if (home) setUserHome(home);
    });
  }, []);

  // 消息滚动容器 ref：承载对话问题导航条（ConversationNavigator）的锚点测量与跳转
  const chatScrollRef = useRef<HTMLDivElement>(null);

  const effectiveWorkspaceRoot = resolveWorkspaceRoot(selectedProject);
  const isWorkspaceUnknown = !selectedProject && !userHome;

  const effectiveThinkingLevel =
    !isReasoningSupported || thinkingLevel === "off" || thinkingLevel === "default"
      ? undefined
      : thinkingLevel;

  const { state, send, stop, clear, loadState, isStreaming } = useConversation({
    source,
    config: {
      provider: activeProviderId as any,
      apiKey: activeApiKey,
      modelId: activeModelId,
      baseUrl: activeBaseUrl,
      hasEffort: isReasoningSupported,
    },
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    maxSteps,
    thinkingLevel: effectiveThinkingLevel,
    workspaceRoot: effectiveWorkspaceRoot,
  });

  // Keep ref of current messages and activeTaskId to prevent closure races and empty overrides
  const currentMessagesRef = useRef(state.messages);
  currentMessagesRef.current = state.messages;

  const activeTaskIdRef = useRef(activeTaskId);
  activeTaskIdRef.current = activeTaskId;

  const prevTaskIdRef = useRef<string | null>(activeTaskId);
  // Mark whether activeTaskId transition was triggered by sending the first draft message
  const isPromotingDraftRef = useRef(false);

  // Helper to persist non-empty messages for a given taskId
  const persistTaskMessages = (taskId: string | null, messages: typeof state.messages) => {
    if (!taskId || messages.length === 0) return;
    try {
      localStorage.setItem(`reinagent-task-msg-${taskId}`, JSON.stringify(messages));
    } catch (e) {
      console.error("Failed to persist task messages", e);
    }
  };

  // When activeTaskId changes, persist previous task's messages and load next task's messages
  useEffect(() => {
    // If transitioning because of first message in draft, keep the ongoing conversation intact
    if (isPromotingDraftRef.current) {
      isPromotingDraftRef.current = false;
      prevTaskIdRef.current = activeTaskId;
      return;
    }

    const prevId = prevTaskIdRef.current;
    if (prevId && prevId !== activeTaskId) {
      // Only persist if previous task has valid non-empty messages
      persistTaskMessages(prevId, currentMessagesRef.current);
    }

    prevTaskIdRef.current = activeTaskId;

    if (!activeTaskId) {
      // Draft mode (empty state)
      clear();
      setSessionProviderId(settings.provider || "deepseek");
      setSessionModelId(settings.modelId || "");
    } else {
      // 还原该任务保存的模型配置（如果有），否则还原为系统默认
      const taskObj = useAppStore.getState().tasks.find((t) => t.id === activeTaskId);
      if (taskObj?.providerId && taskObj?.modelId) {
        setSessionProviderId(taskObj.providerId);
        setSessionModelId(taskObj.modelId);
      } else {
        setSessionProviderId(settings.provider || "deepseek");
        setSessionModelId(settings.modelId || "");
      }

      // Load saved messages for the active task
      try {
        const raw = localStorage.getItem(`reinagent-task-msg-${activeTaskId}`);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            loadState(parsed);
            return;
          }
        }
      } catch (e) {
        console.error("Failed to load task messages", e);
      }
      clear();
    }
  }, [activeTaskId]);

  // Persist current active task messages whenever messages change
  useEffect(() => {
    if (activeTaskId && state.messages.length > 0) {
      persistTaskMessages(activeTaskId, state.messages);
    }
  }, [activeTaskId, state.messages]);

  const handleNewTask = (project?: string | null) => {
    // If switching from an existing task, persist it first before clearing
    if (activeTaskIdRef.current) {
      persistTaskMessages(activeTaskIdRef.current, currentMessagesRef.current);
    }
    setActiveTaskId(null);
    if (project !== undefined) {
      setSelectedProject(project);
    }
    clear();
    setSessionProviderId(settings.provider || "deepseek");
    setSessionModelId(settings.modelId || "");
    // Trigger auto-focus on the input box
    setFocusTrigger((c) => c + 1);
  };

  const handleSend = (text: string) => {
    let targetTaskId = activeTaskId;

    // If currently in draft mode (no activeTaskId), create the task on first message
    if (!targetTaskId) {
      isPromotingDraftRef.current = true;
      const fallbackTitle = text.slice(0, 30).trim() || (t("newTask") || "新任务");
      targetTaskId = createTask(fallbackTitle, selectedProject, sessionProviderId, sessionModelId);
      setActiveTaskId(targetTaskId);

      // Trigger AI session title generation or heuristic summarization in background sidecar
      generateSessionTitle(text, {
        provider: settings.provider,
        apiKey: settings.apiKey,
        modelId: settings.modelId,
        baseUrl: settings.baseUrl,
      }).then((aiTitle) => {
        if (aiTitle && targetTaskId) {
          updateTaskTitle(targetTaskId, aiTitle);
        }
      }).catch((err) => {
        console.warn("Background AI title generation failed", err);
      });
    } else if (state.messages.length === 0) {
      const fallbackTitle = text.slice(0, 30).trim() || (t("newTask") || "新任务");
      updateTaskTitle(targetTaskId, fallbackTitle);
    }

    return send(text);
  };

  const handleRetry = () => {
    const msgs = state.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user") {
        const hasToolsSinceUser = msgs.slice(i + 1).some((m) => m.role === "tool");
        if (hasToolsSinceUser) {
          handleSend(t("retryPrompt") || "请重试刚才失败的操作");
        } else {
          handleSend(msgs[i].text);
        }
        return;
      }
    }
    handleSend(t("retryPrompt") || "请重试刚才失败的操作");
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

  const handleSelectModel = (nextProviderId: string, nextModelId: string) => {
    // 仅切换当前聊天会话使用的服务商与模型，绝不修改覆盖“服务商设置”里的系统默认模型
    setSessionProviderId(nextProviderId);
    setSessionModelId(nextModelId);
    if (activeTaskId) {
      updateTaskModel(activeTaskId, nextProviderId, nextModelId);
    }
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

        {/* 工作区未知告警条（No-Fallback：主目录不可得时如实告警，绝不编造路径） */}
        {isWorkspaceUnknown && (
          <div className="flex items-center gap-2 px-4 py-1.5 text-xs bg-[var(--warn-bg)] border-b border-[var(--warn-border)] text-[var(--warn-text)] flex-shrink-0">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>{t("workspaceUnknown")}</span>
          </div>
        )}

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
                    providerId={activeProviderId}
                    providerName={currentProvider?.name || currentProviderMeta.name}
                    modelId={activeModelId}
                    currentModel={currentModel}
                    providers={providers}
                    onSelectModel={handleSelectModel}
                    focusRequestTrigger={focusTrigger}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="relative flex-1 min-h-0 flex">
              <div ref={chatScrollRef} className="flex-1 overflow-y-auto min-h-0">
              <div className="min-h-full flex flex-col justify-between">
                <div className="w-full px-4 sm:px-6 md:px-10 pt-3 pb-36 flex-1">
                  <MessageList
                    messages={state.messages}
                    isStreaming={isStreaming}
                    onEditSend={handleSend}
                    onRetry={handleRetry}
                  />
                </div>
                <div className="sticky bottom-0 w-full bg-[var(--bg)] px-4 sm:px-6 md:px-10 pb-2.5 pt-1 z-10 shrink-0">
                  <LexicalComposer
                    isStreaming={isStreaming}
                    onSend={handleSend}
                    onStop={stop}
                    providerId={activeProviderId}
                    providerName={currentProvider?.name || currentProviderMeta.name}
                    modelId={activeModelId}
                    currentModel={currentModel}
                    providers={providers}
                    onSelectModel={handleSelectModel}
                    hasMessages={true}
                  />
                </div>
              </div>
              </div>
              <ConversationNavigator messages={state.messages} scrollRef={chatScrollRef} />
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

      {/* 右侧代码/变更预览面板（ZCode PreviewPane 移植） */}
      <CodeViewerPaneHost workspacePath={effectiveWorkspaceRoot || undefined} />
    </div>
  );
}
