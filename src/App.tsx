import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import "./styles/global.css";
import { useConversationPool } from "./hooks/useConversationPool";
import {
  getEntrySnapshot,
  send as poolSend,
  editResend as poolEditResend,
  resolveApproval as poolResolveApproval,
} from "./lib/chat/conversationPool";
import { AutomationsPage } from "./components/automations/AutomationsPage";
import { useAutomationStore } from "./lib/automations/store";
import { ConversationSearchDialog } from "./components/search/ConversationSearchDialog";
import { McpHubPage } from "./components/mcp/McpHubPage";
import { MemoryPanel } from "./components/memory/MemoryPanel";
import { SkillsHubPage } from "./components/skills/SkillsHubPage";
import { Toaster } from "./components/lw/ui/toaster";
import { TaskProgressBar } from "./components/chat/TaskProgressBar";
import {
  isNotificationSoundEnabled,
  playNotificationSound,
  sendSystemNotification,
  summarizeOutcome,
} from "./lib/chat/taskNotifications";
import {
  subscribeTaskTerminal,
  onCompactionEvent,
  type TaskTerminalEvent,
} from "./lib/chat/conversationPool";
import { useConfirmDialog } from "./components/ui/ConfirmDialog";
import { toast } from "./components/lw/ui/toast";
import { useHubSettings } from "./store/hubSettingsStore";

