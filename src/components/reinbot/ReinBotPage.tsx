import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  Bot,
  ArrowUp,
  Plus,
  Mic,
  PanelRightOpen,
  PanelRightClose,
  Cpu,
  Square,
  Loader2,
  Trash2,
  Paperclip,
  Link2,
  FileText,
  X,
  ArrowLeft,
  ChevronDown,
  Copy,
  Reply,
  CheckCircle2,
  AlertCircle,
  Terminal,
  LayoutDashboard,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { useAppStore, type AppTask } from "../../store/useAppStore";
import { useTranslation } from "../../i18n";
import { ReinBotWorkspace } from "./ReinBotWorkspace";
import { ReinBotTaskDetail } from "./ReinBotTaskDetail";
import { ReinBotFileViewer } from "./ReinBotFileViewer";
import {
  getTaskExecutionStatus,
  subscribeStreaming,
} from "../../lib/chat/conversationPool";
import { runAgentTurn, type AgentSource } from "../../lib/providers/runAgentTurn";
import { useComposerStt, type SttComposerHandle, type SttPushToTalkHandle } from "../../lib/stt/useComposerStt";
import { isProviderConfigured, loadSttSettings, type SttSettings } from "../../lib/stt/settings";
import { isPushToTalkKey } from "../../lib/stt/pushToTalk";
import { desktopSttTransport } from "../../lib/stt/desktopSttTransport";
import { toast } from "../lw/ui/toast";
import { MarkdownText } from "../chat/MarkdownText";
import { loadProvidersConfigFromDisk, formatModelContextWindowLabel, type ProviderItem, type ApiFormatType } from "../settings/model-provider/types";
import { kvGet, kvSet, kvGetJSON, kvSetJSON } from "../../lib/storage/db";
import { extractLinkedTasks, buildLinkedTasksPromptContext } from "../../lib/reinbot/taskContextResolver";
import { formatModelKey, parseModelKey, resolveActiveModelInfo } from "../../lib/reinbot/modelKeyResolver";
import { classifyPaste, utf8ByteLength, createPastedTextFilename } from "../../lib/chat/pasteRouting";
import { getReinBotWorkspaceRoot, ensureReinBotWorkspace } from "../../lib/agent/workspace";
import { createReinBotTaskTool } from "../../lib/reinbot/reinBotTools";

export interface ReinBotAttachment {
  path: string;
  name: string;
  kind: "image" | "file";
  previewUrl?: string;
}

interface ReinBotMessage {
  id: string;
  sender: "bot" | "user";
  text: string;
  time: number;
  attachments?: ReinBotAttachment[];
}

export interface ReinBotPageProps {
  workspaceRoot?: string;
  providerId?: string;
  modelId?: string;
  apiKey?: string;
  baseUrl?: string;
  source?: AgentSource;
  apiFormat?: ApiFormatType;
  onOpenSttSettings?: () => void;
  onRegisterPushToTalk?: (handle: SttPushToTalkHandle | null) => void;
  onDispatchTask?: (taskId: string, prompt: string, workspacePath?: string) => void;
}

const KV_REINBOT_MESSAGES_KEY = "reinagent-reinbot-messages";
const KV_REINBOT_MODEL_KEY = "reinagent-reinbot-selected-model";

