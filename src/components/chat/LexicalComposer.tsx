import React, { useRef, useState, useEffect, useMemo } from "react";
import { useTranslation } from "../../i18n";
import {
  BUILTIN_COMMANDS,
  expandCommandTemplate,
  filterCommands,
  parseSlashQuery,
  toCustomCommands,
  type SlashCommand,
} from "../../lib/commands/slashCommands";
import { parseMentionQuery } from "../../lib/chat/mentions";
import { ContextUsageIndicator } from "./ContextUsageIndicator";
import type { ContextUsageData } from "../../lib/chat/contextUsage";
import { useAppStore } from "../../store/useAppStore";
import {
  ArrowUp,
  Square,
  Plus,
  AtSign,
  FileText,
  FileCode,
  Image as ImageIcon,
  X,
  ChevronDown,
  Brain,
  Hand,
  Folder,
  FolderPlus,
  Cloud,
  MessageSquare,
  Check,
  Search,
  Lightbulb,
  ShieldCheck,
  ShieldAlert,
} from "lucide-react";
import { MOCK_PROJECTS } from "../sidebar/WorkspaceSidebar";
import {
  buildOutgoingPayload,
  type ComposerImageInput,
  type UserAttachmentRef,
} from "../../lib/chat/attachments";
import {
  type ModelItem,
  type ProviderItem,
  formatModelContextWindowLabel,
  updateModelEffortDefaultLevel,
} from "../settings/model-provider/types";

export type { ComposerImageInput, UserAttachmentRef };

export interface LexicalComposerProps {
  isStreaming: boolean;
  onSend: (
    text: string,
    images?: ComposerImageInput[],
    userAttachments?: { path: string; name: string; kind: "image" | "file"; previewUrl?: string }[],
  ) => boolean;
  /** 会话工作区根（粘贴图片落盘 / 附件对话框初始目录） */
  workspaceRoot?: string;
  onStop: () => void;
  providerId?: string;
  providerName?: string;
  modelId?: string;
  currentModel?: ModelItem | null;
  providers?: ProviderItem[];
  onSelectModel?: (providerId: string, modelId: string) => void;
  hasMessages?: boolean;
  focusRequestTrigger?: number;
  /**
   * 外部预填请求（EmptyState 快捷动作卡）：nonce 变化时把 `text` 填进输入框并聚焦，
   * **不自动发送**——用户可编辑后手动发送。nonce=0 / undefined 表示无请求。
   */
  prefillRequest?: { text: string; nonce: number } | null;
  /** 上下文容量指示器数据（真实 usage + 模型 contextWindow；无数据不显示） */
  contextUsage?: ContextUsageData | null;
  /** `/clear`：清空当前任务时间线（App 层执行，含二次确认） */
  onClearConversation?: () => void;
  /** `/compact`：手动压缩上下文（App 层执行；未接线时如实提示） */
  onCompactRequest?: () => void;
}

interface ThinkingOption {
  level: "default" | "low" | "medium" | "high" | "xhigh" | "max";
  label: string;
  steps: number;
}

const THINKING_OPTIONS: ThinkingOption[] = [
  { level: "default", label: "Default", steps: 100 },
  { level: "low", label: "Low", steps: 200 },
  { level: "medium", label: "Medium", steps: 300 },
  { level: "high", label: "High", steps: 400 },
  { level: "xhigh", label: "XHigh", steps: 500 },
  { level: "max", label: "Max", steps: 600 },
];

/** 审批模式四档（对齐 ZCode mode.label.glm.*：plan=计划模式 ask=变更前确认 edit=自动编辑 full=完全访问）。 */
type ComposerApprovalMode = "plan" | "ask" | "edit" | "full";

const APPROVAL_MODE_OPTIONS: {
  mode: ComposerApprovalMode;
  labelKey: "modePlan" | "modeAsk" | "modeEdit" | "modeFull";
  descKey: "modePlanDesc" | "modeAskDesc" | "modeEditDesc" | "modeFullDesc";
  Icon: typeof Hand;
}[] = [
  { mode: "plan", labelKey: "modePlan", descKey: "modePlanDesc", Icon: Lightbulb },
  { mode: "ask", labelKey: "modeAsk", descKey: "modeAskDesc", Icon: Hand },
  { mode: "edit", labelKey: "modeEdit", descKey: "modeEditDesc", Icon: ShieldCheck },
  { mode: "full", labelKey: "modeFull", descKey: "modeFullDesc", Icon: ShieldAlert },
];