// 上下文面板 MCP 分类枚举缓存（60s TTL；避免 HoverCard 反复触发服务器连接）
const MCP_BREAKDOWN_TTL_MS = 60_000;
let mcpBreakdownCache: { signature: string; at: number; json: string } | null = null;
import type { AutomationDuePayload } from "./lib/automations/types";
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
import { DEFAULT_SYSTEM_PROMPT, buildEnvironmentSection } from "./lib/providers/runAgentTurn";
import type { ApprovalDecision } from "./lib/providers/runAgentTurn";
import { ApprovalCard } from "./components/chat/ApprovalCard";
import { AskQuestionCard } from "./components/chat/AskQuestionCard";
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
import { appendMentionBlock, resolveMentions } from "./lib/chat/mentionResolver";
import { createMemoryOrganizerService, installMemoryOrganizerService } from "./lib/memory/organizer/service";
import { computeNextMemoryOrganizerRunAt } from "./components/memory/organizerSchedule";
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
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  useEffect(() => {
    loadProvidersConfigFromDisk(settings).then(setProviders).catch(console.error);
  }, [settings?.provider, settings?.modelId, currentView]);

  // Hub 设置切片订阅：技能/MCP 的启用状态变化驱动上下文容量面板的技能/MCP 分类
  const hubSkillsSettings = useHubSettings((s) => s.settings.skills);
  const hubMcpServers = useHubSettings((s) => s.settings.mcp.servers);

  // /clear 的二次确认弹窗（复用 checkpoint 回退同款 useConfirmDialog）
  const { confirm: confirmDialog, dialog: confirmDialogNode } = useConfirmDialog();

  // 上下文面板「技能」分类：当前生效的 buildSkillsSystemPrompt 注入文本（与发送链路同源）
  const [skillsSectionText, setSkillsSectionText] = useState("");
  useEffect(() => {
    let cancelled = false;
    if (!hubSkillsSettings.enabled || hubSkillsSettings.selected.length === 0) {
      setSkillsSectionText("");
      return;
    }
    void (async () => {
      try {
        const skillsLib = await import("./lib/skills/index");
        const discovery = await skillsLib.discoverSkills();
        const selectedSkills = discovery.skills.filter((skill) =>
          hubSkillsSettings.selected.includes(skill.name),
        );
        const text =
          selectedSkills.length > 0
            ? skillsLib.buildSkillsSystemPrompt({ rootDir: discovery.rootDir, selected: selectedSkills })
            : "";
        if (!cancelled) setSkillsSectionText(text);
      } catch (err) {
        console.warn("[context] skills breakdown unavailable (honest 0):", err);
        if (!cancelled) setSkillsSectionText("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hubSkillsSettings.enabled, hubSkillsSettings.selected]);

  // 上下文面板「MCP 工具」分类：启用服务器的工具 schema JSON（与发送链路同源；
  // 模块级 60s TTL 缓存，避免面板刷新反复连接服务器）
  const [mcpToolsJson, setMcpToolsJson] = useState("");
  useEffect(() => {
    const signature = hubMcpServers
      .map((srv) => `${srv.id}:${srv.enabled ? 1 : 0}:${srv.transport}`)
      .join("|");
    const cached = mcpBreakdownCache;
    if (cached && cached.signature === signature && Date.now() - cached.at < MCP_BREAKDOWN_TTL_MS) {
      setMcpToolsJson(cached.json);
      return;
    }
    let cancelled = false;
    void (async () => {
      let json = "";
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const enabled = hubMcpServers.filter((srv) => srv.enabled);
        if (enabled.length > 0) {
          const entries = await invoke<
            { serverId: string; serverLabel: string; name: string; description: string; inputSchema: unknown }[]
          >("mcp_list_tools", { servers: enabled });
          json = JSON.stringify(entries, null, 2);
        }
      } catch (err) {
        console.warn("[context] mcp breakdown unavailable (honest 0):", err);
        json = "";
      }
      mcpBreakdownCache = { signature, at: Date.now(), json };
      if (!cancelled) setMcpToolsJson(json);
    })();
    return () => {
      cancelled = true;
    };
  }, [hubMcpServers]);

  // MCP 工具枚举失败通知（发送链路产生）：toast 告知「启用了却没带上」的原因
  const mcpEnumNotice = useHubSettings((s) => s.mcpEnumNotice);
  const mcpEnumNoticeSeenRef = useRef(0);
  useEffect(() => {
    if (!mcpEnumNotice) return;
    if (mcpEnumNotice.at <= mcpEnumNoticeSeenRef.current) return;
    mcpEnumNoticeSeenRef.current = mcpEnumNotice.at;
    toast.error(mcpEnumNotice.message, { duration: 8000 });
  }, [mcpEnumNotice]);

  // Hub 三页（Skills/MCP/记忆）设置层：启动时装载 MCP 服务器列表（Rust JSON 为真相源）
  useEffect(() => {
    void useHubSettings.getState().hydrateMcp();
  }, []);

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

  // 快捷动作卡预填状态（EmptyState → 输入框；hooks 必须在设置页早退 return 之前声明）
  const [composerPrefill, setComposerPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const prefillNonceRef = useRef(0);

  // 全局会话搜索弹窗（侧栏放大镜触发）
  const [searchOpen, setSearchOpen] = useState(false);
  // 搜索跳转定位：目标消息 id（MessageList 滚动定位 + 高亮后置 null）
  const [scrollTargetMessageId, setScrollTargetMessageId] = useState<string | null>(null);

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


  // 工作区决议（活动任务优先）：活动任务严格跟随任务自身持久化的 project 字段（单一真相源，
  // 不依赖 UI 态 selectedProject 的同步时机——修复重启水合后自动恢复的任务回退 DefaultProject）；
  // 草稿态（无活动任务）才使用 selectedProject（侧边栏/输入框所选项目）。
  const workspaceProject = activeTask ? activeTask.project : selectedProject;
  const effectiveWorkspaceRoot = resolveWorkspaceRoot(workspaceProject);
  const isWorkspaceUnknown = !workspaceProject && !userHome;




  // 上下文面板「用户上下文（meta_user）」分类的记忆段：与 runAgentTurn 注入同源
  const [memorySectionText, setMemorySectionText] = useState("");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { buildMemoryOverviewSection, buildMemoryToolsSuffixSection } = await import(
          "./lib/memory/prompts/injection"
        );
        const overview = await buildMemoryOverviewSection(effectiveWorkspaceRoot || undefined);
        const text = overview
          ? `${overview}\n\n${buildMemoryToolsSuffixSection()}`
          : "";
        if (!cancelled) setMemorySectionText(text);
      } catch (err) {
        console.warn("[context] memory breakdown unavailable (honest 0):", err);
        if (!cancelled) setMemorySectionText("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [effectiveWorkspaceRoot]);

  const effectiveThinkingLevel =
    !isReasoningSupported || activeThinkingLevel === "off" || activeThinkingLevel === "default"
      ? undefined
      : activeThinkingLevel;

  // 会话池：每个任务一个独立 controller；切任务只换订阅目标，后台任务照常流式。
  const { state, stop, isStreaming } = useConversationPool(activeTaskId);

  // Keep ref of current messages and activeTaskId to prevent closure races and empty overrides
  // 上下文容量：真实 usage（最后一条 assistant apiMessage）+ 模型声明 contextWindow + 字符估算分类
  // meta_user 块展示文本（currentDate + 记忆段；技能单独成行，与注入结构一致）
  const metaUserDisplayText = [
    `# currentDate\nToday's date is ${new Date().toDateString()}.`,
    memorySectionText,
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");

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
        : "") +
      // ZCode 口径：Environment（env_info）属系统提示词类，计入「系统提示词」行
      `\n\n${buildEnvironmentSection(
        effectiveWorkspaceRoot,
        `${activeProviderId}/${activeModelId}`,
      )}`;
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
      skillsJson: skillsSectionText || undefined,
      mcpToolsJson: mcpToolsJson || undefined,
      metaUserJson: metaUserDisplayText || undefined,
      categoryContent: {
        messages: { buildContent: buildMessagesExport, language: "markdown" },
        systemPrompt: { buildContent: buildSystemPromptExport, language: "markdown" },
        systemTools: { buildContent: buildToolsExport, language: "json" },
        ...(skillsSectionText
          ? { skills: { buildContent: () => skillsSectionText, language: "markdown" } }
          : {}),
        ...(mcpToolsJson
          ? { mcpTools: { buildContent: () => mcpToolsJson, language: "json" } }
          : {}),
        ...(metaUserDisplayText
          ? { metaUser: { buildContent: () => metaUserDisplayText, language: "markdown" } }
          : {}),
      },
    });
  }, [
    state.messages,
    currentModel,
    effectiveWorkspaceRoot,
    skillsSectionText,
    mcpToolsJson,
    memorySectionText,
  ]);

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

  // 记忆页设置抽屉的「驱动模型」选择器选项：全部启用服务商下的启用模型
  //（value = "providerId::modelId"，group = 服务商名，供 ModelPicker 分组展示）
  const hubModelOptions = useMemo(
    () =>
      providers
        .filter((p) => p.enabled !== false)
        .flatMap((p) =>
          (p.models ?? [])
            .filter((m) => m.enabled !== false)
            .map((m) => ({ value: `${p.id}::${m.id}`, label: m.name || m.id, group: p.name })),
        ),
    [providers],
  );

  // P1-8：记忆 Organizer 调度服务（Run Now / 定时 one-shot）。providers/settings
  // 变化时重建（deps 引用最新值）；卸载 dispose 并摘除单例。
  useEffect(() => {
    const service = createMemoryOrganizerService({
      getSettings: () => useHubSettings.getState().settings.memory,
      advanceSchedule: (nowMs) => {
        useHubSettings.setState((prev) => {
          const organizerEnabled =
            prev.settings.memory.organizerEnabled &&
            prev.settings.memory.organizerSchedule.frequency !== "none";
          const nextRunAt = organizerEnabled
            ? computeNextMemoryOrganizerRunAt(prev.settings.memory.organizerSchedule, nowMs + 1_000)
            : null;
          return {
            settings: {
              ...prev.settings,
              memory: {
                ...prev.settings.memory,
                organizerLastRunAt: nowMs,
                organizerNextRunAt: nextRunAt,
              },
            },
          };
        });
      },
      resolveModelDeps: async (memory) => {
        const selected = memory.organizerModel;
        const providerId = selected?.customProviderId?.trim() ?? "";
        const modelId = selected?.model?.trim() ?? "";
        // organizerModel 未配置（或供应商已不存在）→ 回落主对话模型（LA fallback 语义）
        if (providerId && modelId) {
          const provider = providers.find((item) => item.id === providerId);
          if (provider) {
            if (!provider.apiKey.trim()) {
              throw new Error(`记忆整理模型供应商 API Key 为空：${provider.name || provider.id}`);
            }
            const apiFormatToType: Record<string, string> = {
              "openai-chat-completions": "openai",
              "openai-completions": "openai",
              "openai-responses": "openai",
              "anthropic-messages": "anthropic",
              "google-generative-ai": "gemini",
            };
            const { buildModel } = await import("./lib/providers/modelFactory");
            const { getStreamFnForApi } = await import("./lib/providers/runAgentTurn");
            const model = buildModel({
              provider: (apiFormatToType[provider.apiFormat] ?? "openai") as any,
              apiKey: provider.apiKey,
              modelId,
              baseUrl: provider.baseUrl,
            });
            const stream = await getStreamFnForApi(model.api);
            return {
              model,
              stream,
              api: model.api,
              label: `${provider.id}/${modelId}`,
              getApiKey: () => provider.apiKey,
              thinkingLevel: undefined,
            };
          }
        }
        const fallback = settingsRef.current;
        if (!fallback.apiKey?.trim()) {
          throw new Error("主对话模型未配置 API Key，且未选择独立的记忆整理模型。");
        }
        const { buildModel } = await import("./lib/providers/modelFactory");
        const { getStreamFnForApi } = await import("./lib/providers/runAgentTurn");
        const model = buildModel({
          provider: fallback.provider as any,
          apiKey: fallback.apiKey,
          modelId: fallback.modelId,
          baseUrl: fallback.baseUrl,
        });
        const stream = await getStreamFnForApi(model.api);
        return {
          model,
          stream,
          api: model.api,
          label: `${fallback.provider}/${fallback.modelId}`,
          getApiKey: () => fallback.apiKey,
          thinkingLevel: undefined,
        };
      },
      getWorkspaceRoot: () => effectiveWorkspaceRoot || "",
    });
    installMemoryOrganizerService(service);
    // 调试/测试入口：CDP 可直接验证执行链（生产无害——仅引用已装实例）
    (window as any).__memoryOrganizerPoke = () => service.poke();
    (window as any).__memoryOrganizerConfigure = () => service.configure();
    service.configure();
    return () => {
      installMemoryOrganizerService(null);
      service.dispose();
    };
  }, [providers, effectiveWorkspaceRoot]);

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
        // 真实元数据透传（No-Fallback）：未声明即为未知，由 buildModel 走
        // 「未知」语义（不发送 max_tokens / 不声明多模态 / 容量面板不渲染）
        contextWindow: currentModel?.contextWindow ?? null,
        maxOutputTokens: currentModel?.maxOutputTokens ?? null,
        supportsImage: currentModel?.supportsImage ?? null,
      },
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      maxSteps,
      workspaceRoot: effectiveWorkspaceRoot,
      thinkingLevel: effectiveThinkingLevel,
      approvalMode: activeApprovalMode,
      toolPolicies: activeTask?.toolPolicies,
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
      activeTask?.toolPolicies,
      currentModel?.contextWindow,
      currentModel?.maxOutputTokens,
      currentModel?.supportsImage,
    ],
  );

  // ---- 自动化调度派发（Rust 调度器 automation-due 事件 / 立即运行按钮）----
  // 到点后：创建任务（绑定自动化的模型与工作区）→ 会话池发送提示词 → 轮询收敛后回报结果。
  const dispatchAutomationRun = useCallback(
    (payload: AutomationDuePayload) => {
      const store = useAppStore.getState();
      const providerId = payload.modelProvider || settings.provider || "deepseek";
      const modelId = payload.modelId || settings.modelId || "";
      const provider = providers.find((p) => p.id === providerId);
      // 自动化所用模型的目录元数据（用于真实 contextWindow/maxTokens/supportsImage 透传）
      const automationModel = provider?.models?.find((m) => m.id === modelId) ?? null;
      const apiKey = provider?.apiKey ?? settings.apiKey ?? "";
      const isDemo = apiKey.trim().length === 0;
      const taskId = store.createTask(
        payload.title,
        payload.workspacePath ?? null,
        providerId,
        modelId,
        undefined,
        "full",
      );
      const accepted = poolSend(taskId, payload.prompt, {
        source: isDemo ? "faux" : (providerId as never),
        config: {
          provider: providerId as never,
          apiKey,
          modelId,
          baseUrl: provider?.baseUrl ?? settings.baseUrl ?? "",
          hasEffort: true,
          // 真实元数据透传（与 buildTurnOptions 同口径，No-Fallback）
          contextWindow: automationModel?.contextWindow ?? null,
          maxOutputTokens: automationModel?.maxOutputTokens ?? null,
          supportsImage: automationModel?.supportsImage ?? null,
        },
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        maxSteps: 0,
        workspaceRoot: resolveWorkspaceRoot(payload.workspacePath ?? null),
        thinkingLevel: undefined,
        approvalMode: "full",
      });
      if (!accepted) {
        void import("@tauri-apps/api/core").then(({ invoke }) =>
          invoke("automation_run_finished", { runId: payload.runId, status: "failed", taskId, error: "dispatch rejected" }).catch(() => {}),
        );
        return;
      }
      // claim 已推进 runCount/nextRunAt/lastRunAt：立即静默刷新列表
      void useAutomationStore.getState().refresh(true);
      // 轮询该任务直至收敛，回报运行结果（5s 间隔）
      const timer = window.setInterval(() => {
        const snap = getEntrySnapshot(taskId);
        if (snap.status === "streaming" || snap.messages.length === 0) return;
        const last = snap.messages[snap.messages.length - 1];
        if (last.status === "streaming" || last.status === "running") return;
        window.clearInterval(timer);
        const outcome =
          last.status === "done" ? "succeeded" : last.status === "error" ? "failed" : "stopped";
        void import("@tauri-apps/api/core").then(({ invoke }) =>
          invoke("automation_run_finished", {
            runId: payload.runId,
            status: outcome,
            taskId,
            error: last.error ?? null,
          }).catch(() => {}),
        );
        // 运行结束（结果/错误可能落在列表卡片上）：静默刷新
        void useAutomationStore.getState().refresh(true);
      }, 5000);
    },
    [providers, settings],
  );

  // ref 保持最新派发器身份：automation-due 事件监听只注册一次
  const dispatchAutomationRunRef = useRef(dispatchAutomationRun);
  dispatchAutomationRunRef.current = dispatchAutomationRun;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const stop = await listen<AutomationDuePayload>("automation-due", (event) => {
          dispatchAutomationRunRef.current(event.payload);
        });
        if (cancelled) stop();
        else unlisten = stop;
      } catch (err) {
        console.warn("[automations] automation-due listen unavailable (web mode)", err);
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // ---- 后台任务完成通知（E1，对齐 ZCode taskNotificationOrchestrator）----
  // 触发：任务跑到终态且（不是当前正在看的任务 或 窗口不可见）；同轮去重。
  const notifiedRunsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const handle = (event: TaskTerminalEvent) => {
      // 审批挂起的「终态」不是真终态——用户决策后还会继续，不通知（角标由 E2 处理）
      if (event.awaitingDecision) return;
      const runKey = `${event.taskId}:${event.outcome}:${event.lastAssistantText?.slice(0, 40) ?? ""}`;
      if (notifiedRunsRef.current.has(runKey)) return;
      notifiedRunsRef.current.add(runKey);
      // 上限保护：Set 无限增长没有意义，保留最近 200 条
      if (notifiedRunsRef.current.size > 200) {
        notifiedRunsRef.current = new Set(Array.from(notifiedRunsRef.current).slice(-100));
      }
      const isActiveVisible = event.taskId === activeTaskId && document.visibilityState === "visible";
      if (isActiveVisible) return; // 用户正在看的任务完成：不打扰
      const task = useAppStore.getState().tasks.find((t) => t.id === event.taskId);
      const title = task?.title ?? "后台任务";
      const body = summarizeOutcome(event.outcome, event.lastAssistantText, event.error);
      void sendSystemNotification(title, body);
      if (isNotificationSoundEnabled()) playNotificationSound();
    };
    return subscribeTaskTerminal(handle);
  }, [activeTaskId]);

  // ---- 压缩事件反馈（/compact 与自动压缩：skipped/failed/done 都给可见反馈）----
  useEffect(() => {
    if (!activeTaskId) return;
    return onCompactionEvent(activeTaskId, (event) => {
      if (event.type === "compaction_done") {
        toast.success(t("compactionDone").replace("{count}", String(event.turnCount ?? 0)), { duration: 4000 });
      } else if (event.type === "compaction_failed") {
        toast.error(t("compactionFailed").replace("{error}", event.error ?? ""), { duration: 6000 });
      } else if (event.type === "compaction_skipped" && event.manual) {
        toast.error(t("compactionNothing"), { duration: 4000 });
      }
    });
  }, [activeTaskId, t]);

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

  /**
   * 从某条回复创建分支（对齐 LiveAgent useBranchConversation / branch.rs 语义）：
   * 把此回复及之前的全部消息复制到一个新任务，原任务保持不变，随后切换到新任务。
   * 复制用持久化的权威行（conversation_load → conversation_sync 原样转存）。
   */
  const handleBranchFrom = useCallback(
    async (messageId: string) => {
      const sourceTaskId = activeTaskId;
      if (!sourceTaskId) return;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const rows = await invoke<
          {
            msg_id: string;
            seq: number;
            role: string;
            status: string;
            started_at: number | null;
            ended_at: number | null;
            tool_name: string | null;
            tool_call_id: string | null;
            is_error: boolean | null;
            truncated_by: string | null;
            error: string | null;
            thinking_started_at: number | null;
            thinking_duration_ms: number | null;
            parts: { part_index: number; kind: string; payload: string }[];
          }[]
        >("conversation_load", { taskId: sourceTaskId });
        const anchorIndex = rows.findIndex((r) => r.msg_id === messageId);
        if (anchorIndex === -1) return;
        // 保留锚点回复及其之前的全部行；seq 重排保证新任务内连续
        const prefixRows = rows.slice(0, anchorIndex + 1).map((r, i) => ({ ...r, seq: i }));
        const sourceTask = tasks.find((t) => t.id === sourceTaskId);
        const newTaskId = createTask(
          "新分支",
          sourceTask?.project ?? null,
          sourceTask?.providerId,
          sourceTask?.modelId,
          sourceTask?.thinkingLevel,
          sourceTask?.approvalMode,
        );
        await invoke("conversation_sync", { taskId: newTaskId, messages: prefixRows });
        setActiveTaskId(newTaskId);
        setFollowSignal((c) => c + 1);
      } catch (err) {
        console.error("[branch] failed:", err);
      }
    },
    [activeTaskId, tasks, createTask, setActiveTaskId],
  );

  /** `/clear`：二次确认后清空当前任务时间线（对齐 ZCode /clear 语义）。 */
  const handleClearConversation = useCallback(async () => {
    if (!activeTaskId) return;
    const confirmed = await confirmDialog({
      title: t("clearConfirmTitle"),
      description: t("clearConfirmDesc"),
      confirmLabel: t("confirmDelete"),
      cancelLabel: t("cancel"),
    });
    if (!confirmed) return;
    const { clearConversation } = await import("./lib/chat/conversationPool");
    clearConversation(activeTaskId);
  }, [activeTaskId, confirmDialog, t]);

  /** `/compact`：手动压缩（引擎=批次 D compaction.ts；忙时/无内容如实提示）。 */
  const handleCompactRequest = useCallback(() => {
    if (!activeTaskId) return;
    void (async () => {
      const { compactConversation } = await import("./lib/chat/conversationPool");
      const accepted = compactConversation(activeTaskId);
      if (!accepted) {
        toast.error(t("compactionNothing"), { duration: 4000 });
      }
    })();
  }, [activeTaskId, t]);

  const handleSend = (
    text: string,
    images?: { base64: string; mimeType: string }[],
    userAttachments?: { path: string; name: string; kind: "image" | "file"; previewUrl?: string }[],
  ) => {
    // @提及：先读取被引用文件/目录内容，挂到 user 消息尾部（对齐 ZCode/LiveAgent 注入语义）。
    // 解析失败不阻断发送（注入块内已如实标注 unavailable）。
    if (/@/.test(text)) {
      void (async () => {
        let outgoing = text;
        try {
          const { block } = await resolveMentions(text, effectiveWorkspaceRoot || "");
          outgoing = appendMentionBlock(text, block);
        } catch (err) {
          console.warn("[mentions] resolve failed (sending without context block):", err);
        }
        sendNow(outgoing, images, userAttachments);
      })();
      return true;
    }
    return sendNow(text, images, userAttachments);
  };

  /** 实际发送（handleSend 的同步主体；提及解析完成后调用的那段）。 */
  const sendNow = (
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

  if (currentView === "settings") {    return (
      <SettingsPage
        settings={settings}
        status={status}
        onChange={update}
        onBack={() => setCurrentView("workbench")}
      />
    );
  }

  // 快捷动作卡（EmptyState）：只把提示词填进输入框、聚焦光标到末尾，
  // **不自动发送**——用户可编辑后手动发送。nonce 单调递增保证重复点击同卡也触发。
  const handleQuickPrompt = (text: string) => {
    prefillNonceRef.current += 1;
    setComposerPrefill({ text, nonce: prefillNonceRef.current });
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
          <WorkspaceSidebar onNewTask={handleNewTask} onOpenSearch={() => setSearchOpen(true)} />
        </div>
      )}

      {/* 全局会话搜索弹窗（LiveAgent ConversationSearchDialog 移植） */}
      <ConversationSearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onOpenTask={(taskId, messageId) => {
          setActiveTaskId(taskId);
          setScrollTargetMessageId(messageId ?? null);
        }}
      />

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

        {/* Chat / Composer Area（automations/skills/mcp/memory 视图也保留侧边栏与顶栏，主区切换内容） */}
        <div className="flex-1 flex flex-col overflow-hidden relative">
          {currentView === "automations" ? (
            <AutomationsPage
              providers={providers}
              defaultProviderId={settings.provider || "deepseek"}
              defaultModelId={settings.modelId || ""}
              workspacePath={selectedProject ?? undefined}
              onDispatch={dispatchAutomationRun}
            />
          ) : currentView === "mcp" ? (
            <McpHubPage />
          ) : currentView === "memory" ? (
            <MemoryPanel workdir={effectiveWorkspaceRoot || undefined} modelOptions={hubModelOptions} />
          ) : currentView === "skills" ? (
            <SkillsHubPage />
          ) : !hasMessages ? (
            <div className="flex-1 flex flex-col items-center justify-start pt-28 md:pt-36 px-4 pb-8 overflow-y-auto">
              <div className="w-full px-[120px]">
                <EmptyState
                  demo={isDemo}
                  onQuickPrompt={handleQuickPrompt}
                  onOpenAutomations={() => setCurrentView("automations")}
                />
                {/* 快捷按钮与输入框间距（用户定档：聊天框下移、间距加大） */}
                <div className="mt-16 w-full">
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
                    prefillRequest={composerPrefill}
                    onClearConversation={() => void handleClearConversation()}
                    onCompactRequest={handleCompactRequest}
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
                      onBranchFrom={handleBranchFrom}
                      followSignal={followSignal}
                      pendingApproval={state.pendingApproval}
                      workspaceRoot={effectiveWorkspaceRoot}
                      scrollTargetMessageId={scrollTargetMessageId}
                      onScrollTargetDone={() => setScrollTargetMessageId(null)}
                    />
                  </div>
                  <div className="sticky bottom-0 w-full bg-[var(--bg)] px-6 sm:px-8 md:px-12 pb-2.5 pt-1 z-10 shrink-0">
                    {/* 任务清单进度条（对齐 LiveAgent TaskProgressBar）：有清单时显示在输入框上方 */}
                    <TaskProgressBar messages={state.messages} />
                    {/* 提问卡（ask_user_question 工具挂起）：模型等待用户作答 */}
                    {state.pendingApproval &&
                    (state.pendingApproval as { args?: { kind?: string } })?.args?.kind === "question" ? (
                      <AskQuestionCard
                        questions={((state.pendingApproval as { args?: { questions?: never[] } }).args?.questions ?? []) as never}
                        onAnswer={(answers) => {
                          if (activeTaskId)
                            poolResolveApproval(activeTaskId, { answers });
                        }}
                        onSkip={() => {
                          if (activeTaskId) poolResolveApproval(activeTaskId, "reject");
                        }}
                      />
                    ) : null}
                    {/* 审批卡（对齐 ZCode PermissionDialog）：工具执行前挂起时浮在输入框上方 */}
                    {state.pendingApproval &&
                    (state.pendingApproval as { args?: { kind?: string } })?.args?.kind !== "question" && (
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
                      // 工作区根：@提及候选、附件默认目录都依赖它（此前漏传 ⇒ 提示「root 不能为空」）
                      workspaceRoot={effectiveWorkspaceRoot}
                      onClearConversation={() => void handleClearConversation()}
                      onCompactRequest={handleCompactRequest}
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

        {/* 会话统计行（对齐 LiveAgent 底部统计条）：仅聊天工作台显示 */}
        {currentView === "workbench" && hasMessages && <SessionStatsBar stats={sessionStats} />}

        {/* Terminal Pane（仅聊天工作台显示） */}
        {currentView === "workbench" && isTerminalOpen && (
          <div className="h-64 border-t border-[var(--border)] flex-shrink-0 bg-[var(--bg-sunken)] overflow-hidden">
            <TerminalPane />
          </div>
        )}
      </div>

      {/* 右侧代码/变更预览面板（ZCode PreviewPane 移植） */}
      <CodeViewerPaneHost workspacePath={effectiveWorkspaceRoot || undefined} />

      {/* Hub 三页共用 toast 容器（LiveAgent toast-manager 移植；hub-scope 使弹层吃 LiveAgent 色板） */}
      <div className="hub-scope fixed z-[10010]">
        <Toaster dismissLabel={t("common.dismissNotification")} />
      </div>

      {/* /clear 二次确认弹窗 */}
      {confirmDialogNode}

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