function formatMessageTime(timestamp: number) {
  if (!timestamp) return "";
  const d = new Date(timestamp);
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

const createDefaultWelcomeMessage = (botName: string): ReinBotMessage => ({
  id: "welcome-msg",
  sender: "bot",
  text: `嗨，我是 ${botName}！\n\n想做什么事，直接跟我说！改代码、修 bug、审 PR、查资料，这些我都接得住。你专心做你的，有进展或需要你拿主意的事，我会回来找你。\n\n我现在叫 ${botName}，你也可以给我换个别的名字，以后随时能改。`,
  time: Date.now(),
});

const getInitialReinBotMessages = (botName: string): ReinBotMessage[] => {
  if (typeof window !== "undefined") {
    try {
      const saved = kvGetJSON<ReinBotMessage[]>(KV_REINBOT_MESSAGES_KEY);
      if (Array.isArray(saved) && saved.length > 0) {
        return saved;
      }
    } catch (e) {
      console.warn("[ReinBot] Failed to read saved messages:", e);
    }
  }
  return [createDefaultWelcomeMessage(botName)];
};

/** 用户消息中的 @任务[xxx] 标签渲染 */
function renderMessageWithTaskPills(
  text: string,
  tasks: AppTask[],
  onNavigateTask: (taskId: string) => void,
  isUserMessage = false
) {
  if (!text) return null;
  const regex = /@任务\[([^\]]+)\]/g;
  const parts: (string | { type: "task"; title: string; task?: AppTask })[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const taskName = match[1];
    const task = tasks.find(
      (t) => t.title?.trim() === taskName.trim() || t.id?.trim() === taskName.trim()
    );
    parts.push({ type: "task", title: taskName, task });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return (
    <>
      {parts.map((part, idx) => {
        if (typeof part === "string") {
          return <span key={idx}>{part}</span>;
        }
        const status = part.task ? getTaskExecutionStatus(part.task.id) : "idle";
        return (
          <button
            key={idx}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (part.task) {
                onNavigateTask(part.task.id);
              }
            }}
            title={
              part.task
                ? `点击在右侧查看任务详情: ${part.task.title}`
                : `关联任务: ${part.title} (未找到匹配任务)`
            }
            className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 mx-1 rounded-md text-xs font-medium align-baseline transition-all cursor-pointer shadow-xs border ${
              isUserMessage
                ? "bg-white/20 hover:bg-white/30 text-white border-white/30 active:scale-95"
                : "bg-[var(--surface-hover)] hover:bg-[var(--surface-active)] text-[var(--text)] border-[var(--border)]"
            }`}
          >
            {status === "running" ? (
              <Loader2 className="w-3 h-3 animate-spin text-[var(--brand)] shrink-0" />
            ) : status === "done" ? (
              <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
            ) : status === "error" ? (
              <AlertCircle className="w-3 h-3 text-rose-400 shrink-0" />
            ) : (
              <Terminal className="w-3 h-3 shrink-0" />
            )}
            <span>@任务[{part.title}]</span>
          </button>
        );
      })}
    </>
  );
}

/** 机器人回复消息内容渲染：支持图三的运行转圈与完成/失败图标卡片 */
function renderBotMessageContent(
  text: string,
  tasks: AppTask[],
  onNavigateTask: (taskId: string) => void
) {
  if (!text) return null;
  const regex = /(@任务\[[^\]]+\])/g;
  const segments = text.split(regex);
  if (segments.length === 1) {
    return <MarkdownText text={text} />;
  }

  return (
    <div className="space-y-2">
      {segments.map((seg, idx) => {
        const match = /^@任务\[([^\]]+)\]$/.exec(seg);
        if (match) {
          const taskName = match[1];
          const task = tasks.find(
            (t) => t.title?.trim() === taskName.trim() || t.id?.trim() === taskName.trim()
          );
          const status = task ? getTaskExecutionStatus(task.id) : "idle";
          return (
            <div key={idx} className="my-1.5">
              <button
                type="button"
                onClick={() => {
                  if (task) onNavigateTask(task.id);
                  else onNavigateTask(taskName);
                }}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-hover)] hover:bg-[var(--bg-sunken)] hover:border-[var(--brand)]/40 transition-all cursor-pointer shadow-xs text-xs font-medium text-[var(--text)] group"
              >
                <Terminal className="w-3.5 h-3.5 text-[var(--brand)] shrink-0" />
                <span className="font-semibold text-[var(--text)] truncate max-w-[260px]">
                  {taskName}
                </span>
                {status === "running" ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--brand)] shrink-0 ml-1" />
                ) : status === "done" ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0 ml-1" />
                ) : status === "error" ? (
                  <AlertCircle className="w-3.5 h-3.5 text-rose-500 shrink-0 ml-1" />
                ) : (
                  <Link2 className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0 ml-1" />
                )}
              </button>
            </div>
          );
        }
        return seg ? <MarkdownText key={idx} text={seg} /> : null;
      })}
    </div>
  );
}

export function ReinBotPage({
  workspaceRoot,
  providerId = "deepseek",
  modelId = "",
  apiKey = "",
  baseUrl = "",
  source = "faux",
  apiFormat,
  onOpenSttSettings,
  onRegisterPushToTalk,
  onDispatchTask,
}: ReinBotPageProps) {
  const { reinBotName } = useAppStore();
  const { t } = useTranslation();
  const [messages, setMessages] = useState<ReinBotMessage[]>(() =>
    getInitialReinBotMessages(reinBotName)
  );
  const [inputValue, setInputValue] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isWorkspaceCollapsed, setIsWorkspaceCollapsed] = useState(false);
  const [isWorkspaceExpanded, setIsWorkspaceExpanded] = useState(false);
  const [workspaceWidth, setWorkspaceWidth] = useState(380);

  // ReinBot 专属工作区根目录与产物路径：~/.ReinAgent/ReinBot
  const [reinBotWorkspaceRoot, setReinBotWorkspaceRoot] = useState<string>(() => {
    return getReinBotWorkspaceRoot() || workspaceRoot || "";
  });

  useEffect(() => {
    void ensureReinBotWorkspace().then((root) => {
      if (root) setReinBotWorkspaceRoot(root);
    });
  }, []);

  // 附件与任务关联
  const tasks = useAppStore((s) => s.tasks);
  const activeTaskId = useAppStore((s) => s.activeTaskId);

  // 图二：消息回复与复制
  const [replyingTo, setReplyingTo] = useState<ReinBotMessage | null>(null);

  // 图四：右侧边栏多标签页状态（工作台 + 任务详情 + 文件预览）
  type RightTabType = "workspace" | `task:${string}` | `file:${string}`;
  const [activeRightTab, setActiveRightTab] = useState<RightTabType>("workspace");
  const [openedTasks, setOpenedTasks] = useState<AppTask[]>([]);
  const [openedFiles, setOpenedFiles] = useState<Array<{ name: string; path: string }>>([]);

  // 监听后台任务状态更新（转圈/完成/失败实时响应）
  const [, setStreamingTick] = useState(0);
  useEffect(() => {
    return subscribeStreaming(() => setStreamingTick((t) => t + 1));
  }, []);

  // 复制与回复功能
  const handleCopyMessage = useCallback((text: string) => {
    if (!text) return;
    navigator.clipboard?.writeText(text).then(() => {
      toast.success(t("copied", "已复制"));
    }).catch((err) => {
      console.warn("Copy failed:", err);
    });
  }, [t]);

  const handleReplyMessage = useCallback((msg: ReinBotMessage) => {
    setReplyingTo(msg);
    inputRef.current?.focus();
  }, []);

  // 打开任务标签页（图四：支持在右侧边栏打开任务对话详情）
  const handleOpenTaskTab = useCallback((task: AppTask) => {
    setIsWorkspaceCollapsed(false);
    setOpenedTasks((prev) => {
      if (prev.some((t) => t.id === task.id)) return prev;
      return [...prev, task];
    });
    setActiveRightTab(`task:${task.id}`);
  }, []);

  // 关闭任务标签页
  const handleCloseTaskTab = useCallback((taskId: string) => {
    setOpenedTasks((prev) => prev.filter((t) => t.id !== taskId));
    setActiveRightTab((prev) => {
      if (prev === `task:${taskId}`) return "workspace";
      return prev;
    });
  }, []);

  // 打开产物文件预览标签页
  const handleOpenFileTab = useCallback((fileName: string, fullPath: string) => {
    setIsWorkspaceCollapsed(false);
    setOpenedFiles((prev) => {
      if (prev.some((f) => f.name === fileName)) return prev;
      return [...prev, { name: fileName, path: fullPath }];
    });
    setActiveRightTab(`file:${fileName}`);
  }, []);

  // 关闭产物文件预览标签页
  const handleCloseFileTab = useCallback((fileName: string) => {
    setOpenedFiles((prev) => prev.filter((f) => f.name !== fileName));
    setActiveRightTab((prev) => {
      if (prev === `file:${fileName}`) return "workspace";
      return prev;
    });
  }, []);

  // 打开产物所在文件夹
  const handleOpenFolder = useCallback(async (path?: string) => {
    const target = path || reinBotWorkspaceRoot;
    if (!target) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_in_file_manager", { path: target });
    } catch (err) {
      console.warn("[ReinBot] open_in_file_manager failed:", err);
    }
  }, [reinBotWorkspaceRoot]);

  // 点击聊天窗中 @任务[xxx] 胶囊：在右侧标签页打开详情
  const handleNavigateTask = useCallback(
    (taskId: string) => {
      const target = tasks.find((t) => t.id === taskId || t.title === taskId);
      if (target) {
        handleOpenTaskTab(target);
      } else {
        handleOpenTaskTab({
          id: taskId,
          title: taskId,
          createdAt: Date.now(),
          project: null,
        });
      }
    },
    [tasks, handleOpenTaskTab]
  );
  const [attachments, setAttachments] = useState<ReinBotAttachment[]>([]);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [showTaskPicker, setShowTaskPicker] = useState(false);
  const plusMenuRef = useRef<HTMLDivElement>(null);

  // 模型选择与服务商列表
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [selectedModelKey, setSelectedModelKey] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return kvGet(KV_REINBOT_MODEL_KEY) || "";
    }
    return "";
  });
  const [showModelPicker, setShowModelPicker] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);

  // 加载系统真实服务商配置
  useEffect(() => {
    let cancelled = false;
    const fetchProviders = async () => {
      try {
        const list = await loadProvidersConfigFromDisk();
        if (!cancelled) setProviders(list);
      } catch (err) {
        console.warn("[ReinBot] Failed to load providers config:", err);
      }
    };
    fetchProviders();
    return () => {
      cancelled = true;
    };
  }, []);

  // 监听点击外部或 ESC 关闭模型选择下拉菜单
  useEffect(() => {
    if (!showModelPicker) return;
    const onMouseDown = (e: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setShowModelPicker(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowModelPicker(false);
      }
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [showModelPicker]);

  // 综合解析当前生效模型与默认模型的完整元数据（包含容量与视觉徽标）
  const currentModelInfo = useMemo(() => {
    return resolveActiveModelInfo({
      selectedModelKey,
      defaultProviderId: providerId,
      defaultModelId: modelId,
      providers,
      defaultLabel: t("reinbotDefaultModel", "默认模型"),
    });
  }, [selectedModelKey, providerId, modelId, providers, t]);

  const defaultModelInfo = useMemo(() => {
    return resolveActiveModelInfo({
      selectedModelKey: "",
      defaultProviderId: providerId,
      defaultModelId: modelId,
      providers,
      defaultLabel: t("reinbotDefaultModel", "默认模型"),
    });
  }, [providerId, modelId, providers, t]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isDraggingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  // 监听点击外部或 ESC 关闭加号菜单
  useEffect(() => {
    if (!showPlusMenu) return;
    const onMouseDown = (e: MouseEvent) => {
      if (plusMenuRef.current && !plusMenuRef.current.contains(e.target as Node)) {
        setShowPlusMenu(false);
        setShowTaskPicker(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowPlusMenu(false);
        setShowTaskPicker(false);
      }
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [showPlusMenu]);

  const isImagePath = (p: string) =>
    ["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(p.split(".").pop()?.toLowerCase() ?? "");

  const handlePickFiles = async () => {
    setShowPlusMenu(false);
    setShowTaskPicker(false);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const paths = await invoke<string[]>("fs_pick_files", {
        workdir: reinBotWorkspaceRoot || undefined,
      });
      if (Array.isArray(paths) && paths.length > 0) {
        const newItems: ReinBotAttachment[] = [];
        for (const path of paths) {
          const image = isImagePath(path);
          let previewUrl: string | undefined;
          if (image) {
            try {
              const preview = await invoke<{ mime: string; base64: string }>("fs_read_image_preview", { path });
              previewUrl = `data:${preview.mime};base64,${preview.base64}`;
            } catch (err) {
              console.warn("[reinbot] image preview failed:", err);
            }
          }
          newItems.push({
            path,
            name: path.split(/[\/\\]/).pop() || path,
            kind: image ? "image" : "file",
            previewUrl,
          });
        }
        setAttachments((prev) => [...prev, ...newItems]);
      }
    } catch (err) {
      console.warn("[reinbot] pick files failed:", err);
    }
  };

  const removeAttachment = (path: string) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  };

  const MAX_ATTACHMENTS = 9;

  /** Ctrl+V 粘贴图片：base64 -> Rust 落盘 .ReinAgent/.temp/pasted/ -> 路径引用附件 */
  const handlePasteFiles = async (files: File[]) => {
    const { invoke } = await import("@tauri-apps/api/core");
    for (const file of files) {
      if (attachments.length >= MAX_ATTACHMENTS) break;
      try {
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = String(reader.result ?? "");
            resolve(result.slice(result.indexOf(",") + 1));
          };
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        const name = file.name || "clipboard.png";
        const path = await invoke<string>("fs_import_pasted_file", {
          name,
          mime: file.type || "image/png",
          base64Data: base64,
          workdir: reinBotWorkspaceRoot || "",
        });
        setAttachments((prev) =>
          prev.some((a) => a.path === path)
            ? prev
            : [
                ...prev,
                {
                  path,
                  name,
                  kind: (file.type.startsWith("image/") ? "image" : "file") as
                    | "image"
                    | "file",
                  previewUrl: file.type.startsWith("image/")
                    ? `data:${file.type || "image/png"};base64,${base64}`
                    : undefined,
                },
              ],
        );
      } catch (err) {
        console.warn("[ReinBot] paste import failed:", err);
      }
    }
  };

  /**
   * 原生读剪贴板图片兜底（Linux/WebKitGTK：paste 事件会派发但不交付 clipboardData 图片）。
   * `null` = 剪贴板里没有图片（静默）；抛错 = 工具缺失/读图失败，如实提示（No-Fallback）。
   */
  const isPastingImageRef = useRef(false);
  const handlePasteImageFallback = async () => {
    if (isPastingImageRef.current) return;
    isPastingImageRef.current = true;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const image = await invoke<{ mime: string; name: string; base64Data: string } | null>(
        "clipboard_read_image",
      );
      if (!image) return;
      const bytes = Uint8Array.from(atob(image.base64Data), (c) => c.charCodeAt(0));
      const file = new File([bytes], image.name || "clipboard.png", {
        type: image.mime || "image/png",
      });
      await handlePasteFiles([file]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(t("pasteImageReadFailed").replace("{message}", message));
    } finally {
      isPastingImageRef.current = false;
    }
  };

  /**
   * 粘贴路由（1:1 对齐任务对话框 LexicalComposer）：
   * - DOM 已交付图片文件 → 既有图片路径；
   * - 超长文本（≥15KB 字符）→ 落盘为 .txt 附件，不塞进输入框（>10MB 如实报错）；
   * - 无图且无文本 → WebKitGTK 位图形态，走原生读剪贴板兜底；
   * - 其余 → 普通文本粘贴，不做任何拦截。
   */
  const handleTextareaPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    const imageFiles = Array.from(e.clipboardData?.files ?? []).filter((f) =>
      f.type.startsWith("image/"),
    );
    const text = e.clipboardData?.getData("text/plain") ?? "";
    const route = classifyPaste({
      hasImageFile: imageFiles.length > 0,
      textLength: text.length,
      textBytes: utf8ByteLength(text),
    });
    switch (route.kind) {
      case "image-file":
        e.preventDefault();
        void handlePasteFiles(imageFiles);
        return;
      case "text-file":
        e.preventDefault();
        void handlePasteFiles([
          new File([text], createPastedTextFilename(new Date()), { type: "text/plain" }),
        ]);
        return;
      case "text-too-large":
        e.preventDefault();
        toast.error(
          t("pasteTextTooLarge").replace(
            "{size}",
            (utf8ByteLength(text) / (1024 * 1024)).toFixed(1),
          ),
        );
        return;
      case "native-image":
        void handlePasteImageFallback();
        return;
      case "plain":
        return;
    }
  };

  const handleSelectTask = (task: (typeof tasks)[number]) => {
    const taskTitle = task.title?.trim() || task.id;
    const taskTag = `@任务[${taskTitle}] `;
    setInputValue((prev) => (prev ? `${prev} ${taskTag}` : taskTag));
    setShowPlusMenu(false);
    setShowTaskPicker(false);
    inputRef.current?.focus();
  };

  // 持久化保存
  const persistMessages = (msgs: ReinBotMessage[]) => {
    if (typeof window !== "undefined") {
      try {
        kvSetJSON(KV_REINBOT_MESSAGES_KEY, msgs);
      } catch (err) {
        console.error("[ReinBot] Failed to persist messages:", err);
      }
    }
  };

  // 清空对话
  const handleClearMessages = () => {
    const welcome = [createDefaultWelcomeMessage(reinBotName)];
    setMessages(welcome);
    persistMessages(welcome);
    toast.success("已清空 ReinBot 对话记录", { duration: 2500 });
  };

  // 自动贴底滚动
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isStreaming]);

  // ---- 语音输入（STT）对接 ----
  const [sttSettingsState, setSttSettingsState] = useState<SttSettings | null>(null);
  const sttSettingsRef = useRef<SttSettings | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void loadSttSettings().then((loaded) => {
        if (cancelled) return;
        sttSettingsRef.current = loaded;
        setSttSettingsState(loaded);
      });
    };
    refresh();
    window.addEventListener("reinagent-stt-settings-changed", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("reinagent-stt-settings-changed", refresh);
    };
  }, []);

  const sttTransientBaseRef = useRef<string | null>(null);
  const inputValueRef = useRef(inputValue);
  inputValueRef.current = inputValue;

  const sttComposerRef = useRef<SttComposerHandle>({
    beginTransientText: () => {
      sttTransientBaseRef.current = inputValueRef.current;
      return true;
    },
    updateTransientText: (text: string) => {
      const base = sttTransientBaseRef.current ?? "";
      const separator = base && !base.endsWith(" ") && !base.endsWith("\n") ? " " : "";
      setInputValue(`${base}${separator}${text}`);
    },
    commitTransientText: (text: string) => {
      const base = sttTransientBaseRef.current ?? "";
      const separator = base && !base.endsWith(" ") && !base.endsWith("\n") ? " " : "";
      const merged = `${base}${separator}${text}`;
      sttTransientBaseRef.current = null;
      setInputValue(merged);
      inputRef.current?.focus();
    },
    cancelTransientText: (opts) => {
      const base = sttTransientBaseRef.current;
      sttTransientBaseRef.current = null;
      if (base !== null && !opts?.preserveLastText) setInputValue(base);
    },
  });

  const isSttConfigured = Boolean(
    sttSettingsState?.provider &&
      isProviderConfigured(sttSettingsState.provider, sttSettingsState.providers[sttSettingsState.provider])
  );

  const stt = useComposerStt({
    composerRef: sttComposerRef,
    disabled: isStreaming,
    provider: sttSettingsState?.provider ?? null,
    providerConfigured: isSttConfigured,
    getProviderSettings: () => {
      const current = sttSettingsRef.current;
      return current?.provider ? current.providers[current.provider] : null;
    },
    transport: desktopSttTransport,
    sessionKey: "__reinbot__",
    onError: (message) => toast.error(message),
    onConfigurationRequired: () => {
      toast.error("语音输入供应商未配置，请先在设置中完成配置");
      onOpenSttSettings?.();
    },
  });

  // 注册全局长按右 Ctrl 快捷键（Push-to-Talk）
  useEffect(() => {
    onRegisterPushToTalk?.({
      available: stt.available,
      pressStart: () => stt.pressStart(),
      pressEnd: () => stt.pressEnd(),
    });
    return () => {
      onRegisterPushToTalk?.(null);
    };
  }, [onRegisterPushToTalk, stt.available]);

  // 本页面就地支持长按右 Ctrl 快捷键监听
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isPushToTalkKey(e)) return;
      e.preventDefault();
      if (e.repeat) return;
      if (stt.available) {
        stt.pressStart();
      } else {
        toast.warning("语音识别未配置，请先在设置中启用", { duration: 3000 });
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!isPushToTalkKey(e)) return;
      if (stt.available) {
        stt.pressEnd();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [stt.available]);

  // 点击麦克风按钮切换录音
  const handleToggleVoice = () => {
    if (stt.active) {
      void stt.toggle();
      return;
    }
    if (!stt.available) {
      toast.error("语音输入未配置，请先在设置中完成配置");
      onOpenSttSettings?.();
      return;
    }
    void stt.toggle();
  };

  // ---- 真实大模型调用（runAgentTurn）----
  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    const currentAttachments = [...attachments];
    let finalText = text;
    if (replyingTo) {
      const quoteAuthor = replyingTo.sender === "user" ? "我" : reinBotName;
      const snippet = replyingTo.text.slice(0, 120).replace(/\n/g, " ");
      finalText = `> [回复 @${quoteAuthor}]: ${snippet}\n\n${text}`;
      setReplyingTo(null);
    }

    const userMsg: ReinBotMessage = {
      id: `user-${Date.now()}`,
      sender: "user",
      text: finalText,
      time: Date.now(),
      attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
    };

    const botMsgId = `bot-${Date.now() + 1}`;
    const botMsg: ReinBotMessage = {
      id: botMsgId,
      sender: "bot",
      text: "",
      time: Date.now() + 1,
    };

    const historyMessages = [...messages, userMsg];
    setMessages([...historyMessages, botMsg]);
    persistMessages([...historyMessages, botMsg]);
    setInputValue("");
    setAttachments([]);
    setIsStreaming(true);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // 自动识别并加载关联任务的历史对话与代码执行进展背景
    let linkedTasksContext = "";
    const linkedTasks = extractLinkedTasks(text, tasks);
    if (linkedTasks.length > 0) {
      try {
        linkedTasksContext = await buildLinkedTasksPromptContext(linkedTasks);
      } catch (err) {
        console.warn("[ReinBot] Failed to build linked tasks context:", err);
      }
    }

    // 系统专属设定
    const systemPrompt = [
      `你叫 ${reinBotName}，是 ReinAgent 桌面端内的专属本地主动型自主智能体（Chief of Staff / 研发总管）。`,
      "你的使命与职责：",
      "1. 协助用户规划、拆解工程任务，分析本地代码，审阅 PR，解答技术疑问与统筹交付产物；",
      `2. 你的默认专属独立工作区与工作产物路径均为：~/.ReinAgent/ReinBot/（真实路径：${reinBotWorkspaceRoot || "~/.ReinAgent/ReinBot"}）。生成的代码方案、分析报告、调研文档等产物统一存放于该目录下；`,
      "3. 遇到代码编写、Bug 排查或长程工程任务，先梳理出清晰的执行规划，给出专业见解；",
      "4. 你拥有创建新任务的专属工具 create_task。当用户在对话中要求新建、规划、创建或派发新任务时，请主动调用 create_task 工具创建任务，并在回复中使用 @任务[任务名] 格式汇报，以便用户一键点击胶囊直接跳转至该任务工作台；",
      "5. 遇到用户通过 @任务[任务名] 询问关联任务时，充分结合下方注入的该任务历史对话与执行进展背景，直接给出详尽、准确的总结与分析；",
      "6. 始终使用与用户相同的语言（默认中文），语气亲切可靠、专业干练，使用 Markdown 格式。",
      linkedTasksContext,
    ]
      .filter(Boolean)
      .join("\n");

    // 确定当前使用的服务商与模型（支持独立切换及回退默认模型）
    let activeProvId = providerId;
    let activeModId = modelId;
    let activeKey = apiKey;
    let activeUrl = baseUrl;
    let activeFmt = apiFormat;

    if (selectedModelKey) {
      const parsed = parseModelKey(selectedModelKey);
      if (parsed) {
        const p = providers.find((prov) => prov.id === parsed.providerId);
        if (p && p.enabled) {
          activeProvId = p.id;
          activeModId = parsed.modelId;
          activeKey = p.apiKey || apiKey;
          activeUrl = p.baseUrl || baseUrl;
          activeFmt = p.apiFormat;
        }
      }
    }

    // 提取当前模型的技术元数据（supportsImage, contextWindow, maxOutputTokens）
    const activeProvider = providers.find((prov) => prov.id === activeProvId);
    const activeModelItem = activeProvider?.models?.find((m) => m.id === activeModId);
    const supportsImage = Boolean(activeModelItem?.supportsImage);
    const contextWindow = activeModelItem?.contextWindow ?? null;
    const maxOutputTokens = activeModelItem?.maxOutputTokens ?? null;

    // 格式化为 pi-ai 规范消息（支持视觉多模态图片原生内联）
    const agentMessages: any[] = await Promise.all(
      historyMessages.map(async (m) => {
        if (m.sender === "user") {
          if (m.attachments && m.attachments.length > 0) {
            const parts: any[] = [];
            for (const att of m.attachments) {
              if (att.kind === "image") {
                let base64Data = att.previewUrl?.split(",")[1];
                let mime = att.previewUrl?.match(/data:([^;]+);/)?.[1] || "image/png";

                if (!base64Data && att.path) {
                  try {
                    const { invoke } = await import("@tauri-apps/api/core");
                    const res = await invoke<{ mime: string; base64: string }>(
                      "fs_read_attachment_base64",
                      { path: att.path }
                    );
                    if (res && res.base64) {
                      base64Data = res.base64;
                      mime = res.mime || mime;
                    }
                  } catch (err) {
                    console.warn("[ReinBot] fs_read_attachment_base64 failed:", err);
                  }
                }

                if (base64Data) {
                  parts.push({
                    type: "image",
                    data: base64Data,
                    mimeType: mime,
                  });
                } else {
                  parts.push({
                    type: "text",
                    text: `[关联图片: ${att.name} (${att.path})]`,
                  });
                }
              } else {
                parts.push({
                  type: "text",
                  text: `[关联附件: ${att.name} (${att.path})]`,
                });
              }
            }
            if (m.text) {
              parts.push({ type: "text", text: m.text });
            }
            return {
              role: "user",
              content: parts,
              timestamp: m.time,
            };
          }
          return {
            role: "user",
            content: m.text,
            timestamp: m.time,
          };
        }
        return {
          role: "assistant",
          content: [{ type: "text", text: m.text }],
          api: "openai",
          provider: activeProvId,
          model: activeModId,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          stopReason: "stop",
          timestamp: m.time,
        };
      })
    );

    try {
      await runAgentTurn({
        source: source === "faux" ? "faux" : (activeProvId as any),
        config: {
          provider: activeProvId as any,
          apiKey: activeKey,
          modelId: activeModId,
          baseUrl: activeUrl,
          apiFormat: activeFmt,
          supportsImage,
          contextWindow,
          maxOutputTokens,
        },
        messages: agentMessages,
        systemPrompt,
        workspaceRoot: reinBotWorkspaceRoot,
        extraTools: [
          createReinBotTaskTool({
            defaultProject: reinBotWorkspaceRoot,
            providerId: activeProvId,
            modelId: activeModId,
            onTaskCreated: (newTask) => {
              toast.success(`已创建新任务: ${newTask.title}`);
            },
            onDispatchTask,
          }),
        ],
        signal: abortController.signal,
        onEvent: (ev: any) => {
          if (ev.type === "message_update" && ev.message) {
            const rawContent = ev.message.content;
            if (Array.isArray(rawContent)) {
              const fullText = rawContent
                .filter((c: any) => c.type === "text" && typeof c.text === "string")
                .map((c: any) => c.text)
                .join("");
              if (fullText) {
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === botMsgId ? { ...msg, text: fullText } : msg
                  )
                );
              }
            } else if (typeof rawContent === "string") {
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === botMsgId ? { ...msg, text: rawContent } : msg
                )
              );
            }
          }
        },
      });
    } catch (err: unknown) {
      if ((err as Error)?.name === "AbortError" || abortController.signal.aborted) {
        // 用户手动中止
      } else {
        const errorText = (err as Error)?.message || String(err);
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === botMsgId
              ? {
                  ...msg,
                  text: msg.text
                    ? `${msg.text}\n\n*(调用中断: ${errorText})*`
                    : `请求失败: ${errorText}。请检查服务商 API Key 与网络连接。`,
                }
              : msg
          )
        );
      }
    } finally {
      setIsStreaming(false);
      abortControllerRef.current = null;
      setMessages((latest) => {
        persistMessages(latest);
        return latest;
      });
    }
  }, [inputValue, attachments, isStreaming, messages, reinBotName, source, providerId, apiKey, modelId, baseUrl, apiFormat, reinBotWorkspaceRoot, tasks, selectedModelKey, providers, onDispatchTask, replyingTo]);

  // 停止生成
  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setIsStreaming(false);
    }
  };

  // 左右拖拽调节宽度
  const handleMouseDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    const startX = e.clientX;
    const startW = workspaceWidth;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const delta = startX - moveEvent.clientX;
      const newW = Math.max(280, Math.min(600, startW + delta));
      setWorkspaceWidth(newW);
    };

    const onMouseUp = () => {
      isDraggingRef.current = false;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const isVoiceActive = stt.active;

  return (
    <div className="flex-1 flex w-full h-full overflow-hidden bg-[var(--bg)]">
      {/* 左侧：管家式主对话流（工作台放大到侧边栏时隐藏） */}
      {!isWorkspaceExpanded && (
        <div className="flex-1 flex flex-col h-full overflow-hidden relative">
          {/* 顶部 Capsule 胶囊状态栏 */}
          <div className="flex items-center justify-between h-14 px-6 border-b border-[var(--border)] bg-[var(--bg)]/80 backdrop-blur-sm z-10">
            <div className="w-10 flex justify-start">
              <button
                type="button"
                onClick={handleClearMessages}
                title="清空对话记录"
                className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-red-500 hover:bg-[var(--surface)] transition-colors cursor-pointer"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>

            {/* 居中区域：状态胶囊 + 模型选择下拉框 */}
            <div className="flex items-center gap-2.5">
              {/* 居中胶囊卡片 */}
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--surface)] border border-[var(--border)] shadow-xs transition-transform hover:scale-102">
                <div className="flex items-center justify-center w-5 h-5 rounded-md bg-[var(--bg-sunken)] border border-[var(--border)] text-[var(--brand)]">
                  <Cpu className="w-3.5 h-3.5" />
                </div>
                <div className="flex flex-col text-left">
                  <div className="flex items-center gap-1.5 leading-none">
                    <span className="text-xs font-bold text-[var(--text)]">{reinBotName}</span>
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--success-text)]" />
                  </div>
                  <span className="text-[10px] text-[var(--text-muted)] leading-none mt-0.5">
                    {t("reinbotSubtitle")}
                  </span>
                </div>
              </div>

              {/* 模型选择下拉框 */}
              <div className="relative w-72" ref={modelPickerRef}>
                <button
                  type="button"
                  onClick={() => setShowModelPicker((prev) => !prev)}
                  className="w-full flex items-center justify-between gap-2 px-3 py-1.5 rounded-full bg-[var(--surface)] hover:bg-[var(--surface-hover)] border border-[var(--border)] text-xs text-[var(--text)] shadow-xs transition-all cursor-pointer select-none"
                  title={t("reinbotSwitchModel", "切换模型")}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand)] shrink-0" />
                    <span className="truncate font-medium">
                      {currentModelInfo.displayName}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 ml-1">
                    {currentModelInfo.ctxLabel && (
                      <span className="px-1 py-0.2 text-[10px] font-mono rounded bg-[var(--surface-active)] text-[var(--text-dim)] border border-[var(--border)]">
                        {currentModelInfo.ctxLabel}
                      </span>
                    )}
                    {currentModelInfo.supportsImage && (
                      <span className="px-1 py-0.2 text-[9px] font-medium rounded bg-blue-500/10 text-blue-500 border border-blue-500/20">
                        视觉
                      </span>
                    )}
                    <ChevronDown
                      className={`w-3 h-3 text-[var(--text-muted)] shrink-0 transition-transform duration-200 ml-0.5 ${
                        showModelPicker ? "rotate-180" : ""
                      }`}
                    />
                  </div>
                </button>

                {/* 模型下拉菜单浮层（1:1 对齐任务对话 LexicalComposer 风格） */}
                {showModelPicker && (
                  <div className="absolute top-full left-0 mt-1.5 w-full max-h-80 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl p-1.5 text-xs z-50 flex flex-col gap-1 backdrop-blur-md">
                    {/* 默认模型选项 */}
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedModelKey("");
                        kvSet(KV_REINBOT_MODEL_KEY, "");
                        setShowModelPicker(false);
                        toast.success(t("reinbotModelRestoredDefault", "已恢复为默认模型"));
                      }}
                      className={`w-full text-left px-2.5 py-1.5 rounded-lg transition-colors flex items-center justify-between cursor-pointer ${
                        !selectedModelKey
                          ? "bg-[var(--accent)] text-[var(--accent-contrast)] font-medium shadow-sm"
                          : "hover:bg-[var(--surface-hover)] text-[var(--text-primary)]"
                      }`}
                    >
                      <div className="flex items-center gap-1.5 truncate">
                        <span
                          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                            !selectedModelKey ? "bg-current" : "bg-transparent"
                          }`}
                        />
                        <span className="truncate">
                          {t("reinbotDefaultModel", "默认模型")}
                          {defaultModelInfo.modelId ? ` (${defaultModelInfo.modelId})` : ""}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0 ml-2">
                        {defaultModelInfo.ctxLabel && (
                          <span
                            className={`px-1 py-0.2 text-[10px] font-mono rounded ${
                              !selectedModelKey
                                ? "bg-black/20 text-white/90"
                                : "bg-[var(--surface-active)] text-[var(--text-dim)] border border-[var(--border)]"
                            }`}
                          >
                            {defaultModelInfo.ctxLabel}
                          </span>
                        )}
                        {defaultModelInfo.supportsImage && (
                          <span
                            className={`px-1 py-0.2 text-[9px] font-medium rounded ${
                              !selectedModelKey
                                ? "bg-black/20 text-white/90"
                                : "bg-blue-500/10 text-blue-500 border border-blue-500/20"
                            }`}
                          >
                            视觉
                          </span>
                        )}
                      </div>
                    </button>

                    {/* 已启用服务商及对应模型列表 */}
                    {providers
                      .filter((p) => p.enabled)
                      .map((p) => {
                        const enabledModels = (p.models || []).filter((m) => m.enabled !== false);
                        if (enabledModels.length === 0) return null;

                        return (
                          <div key={p.id} className="space-y-0.5">
                            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]/70">
                              {p.name || p.id}
                            </div>
                            {enabledModels.map((m) => {
                              const key = formatModelKey(p.id, m.id);
                              const isSelected = selectedModelKey === key;
                              const ctxLabel = formatModelContextWindowLabel(m.contextWindow);

                              return (
                                <button
                                  key={m.id}
                                  type="button"
                                  onClick={() => {
                                    setSelectedModelKey(key);
                                    kvSet(KV_REINBOT_MODEL_KEY, key);
                                    setShowModelPicker(false);
                                    const modelName = m.name || m.id;
                                    toast.success(
                                      t("reinbotModelSwitched", `已切换为模型: ${modelName}`).replace(
                                        "{model}",
                                        modelName
                                      )
                                    );
                                  }}
                                  className={`w-full text-left px-2.5 py-1.5 rounded-lg transition-colors flex items-center justify-between cursor-pointer ${
                                    isSelected
                                      ? "bg-[var(--accent)] text-[var(--accent-contrast)] font-medium shadow-sm"
                                      : "hover:bg-[var(--surface-hover)] text-[var(--text-primary)]"
                                  }`}
                                >
                                  <div className="flex items-center gap-1.5 truncate">
                                    <span
                                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                        isSelected ? "bg-current" : "bg-transparent"
                                      }`}
                                    />
                                    <span className="truncate">{m.name || m.id}</span>
                                  </div>
                                  <div className="flex items-center gap-1 shrink-0 ml-2">
                                    {ctxLabel && (
                                      <span
                                        className={`px-1 py-0.2 text-[10px] font-mono rounded ${
                                          isSelected
                                            ? "bg-black/20 text-white/90"
                                            : "bg-[var(--surface-active)] text-[var(--text-dim)] border border-[var(--border)]"
                                        }`}
                                      >
                                        {ctxLabel}
                                      </span>
                                    )}
                                    {m.supportsImage && (
                                      <span
                                        className={`px-1 py-0.2 text-[9px] font-medium rounded ${
                                          isSelected
                                            ? "bg-black/20 text-white/90"
                                            : "bg-blue-500/10 text-blue-500 border border-blue-500/20"
                                        }`}
                                      >
                                        视觉
                                      </span>
                                    )}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>
            </div>

            {/* 右侧展开面板按钮（收起时可见） */}
            <div className="w-10 flex justify-end">
              {isWorkspaceCollapsed && (
                <button
                  type="button"
                  onClick={() => setIsWorkspaceCollapsed(false)}
                  title="展开工作台"
                  className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface)] transition-colors cursor-pointer"
                >
                  <PanelRightOpen className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {/* 对话消息区 */}
          <div className="flex-1 overflow-y-auto px-4 md:px-12 py-6 space-y-5">
            {messages.map((msg) => (
              msg.sender === "user" ? (
                /* 用户消息：图二添加时间，复制/回复按钮，min-w-0 防溢出 */
                <div
                  key={msg.id}
                  className="group flex flex-col items-end w-full space-y-1"
                >
                  <div className="flex items-center gap-2 justify-end max-w-[85%] md:max-w-[70%]">
                    {/* 悬浮操作按钮：复制与回复（图二） */}
                    <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 shrink-0 text-[var(--text-muted)]">
                      <button
                        type="button"
                        onClick={() => handleCopyMessage(msg.text)}
                        className="p-1 rounded hover:bg-[var(--surface)] hover:text-[var(--text)] transition-colors cursor-pointer"
                        title="复制消息"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleReplyMessage(msg)}
                        className="p-1 rounded hover:bg-[var(--surface)] hover:text-[var(--text)] transition-colors cursor-pointer"
                        title="回复此消息"
                      >
                        <Reply className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {/* 用户气泡（带防溢出约束） */}
                    <div className="min-w-0 break-words [overflow-wrap:anywhere] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-xs bg-[var(--brand)] text-[var(--brand-fg)] rounded-tr-xs">
                      {/* 历史消息附件 Chips */}
                      {msg.attachments && msg.attachments.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mb-2 justify-end">
                          {msg.attachments.map((att) => (
                            <div
                              key={att.path}
                              className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-white/20 text-[11px] text-white backdrop-blur-xs"
                            >
                              {att.kind === "image" && att.previewUrl ? (
                                <img
                                  src={att.previewUrl}
                                  alt={att.name}
                                  className="w-3.5 h-3.5 rounded-xs object-cover"
                                />
                              ) : (
                                <FileText className="w-3 h-3 text-white/80" />
                              )}
                              <span className="max-w-[140px] truncate" title={att.path}>
                                {att.name}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="whitespace-pre-wrap">
                        {renderMessageWithTaskPills(msg.text, tasks, handleNavigateTask, true)}
                      </div>
                    </div>
                  </div>

                  {/* 用户发送时间（图二：仅我发的消息显示时间） */}
                  <div className="text-[11px] font-mono text-[var(--text-muted)] pr-1 select-none">
                    {formatMessageTime(msg.time)}
                  </div>
                </div>
              ) : (
                /* 机器人消息：图一防溢出，图二复制/回复按钮（不显示时间），图三任务转圈与完成/失败图标 */
                <div
                  key={msg.id}
                  className="group flex flex-col items-start w-full space-y-1"
                >
                  <div className="flex items-start gap-3 max-w-[85%] md:max-w-[70%]">
                    <div className="flex-shrink-0 flex items-center justify-center w-8 h-8 rounded-xl bg-[var(--surface)] border border-[var(--border)] text-[var(--brand)] shadow-xs mt-0.5">
                      <Bot className="w-4 h-4" />
                    </div>

                    <div className="flex-1 min-w-0">
                      {/* 机器人消息气泡（带防溢出约束与任务胶囊图表卡片） */}
                      <div className="min-w-0 break-words [overflow-wrap:anywhere] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-xs bg-[var(--surface)] text-[var(--text)] border border-[var(--border)] rounded-tl-xs">
                        {msg.text ? (
                          renderBotMessageContent(msg.text, tasks, handleNavigateTask)
                        ) : (
                          <div className="flex items-center gap-2 text-[var(--text-muted)] py-1">
                            <Loader2 className="w-4 h-4 animate-spin text-[var(--brand)]" />
                            <span>正在思考中...</span>
                          </div>
                        )}
                      </div>

                      {/* 机器人消息下方复制与回复按钮（悬浮显现，图二） */}
                      {msg.text && (
                        <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1.5 mt-1 ml-1 text-[var(--text-muted)]">
                          <button
                            type="button"
                            onClick={() => handleCopyMessage(msg.text)}
                            className="p-1 rounded hover:bg-[var(--surface)] hover:text-[var(--text)] transition-colors cursor-pointer"
                            title="复制消息"
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleReplyMessage(msg)}
                            className="p-1 rounded hover:bg-[var(--surface)] hover:text-[var(--text)] transition-colors cursor-pointer"
                            title="回复此消息"
                          >
                            <Reply className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* 底部输入胶囊 */}
          <div className="p-4 md:px-12 md:pb-6">
            {/* 引用回复提示条（图二） */}
            {replyingTo && (
              <div className="flex items-center justify-between px-3 py-1.5 mb-2 rounded-xl bg-[var(--surface-hover)] border border-[var(--border)] text-xs text-[var(--text-muted)] animate-in fade-in">
                <div className="flex items-center gap-1.5 truncate">
                  <Reply className="w-3.5 h-3.5 text-[var(--brand)] shrink-0" />
                  <span className="font-semibold text-[var(--text)] shrink-0">
                    回复 @{replyingTo.sender === "user" ? "我" : reinBotName}:
                  </span>
                  <span className="truncate">{replyingTo.text}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setReplyingTo(null)}
                  className="p-1 rounded-full hover:bg-[var(--bg-sunken)] hover:text-[var(--text)] transition-colors cursor-pointer shrink-0 ml-2"
                  title="取消回复"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}

            {/* 待发送附件 Chips 预览栏 */}
            {attachments.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 mb-2 px-1">
                {attachments.map((att) => (
                  <div
                    key={att.path}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs text-[var(--text)] shadow-xs animate-in fade-in duration-100"
                  >
                    {att.kind === "image" && att.previewUrl ? (
                      <img
                        src={att.previewUrl}
                        alt={att.name}
                        className="w-4 h-4 rounded-xs object-cover"
                      />
                    ) : (
                      <FileText className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                    )}
                    <span className="max-w-[150px] truncate font-medium" title={att.path}>
                      {att.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(att.path)}
                      className="p-0.5 rounded-full hover:bg-[var(--bg-sunken)] text-[var(--text-muted)] hover:text-[var(--text)] cursor-pointer"
                      title="移除附件"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div
              className="relative flex items-center w-full rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 shadow-md focus-within:border-[var(--brand)] focus-within:ring-2 focus-within:ring-[var(--brand)]/20 transition-all"
            >
              {/* 左侧加号与快捷菜单（方案 A） */}
              <div className="relative" ref={plusMenuRef}>
                <button
                  type="button"
                  onClick={() => {
                    setShowPlusMenu((prev) => !prev);
                    setShowTaskPicker(false);
                  }}
                  className={`p-1.5 rounded-full transition-colors cursor-pointer ${
                    showPlusMenu
                      ? "text-[var(--brand)] bg-[var(--brand)]/10"
                      : "text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-sunken)]"
                  }`}
                  title="添加附件或关联任务"
                >
                  <Plus className={`w-4 h-4 transition-transform duration-200 ${showPlusMenu ? "rotate-45" : ""}`} />
                </button>

                {/* 方案 A 弹出快捷菜单 */}
                {showPlusMenu && (
                  <div className="absolute bottom-full left-0 mb-3 w-72 rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl p-2 z-50 animate-in fade-in zoom-in-95 duration-150 backdrop-blur-md">
                    {!showTaskPicker ? (
                      <div className="space-y-1">
                        <div className="px-2.5 py-1 text-[11px] font-semibold text-[var(--text-muted)]">
                          添加与关联
                        </div>

                        {/* 动作 1：上传附件 / 图片 */}
                        <button
                          type="button"
                          onClick={() => void handlePickFiles()}
                          className="flex items-center gap-3 w-full p-2 rounded-xl text-left hover:bg-[var(--bg-sunken)] transition-colors cursor-pointer group"
                        >
                          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-[var(--brand)]/10 text-[var(--brand)] group-hover:scale-105 transition-transform">
                            <Paperclip className="w-4 h-4" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-medium text-[var(--text)]">
                              {t("reinbotAttachFile", "上传附件 / 图片")}
                            </div>
                            <div className="text-[10px] text-[var(--text-muted)] truncate">
                              {t("reinbotAttachFileDesc", "从本地选择代码、文档或图片")}
                            </div>
                          </div>
                        </button>

                        {/* 动作 2：关联已有任务 */}
                        <button
                          type="button"
                          onClick={() => setShowTaskPicker(true)}
                          className="flex items-center gap-3 w-full p-2 rounded-xl text-left hover:bg-[var(--bg-sunken)] transition-colors cursor-pointer group"
                        >
                          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-500 group-hover:scale-105 transition-transform">
                            <Link2 className="w-4 h-4" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-medium text-[var(--text)]">
                              {t("reinbotLinkTask", "关联已有任务")}
                            </div>
                            <div className="text-[10px] text-[var(--text-muted)] truncate">
                              {t("reinbotLinkTaskDesc", "引用任务上下文供分析")}
                            </div>
                          </div>
                        </button>
                      </div>
                    ) : (
                      /* 任务选择子视图 */
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between px-1 pb-1 border-b border-[var(--border)]">
                          <button
                            type="button"
                            onClick={() => setShowTaskPicker(false)}
                            className="flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text)] cursor-pointer"
                          >
                            <ArrowLeft className="w-3 h-3" />
                            <span>返回</span>
                          </button>
                          <span className="text-[11px] font-medium text-[var(--text)]">
                            {t("reinbotSelectTask", "选择关联任务")}
                          </span>
                          <span className="w-8" />
                        </div>

                        <div className="max-h-56 overflow-y-auto space-y-1 pt-1 pr-1">
                          {tasks.length === 0 ? (
                            <div className="py-6 text-center text-xs text-[var(--text-muted)]">
                              {t("reinbotNoAvailableTasks", "暂无可用任务")}
                            </div>
                          ) : (
                            tasks.slice(0, 10).map((task) => (
                              <button
                                key={task.id}
                                type="button"
                                onClick={() => handleSelectTask(task)}
                                className="flex items-center gap-2 w-full p-2 rounded-lg text-left hover:bg-[var(--bg-sunken)] transition-colors cursor-pointer"
                              >
                                <span
                                  className={`w-2 h-2 rounded-full shrink-0 ${
                                    task.id === activeTaskId
                                      ? "bg-emerald-500 animate-pulse"
                                      : "bg-[var(--brand)]"
                                  }`}
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="text-xs font-medium text-[var(--text)] truncate">
                                    {task.title || "未命名任务"}
                                  </div>
                                  <div className="text-[10px] text-[var(--text-muted)] truncate">
                                    {task.id}
                                  </div>
                                </div>
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* 输入框 */}
              <input
                ref={inputRef}
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onPaste={handleTextareaPaste}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder={isVoiceActive ? "正在倾听中，请说话..." : t("reinbotInputPlaceholder")}
                className="flex-1 bg-transparent border-none outline-none px-3 py-1.5 text-sm text-[var(--text)] placeholder-[var(--text-muted)]"
              />

              {/* 右侧语音与发送 / 停止 */}
              <div className="flex items-center gap-1">
                {/* 麦克风按钮（长按右 Ctrl 或点击切换） */}
                <button
                  type="button"
                  onClick={handleToggleVoice}
                  className={`p-1.5 rounded-full transition-all cursor-pointer ${
                    isVoiceActive
                      ? "text-red-500 bg-red-500/15 ring-2 ring-red-500/30 animate-pulse"
                      : "text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-sunken)]"
                  }`}
                  title={
                    stt.available
                      ? "语音输入 (点击或长按右 Ctrl)"
                      : "语音输入 (未配置，点击前往设置)"
                  }
                >
                  {stt.state === "buffering" || stt.state === "stopping" ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Mic className="w-4 h-4" />
                  )}
                </button>

                {isStreaming ? (
                  <button
                    type="button"
                    onClick={handleStop}
                    className="flex items-center justify-center w-8 h-8 rounded-full bg-[var(--danger)] text-white shadow-xs hover:opacity-90 cursor-pointer transition-all"
                    title="停止生成"
                  >
                    <Square className="w-3.5 h-3.5 fill-current" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleSend()}
                    disabled={!inputValue.trim() && attachments.length === 0}
                    className={`flex items-center justify-center w-8 h-8 rounded-full transition-all ${
                      inputValue.trim() || attachments.length > 0
                        ? "bg-[var(--brand)] text-[var(--brand-fg)] shadow-xs hover:opacity-90 cursor-pointer"
                        : "bg-[var(--bg-sunken)] text-[var(--text-muted)] opacity-50 cursor-not-allowed"
                    }`}
                    title="发送"
                  >
                    <ArrowUp className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 左右拖拽手柄（仅在分屏且未折叠时显示） */}
      {!isWorkspaceCollapsed && !isWorkspaceExpanded && (
        <div
          onMouseDown={handleMouseDown}
          className="w-1 hover:w-1.5 bg-[var(--border)] hover:bg-[var(--brand)]/50 cursor-col-resize transition-all z-10"
        />
      )}

      {/* 右侧：多标签页容器（命令行 + 工作台 + 任务详情） */}
      {!isWorkspaceCollapsed && (
        <div
          style={isWorkspaceExpanded ? undefined : { width: `${workspaceWidth}px` }}
          className={`${
            isWorkspaceExpanded ? "flex-1 w-full" : "flex-shrink-0"
          } h-full overflow-hidden flex flex-col bg-[var(--surface)] border-l border-[var(--border)] transition-all duration-200`}
        >
          {/* 顶部多标签页栏（图四：移除命令行，首项固定工作台，支持任务与产物文件动态标签） */}
          <div className="flex items-center justify-between h-10 px-2 bg-[var(--bg-sunken)] border-b border-[var(--border)] select-none shrink-0">
            <div className="flex items-center gap-1 overflow-x-auto no-scrollbar py-1 min-w-0">
              {/* 第 1 个固定标签：工作台 */}
              <button
                type="button"
                onClick={() => setActiveRightTab("workspace")}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer shrink-0 ${
                  activeRightTab === "workspace"
                    ? "bg-[var(--surface)] text-[var(--text)] shadow-xs border border-[var(--border)] font-semibold"
                    : "text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)] border border-transparent"
                }`}
                title="ReinBot 工作台与产物"
              >
                <LayoutDashboard className="w-3.5 h-3.5 text-[var(--brand)]" />
                <span>工作台</span>
              </button>

              {/* 动态标签：任务详情（可点 ✕ 关闭） */}
              {openedTasks.map((t) => {
                const isTabActive = activeRightTab === `task:${t.id}`;
                return (
                  <div
                    key={t.id}
                    onClick={() => setActiveRightTab(`task:${t.id}`)}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer shrink-0 group ${
                      isTabActive
                        ? "bg-[var(--surface)] text-[var(--text)] shadow-xs border border-[var(--border)] font-semibold"
                        : "text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)] border border-transparent"
                    }`}
                    title={t.title || "任务详情"}
                  >
                    <Bot className="w-3.5 h-3.5 text-[var(--brand)] shrink-0" />
                    <span className="max-w-[100px] truncate">{t.title || "任务"}</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCloseTaskTab(t.id);
                      }}
                      className="p-0.5 rounded hover:bg-[var(--bg-sunken)] hover:text-rose-500 transition-colors ml-0.5 text-[var(--text-muted)]"
                      title="关闭标签"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}

              {/* 动态标签：产物文件预览（可点 ✕ 关闭） */}
              {openedFiles.map((f) => {
                const isTabActive = activeRightTab === `file:${f.name}`;
                return (
                  <div
                    key={f.name}
                    onClick={() => setActiveRightTab(`file:${f.name}`)}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer shrink-0 group ${
                      isTabActive
                        ? "bg-[var(--surface)] text-[var(--text)] shadow-xs border border-[var(--border)] font-semibold"
                        : "text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)] border border-transparent"
                    }`}
                    title={f.name}
                  >
                    <FileText className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                    <span className="max-w-[110px] truncate">{f.name}</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCloseFileTab(f.name);
                      }}
                      className="p-0.5 rounded hover:bg-[var(--bg-sunken)] hover:text-rose-500 transition-colors ml-0.5 text-[var(--text-muted)]"
                      title="关闭预览"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>

            {/* 右侧窗口控制（放大/全屏与收起） */}
            <div className="flex items-center gap-1 text-[var(--text-muted)] shrink-0 ml-1">
              <button
                type="button"
                onClick={() => setIsWorkspaceExpanded((prev) => !prev)}
                title={isWorkspaceExpanded ? "还原分屏" : "全屏放大"}
                className="p-1.5 rounded hover:text-[var(--text)] hover:bg-[var(--surface)] transition-colors cursor-pointer"
              >
                {isWorkspaceExpanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
              </button>
              {!isWorkspaceExpanded && (
                <button
                  type="button"
                  onClick={() => setIsWorkspaceCollapsed(true)}
                  title="收起右侧面板"
                  className="p-1.5 rounded hover:text-[var(--text)] hover:bg-[var(--surface)] transition-colors cursor-pointer"
                >
                  <PanelRightClose className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* 标签页视图内容区 */}
          <div className="flex-1 overflow-hidden relative">
            {activeRightTab === "workspace" ? (
              <ReinBotWorkspace
                workspaceRoot={reinBotWorkspaceRoot}
                hideHeader={true}
                onOpenTask={handleOpenTaskTab}
                onOpenFile={handleOpenFileTab}
                onCloseTaskTab={handleCloseTaskTab}
                onCloseFileTab={handleCloseFileTab}
              />
            ) : activeRightTab.startsWith("task:") ? (
              (() => {
                const currentTaskId = activeRightTab.replace(/^task:/, "");
                return (
                  <ReinBotTaskDetail
                    taskId={currentTaskId}
                    reinBotName={reinBotName}
                    onClose={() => handleCloseTaskTab(currentTaskId)}
                  />
                );
              })()
            ) : activeRightTab.startsWith("file:") ? (
              (() => {
                const currentFileName = activeRightTab.replace(/^file:/, "");
                const file = openedFiles.find((f) => f.name === currentFileName);
                const filePath = file?.path || `${reinBotWorkspaceRoot}/${currentFileName}`;
                return (
                  <ReinBotFileViewer
                    filePath={filePath}
                    fileName={currentFileName}
                    onClose={() => handleCloseFileTab(currentFileName)}
                    onOpenFolder={() => void handleOpenFolder(reinBotWorkspaceRoot)}
                  />
                );
              })()
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