export const LexicalComposer: React.FC<LexicalComposerProps> = ({
  isStreaming,
  contextUsage,
  workspaceRoot,
  onClearConversation,
  onCompactRequest,
  onSend,
  onStop,
  providerId = "deepseek",
  providerName = "DeepSeek",
  modelId = "v3",
  currentModel,
  providers = [],
  onSelectModel,
  hasMessages = false,
  focusRequestTrigger,
  prefillRequest,
}) => {
  const { t } = useTranslation();
  const {
    thinkingLevel: globalThinkingLevel,
    setThinkingLevel,
    approvalMode: globalApprovalMode,
    setApprovalMode,
    activeTaskId,
    tasks,
    updateTaskThinkingLevel,
    updateTaskApprovalMode,
    selectedProject,
    setSelectedProject,
    projects,
    addProject,
  } = useAppStore();

  // 任务级隔离（对齐 ZCode task-local thoughtLevel/mode）：有活动任务读写任务字段，
  // 草稿态读写全局默认（首次发送时随 createTask 落到新任务上）。
  const activeTask = activeTaskId ? tasks.find((task) => task.id === activeTaskId) ?? null : null;
  const thinkingLevel = activeTask?.thinkingLevel ?? globalThinkingLevel;
  const approvalMode = activeTask?.approvalMode ?? globalApprovalMode;

  const handleSelectThinkingLevel = (level: typeof globalThinkingLevel) => {
    if (activeTaskId) updateTaskThinkingLevel(activeTaskId, level);
    else setThinkingLevel(level);
    // 仅草稿（全局默认）选择同步为模型默认 effort；任务级选择不污染全局模型配置。
    if (!activeTaskId && providerId && modelId && level !== "off") {
      updateModelEffortDefaultLevel(providerId, modelId, level as any).catch(console.error);
    }
  };

  const handleSelectApprovalMode = (mode: ComposerApprovalMode) => {
    if (activeTaskId) updateTaskApprovalMode(activeTaskId, mode);
    else setApprovalMode(mode);
  };

  const [text, setText] = useState("");
  const [showMentionMenu, setShowMentionMenu] = useState(false);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  /** `/` 菜单查询词（命令名过滤） */
  const [slashQuery, setSlashQuery] = useState("");
  /** 工作区自定义命令（.ReinAgent/commands/*.md，扫描一次缓存） */
  const [customCommands, setCustomCommands] = useState<SlashCommand[]>([]);
  /** `@` 菜单的候选文件（glob 结果，随查询词刷新） */
  const [mentionCandidates, setMentionCandidates] = useState<string[]>([]);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionLoading, setMentionLoading] = useState(false);
  // 键盘导航高亮（↑/↓ 移动、Enter/Tab 选中）：斜杠菜单与提及菜单各一个下标
  const [slashIndex, setSlashIndex] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const mentionMenuRef = useRef<HTMLDivElement>(null);
  const [showApprovalMenu, setShowApprovalMenu] = useState(false);
  const [showThinkingMenu, setShowThinkingMenu] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const [projectSearchQuery, setProjectSearchQuery] = useState("");
  const [showRemoteDialog, setShowRemoteDialog] = useState(false);
  const [remoteHost, setRemoteHost] = useState("");

  // 附件（对齐 LiveAgent PendingUploadedFile：路径引用 + 图片预览；上限 9 个）
  const [attachments, setAttachments] = useState<
    { path: string; name: string; kind: "image" | "file"; sizeBytes: number; previewUrl?: string }[]
  >([]);
  const [previewAttachment, setPreviewAttachment] = useState<
    { path: string; name: string; previewUrl?: string } | null
  >(null);
  const [pickingFiles, setPickingFiles] = useState(false);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowMentionMenu(false);
        setShowSlashMenu(false);
        setShowApprovalMenu(false);
        setShowThinkingMenu(false);
        setShowModelMenu(false);
        setShowProjectMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (focusRequestTrigger !== undefined && focusRequestTrigger > 0) {
      textareaRef.current?.focus();
    }
  }, [focusRequestTrigger]);

  // 快捷动作卡预填（EmptyState）：nonce 变化 → 把提示词填入输入框并聚焦，
  // 光标移到末尾；**不自动发送**（用户可编辑后手动发送）。
  const prefillNonce = prefillRequest?.nonce ?? 0;
  useEffect(() => {
    if (prefillNonce === 0 || !prefillRequest) return;
    setText(prefillRequest.text);
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      const end = prefillRequest.text.length;
      ta.setSelectionRange(end, end);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只按 nonce 触发；text 随 nonce 一起到位
  }, [prefillNonce]);

  // Keep focused when mounted in hasMessages mode
  useEffect(() => {
    if (hasMessages) {
      const timer = setTimeout(() => {
        textareaRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [hasMessages]);

  const submit = async () => {
    const trimmed = text.trim();
    if ((trimmed.length === 0 && attachments.length === 0) || isStreaming) return;

    const supportsImage = currentModel?.supportsImage === true;
    const { payload, imageInputs } = await buildOutgoingPayload(trimmed, attachments, supportsImage);

    const userAttachments = attachments.map((a) => ({
      path: a.path,
      name: a.name,
      kind: a.kind,
      previewUrl: a.previewUrl,
    }));
    const accepted = onSend(
      payload,
      imageInputs.length > 0 ? imageInputs : undefined,
      userAttachments.length > 0 ? userAttachments : undefined,
    );
    if (accepted) {
      setText("");
      setAttachments([]);
      setShowMentionMenu(false);
      setShowSlashMenu(false);
      // Keep input focused after sending
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 0);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 菜单键盘导航（优先于发送语义）：↑/↓ 移动高亮，Enter/Tab 选中
    if (showSlashMenu && slashFiltered.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((cur) =>
          e.key === "ArrowDown"
            ? (cur + 1) % slashFiltered.length
            : (cur - 1 + slashFiltered.length) % slashFiltered.length,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const cmd = slashFiltered[Math.min(slashIndex, slashFiltered.length - 1)];
        const args = text.trim().split(/\s+/).slice(1).join(" ");
        if (cmd.kind === "builtin") runBuiltinCommand(cmd, args);
        else applyCustomCommand(cmd, args);
        return;
      }
    }
    if (showMentionMenu && mentionCandidates.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((cur) =>
          e.key === "ArrowDown"
            ? (cur + 1) % mentionCandidates.length
            : (cur - 1 + mentionCandidates.length) % mentionCandidates.length,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention(mentionCandidates[Math.min(mentionIndex, mentionCandidates.length - 1)]);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }

    if (e.key === "Escape") {
      setShowMentionMenu(false);
      setShowSlashMenu(false);
      setShowApprovalMenu(false);
      setShowThinkingMenu(false);
      setShowProjectMenu(false);
      setShowRemoteDialog(false);
    }
  };

  // ---- 自定义斜杠命令：工作区 .ReinAgent/commands/*.md（对齐 ZCode 命令文件）----
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const entries = await invoke<{ name?: unknown; description?: unknown; body?: unknown }[]>(
          "commands_scan",
          { workspaceRoot: workspaceRoot ?? null },
        );
        if (!cancelled) setCustomCommands(toCustomCommands(entries));
      } catch (err) {
        // 无 Tauri（Web 模式）或目录不可读：自定义命令为空即可，内置命令仍可用
        console.warn("[commands] scan failed (custom commands disabled):", err);
        if (!cancelled) setCustomCommands([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceRoot]);

  // ---- @ 提及候选：glob 工作区文件（防抖 200ms；仅在提及态查询）----
  const mentionQueryRef = useRef<string | null>(null);
  useEffect(() => {
    if (!showMentionMenu) return;
    const query = mentionQueryRef.current ?? "";
    setMentionLoading(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          const pattern = query ? `**/*${query}*` : "**/*";
          const result = await invoke<{ entries: { path: string; is_dir: boolean }[] }>("fs_glob", {
            root: workspaceRoot ?? "",
            pattern,
            limit: 80,
          });
          setMentionCandidates(
            result.entries.slice(0, 40).map((e) => (e.is_dir ? e.path + "/" : e.path)),
          );
        } catch (err) {
          console.warn("[mentions] glob failed:", err);
          setMentionCandidates([]);
        } finally {
          setMentionLoading(false);
        }
      })();
    }, 200);
    return () => window.clearTimeout(timer);
  }, [showMentionMenu, mentionQuery, workspaceRoot]);

  // 斜杠菜单过滤结果（组件层计算：keydown 导航与菜单渲染共用同一份列表）
  const slashFiltered = useMemo(
    () => filterCommands([...BUILTIN_COMMANDS, ...customCommands], slashQuery),
    [customCommands, slashQuery],
  );
  // 高亮项变化时滚动进可视区
  useEffect(() => {
    if (!showSlashMenu) return;
    slashMenuRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [slashIndex, showSlashMenu]);
  useEffect(() => {
    if (!showMentionMenu) return;
    mentionMenuRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [mentionIndex, showMentionMenu, mentionCandidates]);
  // 查询词/候选变化或菜单开合时，高亮回到第一项
  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery, showSlashMenu]);
  useEffect(() => {
    setMentionIndex(0);
  }, [mentionQuery, showMentionMenu, mentionCandidates]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);

    // 真菜单：命令态 = 以 / 开头且未出现空格；提及态 = @ 前是行首/空白且其后无空白
    const slash = parseSlashQuery(val);
    const mention = parseMentionQuery(val);
    setShowSlashMenu(slash !== null);
    setShowMentionMenu(mention !== null);
    setSlashQuery(slash ?? "");
    if (mention !== null && mention !== mentionQueryRef.current) {
      mentionQueryRef.current = mention;
      setMentionQuery(mention); // 触发候选刷新
    }
  };

  /** 选中自定义命令：模板展开后**填入输入框**（可编辑，不直接发送）。 */
  const applyCustomCommand = (cmd: SlashCommand, args: string) => {
    setText(expandCommandTemplate(cmd.body ?? "", args));
    setShowSlashMenu(false);
    textareaRef.current?.focus();
  };

  /** 选中内置命令：交给 App 层执行（清空/压缩/帮助）。 */
  const runBuiltinCommand = (cmd: SlashCommand, args: string) => {
    setShowSlashMenu(false);
    if (cmd.name === "clear") {
      onClearConversation?.();
      setText("");
      return;
    }
    if (cmd.name === "compact") {
      onCompactRequest?.();
      setText("");
      return;
    }
    // help：把可用命令列表贴回输入框（不发送）
    const lines = [
      "可用斜杠命令：",
      ...BUILTIN_COMMANDS.map((c) => `/${c.name} — ${c.description}`),
      ...customCommands.map((c) => `/${c.name} — ${c.description}`),
    ];
    setText(lines.join("\n"));
    textareaRef.current?.focus();
    void args;
  };

  const insertMention = (item: string) => {
    // 把「@查询词」替换为「@路径 」（带空格收尾，便于继续输入）
    setText((prev) => prev.replace(/@[^\s@]*$/, `@${item} `));
    setShowMentionMenu(false);
    textareaRef.current?.focus();
  };

  const MAX_ATTACHMENTS = 9;
  const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
  const isImagePath = (p: string) =>
    IMAGE_EXTS.includes(p.split(".").pop()?.toLowerCase() ?? "");

  /** "+" 添加文件：rfd 原生多选对话框 → 图片加载缩略图 */
  const addPickedFiles = async () => {
    if (pickingFiles) return;
    setPickingFiles(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const paths = await invoke<string[]>("fs_pick_files", {
        workdir: workspaceRoot ?? undefined,
      });
      if (Array.isArray(paths)) {
        const remaining = MAX_ATTACHMENTS - attachmentsRef.current.length;
        for (const path of paths.slice(0, Math.max(0, remaining))) {
          const image = isImagePath(path);
          let previewUrl: string | undefined;
          if (image) {
            try {
              const preview = await invoke<{ mime: string; base64: string }>(
                "fs_read_image_preview",
                { path },
              );
              previewUrl = `data:${preview.mime};base64,${preview.base64}`;
            } catch (err) {
              console.warn("[attachment] preview failed:", err);
            }
          }
          setAttachments((prev) =>
            prev.some((a) => a.path === path)
              ? prev
              : [
                  ...prev,
                  {
                    path,
                    name: path.split(/[\/]/).pop() || path,
                    kind: (image ? "image" : "file") as "image" | "file",
                    sizeBytes: 0,
                    previewUrl,
                  },
                ],
          );
        }
      }
    } catch (err) {
      console.warn("[attachment] pick files failed:", err);
    } finally {
      setPickingFiles(false);
    }
  };

  const removeAttachment = (path: string) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  };

  /** Ctrl+V 粘贴图片：base64 → Rust 落盘 .ReinAgent/temp/pasted/ → 路径引用附件 */
  const handlePasteFiles = async (files: File[]) => {
    const { invoke } = await import("@tauri-apps/api/core");
    for (const file of files) {
      if (attachmentsRef.current.length >= MAX_ATTACHMENTS) break;
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
          workdir: workspaceRoot ?? "",
        });
        setAttachments((prev) =>
          prev.some((a) => a.path === path)
            ? prev
            : [
                ...prev,
                {
                  path,
                  name,
                  kind: "image" as const,
                  sizeBytes: file.size,
                  previewUrl: URL.createObjectURL(file),
                },
              ],
        );
      } catch (err) {
        console.warn("[attachment] paste import failed:", err);
      }
    }
  };

  const handleTextareaPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length > 0) {
      e.preventDefault();
      void handlePasteFiles(files);
    }
  };

  // 合并全局已打开项目与预设项目
  const availableProjects = Array.from(
    new Set([...projects, ...MOCK_PROJECTS.map((p) => p.name)])
  );
  const filteredProjects = availableProjects.filter((name) =>
    name.toLowerCase().includes(projectSearchQuery.toLowerCase().trim())
  );

  const handleOpenFolder = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const selected = await invoke<string | null>("fs_pick_folder", {
        initialDir: selectedProject || null,
      });
      if (selected && typeof selected === "string" && selected.trim().length > 0) {
        addProject(selected.trim());
        setSelectedProject(selected.trim());
        return;
      }
    } catch (err) {
      console.warn("fs_pick_folder unavailable or failed, fallback to file input", err);
      folderInputRef.current?.click();
    }
  };

  const handleFolderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const firstPath = files[0].webkitRelativePath;
      const folderName = firstPath ? firstPath.split("/")[0] : files[0].name;
      if (folderName) {
        addProject(folderName);
        setSelectedProject(folderName);
      }
    }
  };

  const placeholder = hasMessages 
    ? (t("composerPlaceholderFollowUp") || "提出后续修改要求") 
    : (t("composerPlaceholder") || "向 ReinAgent 提问，@ 添加上下文，/ 选择命令");

  const innerCard = (
    <div
      className={`relative ${
        hasMessages
          ? "rounded-2xl border border-[var(--capsule-border)] shadow-[var(--capsule-shadow)]"
          : "rounded-2xl border-t border-[var(--capsule-border)] shadow-xs"
      } bg-[var(--capsule-bg)] w-full flex flex-col overflow-visible`}
    >
      {/* 附件条（对齐 LiveAgent ComposerAttachmentCard）：图片缩略图点击放大，非图片图标横条，右上角删除 */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 pt-3 pb-1">
          {attachments.map((a) =>
            a.kind === "image" ? (
              <div key={a.path} className="relative">
                <button
                  type="button"
                  ref={(el) => {
                    // 原生 onclick 绑定：React 合成事件在流式渲染期间可能丢点击，
                    // 原生属性赋值绕过委托系统（赋值函数每次渲染刷新，捕获最新 a）
                    if (el) {
                      el.onclick = (ev) => {
                        ev.stopPropagation();
                        setPreviewAttachment(a);
                      };
                    }
                  }}
                  className="block w-16 h-16 rounded-lg overflow-hidden border border-[var(--capsule-border)] cursor-zoom-in bg-[var(--surface)]"
                  title={a.name}
                >
                  {a.previewUrl ? (
                    <img src={a.previewUrl} alt={a.name} className="w-full h-full object-cover" />
                  ) : (
                    <span className="flex items-center justify-center w-full h-full text-[var(--text-secondary)]">
                      <ImageIcon className="w-4 h-4" />
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => removeAttachment(a.path)}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-[var(--bg-elev)] border border-[var(--capsule-border)] text-[var(--text-secondary)] hover:text-red-500 flex items-center justify-center"
                  title="移除"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            ) : (
              <div
                key={a.path}
                className="relative flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[var(--surface)] border border-[var(--capsule-border)] text-xs text-[var(--text-primary)]"
              >
                <FileText className="w-3.5 h-3.5 text-blue-500" />
                <span className="max-w-40 truncate">{a.name}</span>
                <button
                  type="button"
                  onClick={() => removeAttachment(a.path)}
                  className="text-[var(--text-secondary)] hover:text-red-500 ml-1"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ),
          )}
        </div>
      )}

      {/* Mention Dropdown */}
      {/* @ Mention Menu（真实现：glob 工作区文件，选中后把 @路径 插入输入框；
          发送时 App 层读取内容并挂到 user 消息尾部 —— 对齐 ZCode/LiveAgent 的提及注入） */}
      {showMentionMenu && (
        <div ref={mentionMenuRef} data-menu="mention" className="absolute bottom-full left-4 mb-2 w-80 max-h-64 overflow-y-auto rounded-xl border border-[var(--capsule-border)] bg-[var(--capsule-bg)] shadow-lg py-1 text-xs z-50">
          <div className="sticky top-0 px-3 py-1.5 font-semibold text-[var(--text-secondary)] border-b border-[var(--capsule-border)] bg-[var(--capsule-bg)] flex items-center gap-1.5">
            <AtSign className="w-3.5 h-3.5" />
            <span>{t("mentionTitle")}</span>
            {mentionLoading ? <span className="text-[10px] opacity-60">…</span> : null}
          </div>
          {mentionCandidates.length === 0 ? (
            <div className="px-3 py-2 text-[var(--text-secondary)]">
              {mentionLoading ? t("mentionSearching") : t("mentionNoResults")}
            </div>
          ) : (
            mentionCandidates.map((candidate, index) => (
              <button
                key={candidate}
                type="button"
                data-active={index === mentionIndex ? "true" : undefined}
                onClick={() => insertMention(candidate)}
                className={`w-full text-left px-3 py-1.5 text-[var(--text-primary)] flex items-center gap-2 ${
                  index === mentionIndex ? "bg-[var(--surface-hover)]" : "hover:bg-[var(--surface)]"
                }`}
                title={candidate}
              >
                <FileCode className="w-3.5 h-3.5 shrink-0 text-blue-500" />
                <span className="truncate">{candidate}</span>
              </button>
            ))
          )}
        </div>
      )}

      {/* Slash Command Menu（真实现）：内置命令（宿主执行）+ 工作区自定义命令
          （.ReinAgent/commands/*.md，模板展开填入输入框） */}
      {showSlashMenu && (() => {
        const filtered = slashFiltered;
        // 参数串 = 用户在命令名后输入的内容（`/review foo` 的 `foo`）
        const args = text.trim().split(/\s+/).slice(1).join(" ");
        return (
          <div ref={slashMenuRef} data-menu="slash" className="absolute bottom-full left-4 mb-2 w-80 max-h-64 overflow-y-auto rounded-xl border border-[var(--capsule-border)] bg-[var(--capsule-bg)] shadow-lg py-1 text-xs z-50">
            <div className="sticky top-0 px-3 py-1.5 font-semibold text-[var(--text-secondary)] border-b border-[var(--capsule-border)] bg-[var(--capsule-bg)]">
              {t("slashTitle")}
            </div>
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-[var(--text-secondary)]">{t("slashNoResults")}</div>
            ) : (
              filtered.map((cmd, index) => (
                <button
                  key={`${cmd.kind}-${cmd.name}`}
                  type="button"
                  data-active={index === slashIndex ? "true" : undefined}
                  onClick={() =>
                    cmd.kind === "builtin"
                      ? runBuiltinCommand(cmd, args)
                      : applyCustomCommand(cmd, args)
                  }
                  className={`w-full text-left px-3 py-1.5 text-[var(--text-primary)] flex flex-col ${
                    index === slashIndex ? "bg-[var(--surface-hover)]" : "hover:bg-[var(--surface)]"
                  }`}
                >
                  <span className="font-medium flex items-center gap-1.5">
                    <span className="font-mono">/{cmd.name}</span>
                    <span className="text-[10px] rounded px-1 py-0.5 bg-[var(--surface)] text-[var(--text-secondary)]">
                      {cmd.kind === "builtin" ? t("slashBuiltin") : t("slashCustom")}
                    </span>
                  </span>
                  <span className="text-[10px] text-[var(--text-secondary)]">{cmd.description}</span>
                </button>
              ))
            )}
          </div>
        );
      })()}

      {/* Textarea */}
      <textarea
        ref={textareaRef}
        rows={hasMessages ? 2 : 3}
        value={text}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        onPaste={handleTextareaPaste}
        placeholder={placeholder}
        className="w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-secondary)] focus:outline-none leading-relaxed"
      />

      {/* Toolbar: 无分割线，左右分布 */}
      <div className="flex items-center justify-between px-3 pb-2.5 pt-1 relative">
        {/* 左侧：+ 号添加附件 & 审批模式（如 ✋ 变更前确认 ∨） */}
        <div className="flex items-center gap-1.5">
          {/* Add / Attach Button */}
          <button
            type="button"
            onClick={addPickedFiles}
            className="p-1.5 rounded-lg hover:bg-[var(--surface-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors flex items-center justify-center cursor-pointer"
            title={t("attachFile")}
          >
            <Plus className="w-4 h-4" />
          </button>

          {/* Approval Mode Dropdown（对齐 ZCode V4ComposerModeSwitch：图标+标题+描述，full 态 warning 色） */}
          <div className="relative">
            {(() => {
              const currentOption =
                APPROVAL_MODE_OPTIONS.find((opt) => opt.mode === approvalMode) ?? APPROVAL_MODE_OPTIONS[3];
              const CurrentIcon = currentOption.Icon;
              const isFullAccess = approvalMode === "full";
              return (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setShowApprovalMenu(!showApprovalMenu);
                      setShowThinkingMenu(false);
                    }}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-[var(--surface-hover)] text-xs transition-colors cursor-pointer ${
                      isFullAccess
                        ? "text-[var(--status-warn)]"
                        : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    <CurrentIcon className="w-3.5 h-3.5" />
                    <span>{t(currentOption.labelKey)}</span>
                    <ChevronDown className="w-3 h-3 opacity-70" />
                  </button>
                  {showApprovalMenu && (
                    <div className="absolute bottom-full left-0 mb-2 w-64 rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl p-1.5 text-xs z-50 flex flex-col gap-0.5">
                      {APPROVAL_MODE_OPTIONS.map(({ mode, labelKey, descKey, Icon }) => {
                        const isSelected = approvalMode === mode;
                        const optionFull = mode === "full";
                        return (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => {
                              handleSelectApprovalMode(mode);
                              setShowApprovalMenu(false);
                            }}
                            className={`w-full text-left px-2.5 py-2 rounded-lg transition-colors flex items-center gap-2.5 cursor-pointer ${
                              isSelected
                                ? "bg-[var(--accent)] text-white font-medium shadow-sm"
                                : "hover:bg-[var(--surface-hover)] text-[var(--text-primary)]"
                            }`}
                          >
                            <Icon
                              className={`w-4 h-4 shrink-0 ${
                                isSelected
                                  ? "text-white"
                                  : optionFull
                                    ? "text-[var(--status-warn)]"
                                    : "text-[var(--text-secondary)]"
                              }`}
                            />
                            <span className="flex flex-col gap-0.5 min-w-0">
                              <span className={optionFull && !isSelected ? "text-[var(--status-warn)]" : ""}>
                                {t(labelKey)}
                              </span>
                              <span
                                className={`text-[11px] font-normal ${
                                  isSelected ? "text-white/80" : "text-[var(--text-secondary)]"
                                }`}
                              >
                                {t(descKey)}
                              </span>
                            </span>
                            <Check
                              className={`w-3.5 h-3.5 ml-auto shrink-0 ${isSelected ? "opacity-100" : "opacity-0"}`}
                            />
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </div>

        {/* 右侧：上下文容量、模型选择、思考深度、发送按钮 */}
        <div className="flex items-center gap-2">
          {contextUsage && <ContextUsageIndicator data={contextUsage} />}
          {/* Model Selector Dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setShowModelMenu(!showModelMenu);
                setShowThinkingMenu(false);
                setShowApprovalMenu(false);
              }}
              className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-[var(--surface-hover)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
            >
              <span>{providerName}/{currentModel?.name || modelId}</span>
              <ChevronDown className="w-3 h-3 opacity-70" />
            </button>

            {showModelMenu && (
              <div className="absolute bottom-full right-0 mb-2 w-72 max-h-80 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl p-1.5 text-xs z-50 flex flex-col gap-1 backdrop-blur-md">
                {(() => {
                  // 收集所有已启用的服务商和模型
                  const enabledProviders = providers.filter((p) => p.enabled);
                  // 如果没有 providers 传入或没有启用的，至少展示当前 provider
                  const effectiveProviders =
                    enabledProviders.length > 0
                      ? enabledProviders
                      : [
                          {
                            id: providerId,
                            name: providerName,
                            models: currentModel ? [currentModel] : [],
                          },
                        ];

                  let hasAnyModel = false;

                  return (
                    <>
                      {effectiveProviders.map((p) => {
                        const enabledModels = (p.models || []).filter((m) => m.enabled !== false);
                        if (enabledModels.length === 0) return null;
                        hasAnyModel = true;

                        return (
                          <div key={p.id} className="space-y-0.5">
                            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]/70">
                              {p.name}
                            </div>
                            {enabledModels.map((m) => {
                              const isSelected = p.id === providerId && m.id === modelId;
                              const ctxLabel = formatModelContextWindowLabel(m.contextWindow);

                              return (
                                <button
                                  key={m.id}
                                  type="button"
                                  onClick={() => {
                                    onSelectModel?.(p.id, m.id);
                                    setShowModelMenu(false);
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

                      {!hasAnyModel && (
                        <div className="px-3 py-4 text-center text-xs text-[var(--text-secondary)]">
                          暂无已启用的模型，请前往“服务商设置”中启用模型
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            )}
          </div>

          {/* Thinking Level Dropdown */}
          <div className="relative">
            {(() => {
              // 推理等级兜底（对齐 LiveAgent）：未声明 effort 的模型乐观视为支持思考，
              // 提供通用档位（不含 xhigh / max —— 这两档需要模型显式映射，未知模型不发）。
              const isEffortSupported = true;
              const supportedList = currentModel?.effort?.supportedLevels?.length
                ? currentModel.effort.supportedLevels
                : ["default", "low", "medium", "high"];

              // 声明了 supportedLevels 的模型仍严格按声明过滤（不臆测加档）
              const visibleOptions = THINKING_OPTIONS.filter(
                (opt) => supportedList.includes(opt.level as any)
              );

              const currentOpt =
                visibleOptions.find((opt) => opt.level === thinkingLevel) ||
                (currentModel?.effort?.defaultLevel
                  ? visibleOptions.find((opt) => opt.level === currentModel.effort!.defaultLevel)
                  : undefined) ||
                visibleOptions[0] ||
                THINKING_OPTIONS[0];

              // 档位选择用组件顶部的任务级感知 handler（activeTask ? 任务字段 : 全局默认）。

              return (
                <>
                  <button
                    type="button"
                    disabled={!isEffortSupported}
                    onClick={() => {
                      if (!isEffortSupported) return;
                      setShowThinkingMenu(!showThinkingMenu);
                      setShowApprovalMenu(false);
                    }}
                    title={
                      !isEffortSupported
                        ? "Model does not support reasoning effort"
                        : undefined
                    }
                    className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs transition-colors ${
                      isEffortSupported
                        ? "hover:bg-[var(--surface-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
                        : "opacity-40 text-[var(--text-dim)] cursor-not-allowed border border-transparent select-none"
                    }`}
                  >
                    <Brain className="w-3.5 h-3.5 opacity-80" />
                    <span className="font-mono">
                      {!isEffortSupported ? "Reasoning: Disabled" : currentOpt.label}
                    </span>
                    <ChevronDown className={`w-3 h-3 ${isEffortSupported ? "opacity-70" : "opacity-30"}`} />
                  </button>

                  {showThinkingMenu && isEffortSupported && (
                    <div className="absolute bottom-full right-0 mb-2 w-56 rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl p-1.5 text-xs z-50 flex flex-col gap-0.5 backdrop-blur-md">
                      {visibleOptions.map(({ level, label, steps }) => {
                        const isSelected = thinkingLevel === level;
                        return (
                          <button
                            key={level}
                            type="button"
                            onClick={() => {
                              handleSelectThinkingLevel(level);
                              setShowThinkingMenu(false);
                            }}
                            className={`w-full text-left px-2.5 py-1.5 rounded-lg transition-colors flex items-center justify-between cursor-pointer font-mono ${
                              isSelected
                                ? "bg-[var(--accent)] text-[var(--accent-contrast)] font-medium shadow-sm"
                                : "hover:bg-[var(--surface-hover)] text-[var(--text-primary)]"
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className={`w-2 h-2 rounded-full shrink-0 transition-opacity ${
                                  isSelected ? "bg-current opacity-100" : "bg-transparent opacity-0"
                                }`}
                              />
                              <span className="text-xs">{label}</span>
                            </div>
                            <span
                              className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                                isSelected
                                  ? "bg-black/20 text-white/90"
                                  : "bg-[var(--surface-active)] text-[var(--text-dim)] border border-[var(--border)]"
                              }`}
                            >
                              {steps} steps
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              );
            })()}
          </div>

          {/* Send/Stop Button */}
          <div className="flex items-center ml-1">
            {isStreaming ? (
              <button
                type="button"
                onClick={onStop}
                className="w-7 h-7 rounded-lg bg-red-500 text-white flex items-center justify-center hover:bg-red-600 transition-colors shadow-xs cursor-pointer"
                title={t("stop")}
              >
                <Square className="w-3 h-3 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={text.trim().length === 0 && attachments.length === 0}
                className="w-7 h-7 rounded-lg bg-[#5c5c60] hover:bg-[#6e6e73] dark:bg-[#5c5c60] dark:hover:bg-[#6e6e73] text-white flex items-center justify-center disabled:opacity-35 disabled:hover:bg-[#5c5c60] transition-all cursor-pointer shadow-xs"
                title={t("send")}
              >
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
      {/* 图片放大预览（Lightbox）：点遮罩或 X 关闭 */}
      {previewAttachment && (
        <div
          className="fixed inset-0 z-[100] bg-black/85 flex items-center justify-center cursor-zoom-out"
          onClick={() => setPreviewAttachment(null)}
        >
          {previewAttachment.previewUrl && (
            <img
              src={previewAttachment.previewUrl}
              alt={previewAttachment.name}
              className="max-w-[94vw] max-h-[94vh] object-contain rounded-lg shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
          )}
          <button
            type="button"
            className="absolute top-4 right-4 w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors cursor-pointer"
            title="关闭"
            onClick={(e) => {
              e.stopPropagation();
              setPreviewAttachment(null);
            }}
          >
            <X className="w-5 h-5" />
          </button>
          <span className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1 rounded-lg bg-black/60 text-white text-xs font-mono">
            {previewAttachment.name}
          </span>
        </div>
      )}
    </div>
  );

  if (hasMessages) {
    return (
      <div ref={containerRef} className="relative w-full overflow-visible">
        {innerCard}
      </div>
    );
  }

  return (
    <div 
      ref={containerRef}
      className="relative rounded-2xl border border-[var(--capsule-outer-border)] bg-[var(--capsule-outer-bg)] shadow-[var(--capsule-shadow)] w-full flex flex-col transition-all overflow-visible"
    >
      {/* Hidden Folder Picker Input */}
      <input
        ref={folderInputRef}
        type="file"
        // @ts-ignore
        webkitdirectory=""
        directory=""
        multiple
        className="hidden"
        onChange={handleFolderChange}
      />

      {/* Top Outer Layer: Project Selector Header */}
      <div className="px-4 pt-2.5 pb-2.5 flex items-center justify-between">
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setShowProjectMenu(!showProjectMenu);
              setShowMentionMenu(false);
              setShowSlashMenu(false);
              setShowApprovalMenu(false);
              setShowThinkingMenu(false);
            }}
            className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer select-none py-1 px-1.5 rounded-md hover:bg-[var(--surface-hover)] -ml-1"
          >
            <Folder className="w-3.5 h-3.5 opacity-80" />
            <span className="font-normal">
              {selectedProject || "DefaultProject"}
            </span>
            <ChevronDown className="w-3 h-3 opacity-60 ml-0.5" />
          </button>

          {showProjectMenu && (
            <div className="absolute bottom-full left-0 mb-2 w-64 rounded-xl border border-[var(--capsule-border)] bg-[var(--capsule-bg)] shadow-2xl py-1 text-xs z-50 animate-in fade-in slide-in-from-bottom-2 backdrop-blur-md">
              {/* Search input */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--capsule-border)]">
                <Search className="w-3.5 h-3.5 text-[var(--text-secondary)] shrink-0" />
                <input
                  type="text"
                  value={projectSearchQuery}
                  onChange={(e) => setProjectSearchQuery(e.target.value)}
                  placeholder={t("searchWorkspace")}
                  className="w-full bg-transparent text-xs text-[var(--text-primary)] placeholder-[var(--text-secondary)] focus:outline-none"
                  autoFocus
                />
              </div>

              {/* Project items */}
              <div className="max-h-48 overflow-y-auto py-1">
                {filteredProjects.map((proj) => (
                  <button
                    key={proj}
                    type="button"
                    onClick={() => {
                      setSelectedProject(proj);
                      setShowProjectMenu(false);
                    }}
                    className="w-full flex items-center justify-between px-3 py-2 hover:bg-[var(--surface-hover)] text-[var(--text-primary)] transition-colors cursor-pointer text-left"
                  >
                    <div className="flex items-center gap-2 truncate">
                      <Folder className="w-3.5 h-3.5 text-[var(--text-secondary)] shrink-0" />
                      <span className="truncate">{proj}</span>
                    </div>
                    {selectedProject === proj && (
                      <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0 ml-2" />
                    )}
                  </button>
                ))}
                {filteredProjects.length === 0 && (
                  <div className="px-3 py-2 text-[var(--text-secondary)] text-center text-xs">
                    无匹配工作区
                  </div>
                )}
              </div>

              <div className="border-t border-[var(--capsule-border)] my-1" />

              {/* Action: 打开文件夹 */}
              <button
                type="button"
                onClick={() => {
                  handleOpenFolder();
                  setShowProjectMenu(false);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[var(--surface-hover)] text-[var(--text-primary)] transition-colors cursor-pointer text-left"
              >
                <FolderPlus className="w-3.5 h-3.5 text-[var(--text-secondary)] shrink-0" />
                <span>{t("openFolder")}</span>
              </button>

              {/* Action: 远程连接 */}
              <button
                type="button"
                onClick={() => {
                  setShowRemoteDialog(true);
                  setShowProjectMenu(false);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[var(--surface-hover)] text-[var(--text-primary)] transition-colors cursor-pointer text-left"
              >
                <Cloud className="w-3.5 h-3.5 text-[var(--text-secondary)] shrink-0" />
                <span>{t("remoteConnect")}</span>
              </button>

              {/* Action: 不在项目中工作 */}
              <button
                type="button"
                onClick={() => {
                  setSelectedProject(null);
                  setShowProjectMenu(false);
                }}
                className="w-full flex items-center justify-between px-3 py-2 hover:bg-[var(--surface-hover)] text-[var(--text-primary)] transition-colors cursor-pointer text-left"
              >
                <div className="flex items-center gap-2 truncate">
                  <MessageSquare className="w-3.5 h-3.5 text-[var(--text-secondary)] shrink-0" />
                  <span>{t("workOutsideProject")}</span>
                </div>
                {selectedProject === null && (
                  <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0 ml-2" />
                )}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Inner Card (The second layer!) */}
      {innerCard}

      {/* Remote Connection Dialog Modal */}
      {showRemoteDialog && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-[var(--surface)] border border-[var(--capsule-border)] rounded-xl shadow-2xl p-5 w-full max-w-sm flex flex-col gap-3.5 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-medium text-sm text-[var(--text-primary)]">
                <Cloud className="w-4 h-4 text-blue-500" />
                <span>{t("remoteConnect")}</span>
              </div>
              <button
                type="button"
                onClick={() => setShowRemoteDialog(false)}
                className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-[var(--text-secondary)]">
                输入远程主机或 SSH 连接串
              </label>
              <input
                type="text"
                placeholder="ssh://user@hostname:path"
                value={remoteHost}
                onChange={(e) => setRemoteHost(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && remoteHost.trim()) {
                    setSelectedProject(remoteHost.trim());
                    setShowRemoteDialog(false);
                  }
                }}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[var(--bg)] border border-[var(--capsule-border)] text-[var(--text-primary)] placeholder-[var(--text-secondary)] focus:outline-none focus:border-blue-500"
                autoFocus
              />
            </div>

            <div className="flex justify-end gap-2 text-xs pt-1">
              <button
                type="button"
                onClick={() => setShowRemoteDialog(false)}
                className="px-3 py-1.5 rounded-md hover:bg-[var(--surface-hover)] text-[var(--text-secondary)] cursor-pointer"
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (remoteHost.trim()) {
                    setSelectedProject(remoteHost.trim());
                    setShowRemoteDialog(false);
                  }
                }}
                disabled={!remoteHost.trim()}
                className="px-3.5 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white cursor-pointer font-medium transition-colors"
              >
                连接
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
