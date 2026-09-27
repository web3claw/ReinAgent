import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import "./styles/global.css";
import { useConversationPool } from "./hooks/useConversationPool";
import {
  send as poolSend,
  editResend as poolEditResend,
  resolveApproval as poolResolveApproval,
} from "./lib/chat/conversationPool";
import { useSettings } from "./lib/settings/useSettings";
import { MessageList } from "./components/chat/MessageList";
import { getRegisteredTurnOffset } from "./components/chat/MessageList";
import { ConversationNavigator } from "./components/chat/ConversationNavigator";
import { CodeViewerPaneHost } from "./preview/CodeViewerPaneHost";
import { SessionStatsBar } from "./components/chat/SessionStatsBar";
import { LexicalComposer } from "./components/chat/LexicalComposer";
import { EmptyState } from "./components/chat/EmptyState";
import { TerminalPane } from "./components/terminal/TerminalPane";
import { WorkspaceSidebar } from "./components/sidebar/WorkspaceSidebar";
import { SettingsPage } from "./components/settings/SettingsPage";
import { DEFAULT_SYSTEM_PROMPT } from "./lib/providers/runAgentTurn";
import type { ApprovalDecision } from "./lib/providers/runAgentTurn";
import { ApprovalCard } from "./components/chat/ApprovalCard";
import { resolveWorkspaceRoot, initUserHome } from "./lib/agent/workspace";
import { kvGet } from "./lib/storage/db";
import { useAppStore } from "./store/useAppStore";
import { useTranslation } from "./i18n";
import { getProviderMeta } from "./lib/providers/catalog";
import { generateSessionTitle } from "./lib/chat/titleGenerator";
import { buildContextUsageData } from "./lib/chat/contextUsage";
import { getTools } from "./lib/agent/tools";
import { CheckpointRewindProvider, formatCheckpointRewoundNotification } from "./lib/chat/checkpointRewind";
import { buildOutgoingPayload } from "./lib/chat/attachments";
import { loadProvidersConfigFromDisk, type ProviderItem, type ModelItem } from "./components/settings/model-provider/types";
import {
  Terminal, PanelLeftClose, PanelLeft, AlertTriangle
} from "lucide-react";

export default function App() {
  const {
    theme,
    isTerminalOpen, toggleTerminal,
    isSidebarOpen, toggleSidebar,
    currentView, setCurrentView,
    activeTaskId, setActiveTaskId,
    tasks,
    createTask, updateTaskTitle, updateTaskModel, updateTaskThinkingLevel,
    selectedProject, setSelectedProject,
    thinkingLevel,
  } = useAppStore();

  // 任务级隔离：推理等级/审批模式优先读活动任务的覆盖，缺省回退全局默认（新任务/草稿档位）。
  const activeTask = activeTaskId ? tasks.find((task) => task.id === activeTaskId) ?? null : null;
  const activeThinkingLevel = activeTask?.thinkingLevel ?? thinkingLevel;
  const activeApprovalMode = activeTask?.approvalMode ?? "full";

  const { t, locale } = useTranslation();
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

  // 当切换模型或配置加载完成时，若模型支持 effort 且定义了 defaultLevel，自动对齐推理档位。
  // 任务粒度（对齐 ZCode task-local thoughtLevel）：任务有显式覆盖且仍受支持 → 保留不动；
  // 覆盖不再受支持 → 对齐该模型 defaultLevel（只写该任务）；草稿态 → 对齐全局默认。
  const prevModelIdRef = useRef<string>(activeModelId);
  useEffect(() => {
    const isModelChanged = prevModelIdRef.current !== activeModelId;
    prevModelIdRef.current = activeModelId;

    if (isReasoningSupported && currentModel?.effort) {
      const supported = currentModel.effort.supportedLevels || [];
      const resolveNext = (currentLevel: string) => {
        if (isModelChanged || !supported.includes(currentLevel as any)) {
          return (currentModel.effort!.defaultLevel && supported.includes(currentModel.effort!.defaultLevel))
            ? currentModel.effort!.defaultLevel
            : supported[0] || "low";
        }
        return null;
      };
      if (activeTask) {
        const taskLevel = activeTask.thinkingLevel;
        if (taskLevel !== undefined) {
          // 只修正「覆盖不再受支持」的任务，绝不冲掉仍受支持的任务级覆盖。
          if (!supported.includes(taskLevel as any)) {
            const next = resolveNext(taskLevel);
            if (next) updateTaskThinkingLevel(activeTask.id, next as never);
          }
          return;
        }
        // 任务未覆盖：跟随全局默认，但要保证全局默认在该模型下受支持（对齐写全局）。
        const globalLevel = useAppStore.getState().thinkingLevel;
        const next = resolveNext(globalLevel);
        if (next) useAppStore.getState().setThinkingLevel(next as never);
        return;
      }
      // 草稿态：对齐全局默认（原行为）。
      const globalLevel = useAppStore.getState().thinkingLevel;
      const next = resolveNext(globalLevel);
      if (next) useAppStore.getState().setThinkingLevel(next as never);
    }
  }, [activeModelId, isReasoningSupported, currentModel?.effort?.defaultLevel, currentModel?.effort?.supportedLevels, activeTask?.id, activeTask?.thinkingLevel]);

  const activeApiKey = currentProvider?.apiKey ?? settings.apiKey ?? "";
  const activeBaseUrl = currentProvider?.baseUrl ?? settings.baseUrl ?? "";
  const isDemo = activeApiKey.trim().length === 0;
  const source: import("./lib/providers/runAgentTurn").AgentSource = isDemo ? "faux" : (activeProviderId as any);
  const currentProviderMeta = getProviderMeta(activeProviderId as any);

  const [focusTrigger, setFocusTrigger] = useState(0);

  // maxSteps 从**任务级**推理等级派生；完全访问模式下不设步数上限。
  // 0 = 无上限（agentRuntime 仅在 maxSteps > 0 时启用硬闸；注意 0 不能写成 undefined——
  // undefined 会在 runAgentTurn 里回退成 DEFAULT_MAX_STEPS=8）。
  const maxSteps =
    activeApprovalMode === "full"
      ? 0
      : activeThinkingLevel === "max"
      ? 600
      : activeThinkingLevel === "xhigh"
      ? 500
      : activeThinkingLevel === "high"
      ? 400
      : activeThinkingLevel === "medium"
      ? 300
      : activeThinkingLevel === "low"
      ? 200
      : 100; // default 为 100 步

  // 用户主目录：先读本地缓存保证首屏可用，再从 Tauri 后端拉取真实值刷新缓存（No-Fallback：拿不到则 UI 告警）
  const [userHome, setUserHome] = useState<string | null>(() => {
    try {
      return kvGet("reinagent-user-home");
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
  // 元素本体进 state：首次点击任务时消息分支在数据水合后才挂载，滚动 div 与 MessageList
  // 的相对挂载时序存在竞态——若虚拟列表在 ref 接上之前采样到 null 会永久停摆（行数 0）。
  // ref 回调 setState 保证元素挂载后必然触发一次渲染，让 useVirtualizer 稳定拿到元素。
  const [chatScrollEl, setChatScrollEl] = useState<HTMLDivElement | null>(null);


  const effectiveWorkspaceRoot = resolveWorkspaceRoot(selectedProject);
  const isWorkspaceUnknown = !selectedProject && !userHome;




  const effectiveThinkingLevel =
    !isReasoningSupported || activeThinkingLevel === "off" || activeThinkingLevel === "default"
      ? undefined
      : activeThinkingLevel;

  // 会话池：每个任务一个独立 controller；切任务只换订阅目标，后台任务照常流式。
  const { state, stop, isStreaming } = useConversationPool(activeTaskId);

  // Keep ref of current messages and activeTaskId to prevent closure races and empty overrides
  // 上下文容量：真实 usage（最后一条 assistant apiMessage）+ 模型声明 contextWindow + 字符估算分类
  const contextUsage = useMemo(() => {
    const lastAssistantApi = [...state.messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.apiMessage)?.apiMessage as
      | { usage?: { input?: number; output?: number; cacheRead?: number } }
      | undefined;
    const usage = lastAssistantApi?.usage;
    // pi-ai 口径：input = prompt_tokens − cached（不含缓存命中部分）。
    // 上下文实际消耗 = input + cacheRead + output；命中率 = cacheRead / (input + cacheRead)。
    const input = Number(usage?.input ?? 0);
    const cacheRead = Number(usage?.cacheRead ?? 0);
    const output = Number(usage?.output ?? 0);
    const used = input + cacheRead + output;
    const hitRate = input + cacheRead > 0 ? cacheRead / (input + cacheRead) : undefined;
    // 明细行点击查看真实内容：懒构建（点开才算），与请求实际发送的内容一致（No-Fallback）。
    const buildMessagesExport = (): string => {
      const parts: string[] = [];
      for (const m of state.messages) {
        if (m.role === "tool") {
          parts.push(`### 工具调用：${m.toolName ?? "unknown"}（${m.status}）`);
          const argsText = m.args ? JSON.stringify(m.args) : "";
          if (argsText) parts.push("\u0060\u0060\u0060json\n" + argsText + "\n\u0060\u0060\u0060");
          if (m.resultText) parts.push("结果：\n\u0060\u0060\u0060\n" + m.resultText + "\n\u0060\u0060\u0060");
          parts.push("");
          continue;
        }
        const roleLabel = m.role === "user" ? "用户" : "助手";
        parts.push(`### [${roleLabel}]`);
        if (m.thinking) parts.push("> 思考：\n> " + m.thinking.split("\n").join("\n> "));
        if (m.text) parts.push(m.text);
        parts.push("");
      }
      return parts.join("\n");
    };
    const buildSystemPromptExport = (): string =>
      DEFAULT_SYSTEM_PROMPT +
      (effectiveWorkspaceRoot
        ? `\n\nCurrent workspace root: ${effectiveWorkspaceRoot}. Relative paths in tool calls will automatically resolve against this root directory.`
        : "");
    const buildToolsExport = (): string => {
      const tools = getTools({ workspaceRoot: effectiveWorkspaceRoot });
      return tools
        .map((tool: { name?: string; description?: string; inputSchema?: unknown }) => {
          const schema = tool.inputSchema ? JSON.stringify(tool.inputSchema, null, 2) : "{}";
          return `## ${tool.name ?? "?"}\n\n${tool.description ?? ""}\n\n\u0060\u0060\u0060json\n${schema}\n\u0060\u0060\u0060`;
        })
        .join("\n\n---\n\n");
    };

    return buildContextUsageData({
      used,
      total: currentModel?.contextWindow,
      hitRate,
      messages: state.messages,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      toolsJson: JSON.stringify(getTools({ workspaceRoot: effectiveWorkspaceRoot })),
      categoryContent: {
        messages: { buildContent: buildMessagesExport, language: "markdown" },
        systemPrompt: { buildContent: buildSystemPromptExport, language: "markdown" },
        systemTools: { buildContent: buildToolsExport, language: "json" },
      },
    });
  }, [state.messages, currentModel, effectiveWorkspaceRoot]);

  // 会话统计：轮数 / 工具步数 / LLM 与工具累计耗时 / token 用量（真实 usage 累加）
  const sessionStats = useMemo(() => {
    let turns = 0;
    let steps = 0;
    let llmMs = 0;
    let toolMs = 0;
    let input = 0;
    let output = 0;
    let cacheReadTokens = 0;
    const now = Date.now();

    for (const m of state.messages) {
      if (m.role === "user") turns += 1;
      const started = m.startedAt;
      const running = m.status === "streaming" || m.status === "running";
      const end = m.endedAt ?? (running ? now : undefined);
      const duration = started !== undefined ? Math.max(0, (end ?? now) - started) : 0;
      if (m.role === "assistant") llmMs += duration;
      if (m.role === "tool") {
        steps += 1;
        toolMs += duration;
      }
      if (m.role === "assistant" && m.apiMessage) {
        const usage = (m.apiMessage as { usage?: { input?: number; output?: number; cacheRead?: number } }).usage;
        input += Number(usage?.input ?? 0);
        output += Number(usage?.output ?? 0);
        cacheReadTokens += Number(usage?.cacheRead ?? 0);
      }
    }

    return {
      turns,
      steps,
      contextPercent: contextUsage?.percent ?? 0,
      llmMs,
      toolMs,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens,
      hitRate: input + cacheReadTokens > 0 ? cacheReadTokens / (input + cacheReadTokens) : undefined,
    };
  }, [state.messages, contextUsage]);

  const currentMessagesRef = useRef(state.messages);
  currentMessagesRef.current = state.messages;

  const activeTaskIdRef = useRef(activeTaskId);
  activeTaskIdRef.current = activeTaskId;

  const prevTaskIdRef = useRef<string | null>(activeTaskId);
  // Mark whether activeTaskId transition was triggered by sending the first draft message
  const isPromotingDraftRef = useRef(false);

  // When activeTaskId changes: restore the task's model binding only (no abort, no state swap —
  // 池中每个任务的状态独立存活，切换只是换 UI 绑定).
  useEffect(() => {
    if (isPromotingDraftRef.current) {
      isPromotingDraftRef.current = false;
      prevTaskIdRef.current = activeTaskId;
      return;
    }

    prevTaskIdRef.current = activeTaskId;

    if (!activeTaskId) {
      // Draft mode (empty state)
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
    }
  }, [activeTaskId]);

  const handleNewTask = (project?: string | null) => {
    // 切回草稿态：在途任务留在池中继续跑（新建任务 ≠ 停止任何会话）
    setActiveTaskId(null);
    if (project !== undefined) {
      setSelectedProject(project);
    }
    setSessionProviderId(settings.provider || "deepseek");
    setSessionModelId(settings.modelId || "");
    // Trigger auto-focus on the input box
    setFocusTrigger((c) => c + 1);
  };

  // 轮次发送选项（send 与 editResend 共用；审批模式在发送瞬间冻结，整轮生效）。
  const buildTurnOptions = useCallback(
    (
      images?: { base64: string; mimeType: string }[],
      userAttachments?: { path: string; name: string; kind: "image" | "file"; previewUrl?: string }[],
    ) => ({
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
      workspaceRoot: effectiveWorkspaceRoot,
      thinkingLevel: effectiveThinkingLevel,
      approvalMode: activeApprovalMode,
      images,
      userAttachments,
    }),
    [
      source,
      activeProviderId,
      activeApiKey,
      activeModelId,
      activeBaseUrl,
      isReasoningSupported,
      maxSteps,
      effectiveWorkspaceRoot,
      effectiveThinkingLevel,
      activeApprovalMode,
    ],
  );

  // 编辑重发后的强制贴底（对齐 LiveAgent stickToBottom on run start）+ 回退 toast。
  const [followSignal, setFollowSignal] = useState(0);
  const [rewindToast, setRewindToast] = useState<{ level: "success" | "error"; message: string } | null>(null);
  const rewindToastTimerRef = useRef<number | null>(null);
  const showRewindToast = useCallback((info: Parameters<typeof formatCheckpointRewoundNotification>[0]) => {
    const notice = formatCheckpointRewoundNotification(info, locale === "zh-CN");
    setRewindToast(notice);
    if (rewindToastTimerRef.current !== null) window.clearTimeout(rewindToastTimerRef.current);
    rewindToastTimerRef.current = window.setTimeout(() => setRewindToast(null), 4500);
  }, [locale]);

  /**
   * 编辑重发（对齐 LiveAgent 硬截断语义）：锚点 user 消息原位替换为新文本，
   * 其后的旧分支（旧回复/工具调用）全部移除，随后作为全新一轮重跑。
   * 保留的图片附件经 fs_read_attachment_base64 重建原生 image block；
   * 文件附件折算为 [Attached file] 路径引用行。
   */
  const handleEditResend = useCallback(
    async (
      messageId: string,
      newText: string,
      keptAttachments: { path: string; name: string; kind: "image" | "file"; previewUrl?: string }[],
    ): Promise<boolean> => {
      const targetTaskId = activeTaskId;
      if (!targetTaskId) return false;
      const supportsImage = currentModel?.supportsImage === true;
      const { payload, imageInputs } = await buildOutgoingPayload(newText, keptAttachments, supportsImage);
      const accepted = poolEditResend(
        targetTaskId,
        messageId,
        payload,
        buildTurnOptions(imageInputs.length > 0 ? imageInputs : undefined, keptAttachments.length > 0 ? keptAttachments : undefined),
      );
      if (accepted) setFollowSignal((c) => c + 1);
      return accepted;
    },
    [activeTaskId, currentModel?.supportsImage, buildTurnOptions],
  );

  /**
   * 以原始提问重发某条回复所在的轮（对齐 LiveAgent retry = 截断该回复及其后内容后重跑）。
   * 文本沿用锚点 user 消息的原始载荷；图片直接复用其权威 apiMessage 里的原生 image block
   * （免重读文件，跨轮不失效）。
   */
  const handleRetryFrom = useCallback(
    (messageId: string) => {
      const targetTaskId = activeTaskId;
      if (!targetTaskId) return;
      const msgs = state.messages;
      const messageIndex = msgs.findIndex((m) => m.id === messageId);
      if (messageIndex === -1) return;
      let anchorIndex = -1;
      for (let i = messageIndex; i >= 0; i -= 1) {
        if (msgs[i].role === "user") {
          anchorIndex = i;
          break;
        }
      }
      if (anchorIndex === -1) return;
      const anchor = msgs[anchorIndex];
      // pi-ai 的 UserMessage.content 既可能是字符串（纯文本）也可能是块数组，必须先判型
      const apiContent: unknown = anchor.apiMessage?.content;
      const contentBlocks = Array.isArray(apiContent)
        ? (apiContent as { type?: string; data?: string; mimeType?: string }[])
        : [];
      const images = contentBlocks
        .filter((b) => b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string")
        .map((b) => ({ base64: b.data as string, mimeType: b.mimeType as string }));
      const attachments = (anchor.attachments ?? []).map((a) => ({
        path: a.path,
        name: a.name,
        kind: a.kind,
        previewUrl: a.previewUrl,
      }));
      const accepted = poolEditResend(
        targetTaskId,
        anchor.id,
        anchor.text,
        buildTurnOptions(images.length > 0 ? images : undefined, attachments.length > 0 ? attachments : undefined),
      );
      if (accepted) setFollowSignal((c) => c + 1);
    },
    [activeTaskId, state.messages, buildTurnOptions],
  );

  const handleSend = (
    text: string,
    images?: { base64: string; mimeType: string }[],
    userAttachments?: { path: string; name: string; kind: "image" | "file"; previewUrl?: string }[],
  ) => {
    let targetTaskId = activeTaskId;

    // If currently in draft mode (no activeTaskId), create the task on first message
    if (!targetTaskId) {
      isPromotingDraftRef.current = true;
      const fallbackTitle = text.slice(0, 30).trim() || (t("newTask") || "新任务");
      // 草稿所选的推理等级/审批模式随任务落库，实现任务级隔离（此后调整只影响该任务）。
      const draftState = useAppStore.getState();
      targetTaskId = createTask(
        fallbackTitle,
        selectedProject,
        sessionProviderId,
        sessionModelId,
        draftState.thinkingLevel,
        draftState.approvalMode,
      );
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

    // 草稿提升竞态：setActiveTaskId 后 hook 闭包里的 taskId 仍是旧的（null），
    // 必须用新 taskId 直接调池（池的 ensureEntry 会为新任务建条目）。
    return poolSend(targetTaskId, text, buildTurnOptions(images, userAttachments));
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
                    contextUsage={contextUsage}
                    workspaceRoot={effectiveWorkspaceRoot}
                  />
                </div>
              </div>
            </div>
          ) : (
            <CheckpointRewindProvider
              conversationId={activeTaskId ?? undefined}
              disabled={isStreaming}
              resolveAuthorizedRoots={async () => (effectiveWorkspaceRoot ? [effectiveWorkspaceRoot] : [])}
              onRewound={showRewindToast}
            >
              <div className="relative flex-1 min-h-0 flex">
                <div
                  ref={(el) => {
                    chatScrollRef.current = el;
                    setChatScrollEl(el);
                  }}
                  data-scroll-viewport
                  className="flex-1 overflow-y-auto min-h-0"
                >
                <div className="min-h-full flex flex-col justify-between">
                  <div className="w-full px-6 sm:px-8 md:px-12 pt-3 pb-36 flex-1">
                    <MessageList
                      messages={state.messages}
                      isStreaming={isStreaming}
                      retryAttempts={state.retryAttempts}
                      retrying={state.retrying}
                      scrollRef={chatScrollRef}
                      scrollEl={chatScrollEl}
                      onEditSend={handleSend}
                      onEditResend={handleEditResend}
                      onRetryFrom={handleRetryFrom}
                      followSignal={followSignal}
                      workspaceRoot={effectiveWorkspaceRoot}
                    />
                  </div>
                  <div className="sticky bottom-0 w-full bg-[var(--bg)] px-6 sm:px-8 md:px-12 pb-2.5 pt-1 z-10 shrink-0">
                    {/* 审批卡（对齐 ZCode PermissionDialog）：工具执行前挂起时浮在输入框上方 */}
                    {state.pendingApproval && (
                      <ApprovalCard
                        request={state.pendingApproval}
                        onDecide={(decision: ApprovalDecision) => {
                          if (activeTaskId) poolResolveApproval(activeTaskId, decision);
                        }}
                      />
                    )}
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
                      contextUsage={contextUsage}
                    />
                  </div>
                </div>
                </div>
                <ConversationNavigator
                        messages={state.messages}
                        scrollRef={chatScrollRef}
                        measureFallback={getRegisteredTurnOffset}
                      />
              </div>
            </CheckpointRewindProvider>
          )}
        </div>

        {/* 会话统计行（对齐 LiveAgent 底部统计条）：仅在有消息的任务视图显示，首页不渲染 */}
        {hasMessages && <SessionStatsBar stats={sessionStats} />}

        {/* Terminal Pane */}
        {isTerminalOpen && (
          <div className="h-64 border-t border-[var(--border)] flex-shrink-0 bg-[var(--bg-sunken)] overflow-hidden">
            <TerminalPane />
          </div>
        )}
      </div>

      {/* 右侧代码/变更预览面板（ZCode PreviewPane 移植） */}
      <CodeViewerPaneHost workspacePath={effectiveWorkspaceRoot || undefined} />

      {/* 回退结果 toast（对齐 LiveAgent addNotify：成功/问题分级，底部右侧悬浮） */}
      {rewindToast && (
        <div
          className={`fixed bottom-5 right-5 z-[80] max-w-sm rounded-lg border px-4 py-2.5 text-xs shadow-2xl ${
            rewindToast.level === "error"
              ? "border-[var(--warn-border)] bg-[var(--warn-bg)] text-[var(--warn-text)]"
              : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
          }`}
          role="status"
        >
          {rewindToast.message}
        </div>
      )}

    </div>
  );
}
