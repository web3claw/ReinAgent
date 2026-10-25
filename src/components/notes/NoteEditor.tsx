import { useState, useEffect, useRef, useCallback, useMemo, type ComponentType } from "react";
import {
  Heading2,
  Heading3,
  Bold,
  Italic,
  Strikethrough,
  Code2,
  Quote,
  List,
  ListOrdered,
  ListTodo,
  SquareCode,
  Sparkles,
  Link2,
  Table2,
  Minus,
  Workflow,
  Check,
  Calendar,
  Clock,
  Folder,
  Edit3,
  Send,
  X,
  Bot,
  ChevronDown,
  Square,
} from "lucide-react";
import { useTranslation } from "../../i18n";
import { MilkdownEditor, type MilkdownEditorHandle, type SelectionInfo } from "./MilkdownEditor";
import { NoteAiSidebar } from "./NoteAiSidebar";
import { notesService, type NoteFileItem } from "./notesService";
import { NoteVersionPanel, NoteTagEditor } from "./NoteEnhancePanels";
import { useSettings } from "../../lib/settings/useSettings";
import { kvGetJSON, kvSetJSON } from "../../lib/storage/db";
import { NOTEAI_MODEL_KV_KEY, bindingToNoteKey, noteKeyToBinding } from "../../lib/settings/scenarioModels";
import type { ProviderConfig } from "../../lib/providers/modelFactory";
import { completeOneShotText } from "../../lib/promptEnhancement/enhance";
import { buildInlineAiPrompt } from "./noteEnhance";
import {
  loadProvidersConfigFromDisk,
  type ProviderItem,
} from "../settings/model-provider/types";

interface NoteEditorProps {
  /** 全量标签映射（ROADMAP ④；NotesPage 持有） */
  allTags?: Record<string, string[]>;
  /** 标签变更后通知父层刷新 */
  onTagsChanged?: () => void;
  note: NoteFileItem | null;
  onSaveContent: (content: string, source?: string) => Promise<void>;
  onRenameTitle: (newTitle: string) => Promise<void>;
}

interface FormatAction {
  key: string;
  icon: ComponentType<{ className?: string }>;
  title: string;
  run: (md: MilkdownEditorHandle) => void;
}

/** 自动保存防抖（用户定稿 2026-10-25：1s → 5s——纯打字不记版本的配套取舍，
 * 崩溃丢失窗口 ≤5s；AI/手动/还原路径不受防抖影响（AI 搭便车但即时应用，Ctrl+S 冲刷立即存）。 */
const AUTOSAVE_DEBOUNCE_MS = 5000;

const FORMAT_ACTIONS: FormatAction[] = [
  { key: "h2", icon: Heading2, title: "二级标题 (H2)", run: (md) => md.toggleHeading(2) },
  { key: "h3", icon: Heading3, title: "三级标题 (H3)", run: (md) => md.toggleHeading(3) },
  { key: "bold", icon: Bold, title: "加粗 (Ctrl+B)", run: (md) => md.toggleBold() },
  { key: "italic", icon: Italic, title: "斜体 (Ctrl+I)", run: (md) => md.toggleItalic() },
  { key: "strike", icon: Strikethrough, title: "删除线", run: (md) => md.toggleStrikethrough() },
  { key: "code", icon: Code2, title: "行内代码", run: (md) => md.toggleInlineCode() },
  { key: "quote", icon: Quote, title: "引用", run: (md) => md.toggleBlockquote() },
  { key: "ul", icon: List, title: "无序列表", run: (md) => md.toggleBulletList() },
  { key: "ol", icon: ListOrdered, title: "有序列表", run: (md) => md.toggleOrderedList() },
  { key: "todo", icon: ListTodo, title: "待办任务", run: (md) => md.toggleTodo() },
  { key: "codeblock", icon: SquareCode, title: "代码块", run: (md) => md.insertCodeBlock() },
];

/** AI 动作预设提示词：点击胶囊后自动预填入输入框，用户可按需补充修改 */
const AI_PRESET_ACTIONS = [
  { key: "polish", label: "润色", prompt: "请对以下文字进行润色，优化语句通顺度并修正错别字，保持专业客观：" },
  { key: "translate", label: "翻译", prompt: "请将以下内容翻译为地道的英文（若原为英文则译为中文）：" },
  { key: "condense", label: "精简", prompt: "请用凝练的语言提炼并精简以下内容要点：" },
  { key: "expand", label: "扩展", prompt: "请根据上述内容进行扩展阐述，补充论据和细节：" },
  { key: "explain", label: "解释", prompt: "请深入浅出地解释以下内容的核心概念与逻辑：" },
];

function aiActionPreset(key: string): string {
  const found = AI_PRESET_ACTIONS.find((a) => a.key === key);
  return found ? found.prompt : "";
}

/**
 * 剥离 AI 输出中的对话性前后缀与代码块包裹，保留正文。
 */
function sanitizeAiResult(
  raw: string,
  context: { noteTitle?: string; selectedText?: string } = {}
): string {
  let text = raw.trim();
  const fenceMatch = text.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  if (fenceMatch) text = fenceMatch[1].trim();
  const lines = text.split("\n");
  const prefixRe =
    /^\s*(?:[#>*\s-]*)(?:好的[，,。!！]?|没问题[，,。!！]?|当然[，,。!！]?|以下是[^：:]*|这是[^：:]*|已为您[^：:]*|我将[^：:]*|我来[^：:]*|润色后|翻译后|简化后|扩展后|续写后|结果|修改后)\s*[：:，,。]?\s*$/;
  while (lines.length > 1 && prefixRe.test(lines[0])) lines.shift();
  const suffixRe =
    /^\s*(?:[#>*\s-]*)(?:希望|如需|如果|若|以上[。！!]?|如需调整|欢迎提出|请告诉我|可以告诉我)[^\n]{0,40}$/;
  while (lines.length > 1 && suffixRe.test(lines[lines.length - 1])) lines.pop();

  for (let i = 0; i < lines.length; i++) {
    lines[i] = lines[i]
      .replace(/^(\s*#{1,6})([^\s#])/, "$1 $2")
      .replace(/^(\s*[-*+])([^\s*+-])/, "$1 $2");
  }

  let result = lines.join("\n").trim();
  const prefixes = [context.noteTitle, context.selectedText]
    .map((t) => (t ?? "").trim().replace(/^#+\s*/, ""))
    .filter((t) => t.length >= 2);
  if (prefixes.length > 0) {
    const resultLines = result.split("\n");
    const heading = resultLines[0]?.match(/^\s*(#{1,6})\s*(.+)$/);
    if (heading && resultLines.length > 0) {
      const headingText = heading[2].trim();
      const matched = prefixes.find((p) =>
        headingText.toLowerCase().startsWith(p.slice(0, Math.min(6, p.length)).toLowerCase())
      );
      const extra = matched ? headingText.slice(matched.length).trim() : "";
      const looksLikeProse = extra.length > 12 || /[，。；、,.;:！!？?]/.test(extra);
      if (matched && extra && looksLikeProse) {
        resultLines[0] = `${heading[1]} ${matched}`;
        resultLines.splice(1, 0, "", extra);
        result = resultLines.join("\n").trim();
      }
    }
  }
  return result;
}

export function NoteEditor({ note, onSaveContent, onRenameTitle, allTags, onTagsChanged }: NoteEditorProps) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "unsaved">("saved");
  const [isVersionOpen, setIsVersionOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState<string | null>(null);
  const [isAiSidebarOpen, setIsAiSidebarOpen] = useState(false);

  // 选区与行内 AI 浮窗状态（对标 Hetu）
  const [selectionCoords, setSelectionCoords] = useState<{ top: number; left: number } | null>(null);
  const [aiSelection, setAiSelection] = useState<string>("");
  const [showInlineAi, setShowInlineAi] = useState(false);
  const [inlineAiCoords, setInlineAiCoords] = useState<{ top: number; left: number } | null>(null);
  const [inlineAiAction, setInlineAiAction] = useState<string>("polish");
  const [inlineCustomPrompt, setInlineCustomPrompt] = useState("");
  const [inlineAiLoading, setInlineAiLoading] = useState(false);
  const [inlineAiResult, setInlineAiResult] = useState("");
  const [showModelPicker, setShowModelPicker] = useState(false);
  // selectedModelKey: "" 表示跟随系统默认模型，否则格式为 "${providerId}/${modelId}"
  const [selectedModelKey, setSelectedModelKey] = useState<string>("");

  // 场景默认模型（⑪）：笔记 AI 选择持久化（此前为组件本地态，切页即失忆）
  useEffect(() => {
    const saved = kvGetJSON<{ providerId: string; modelId: string }>(NOTEAI_MODEL_KV_KEY);
    if (saved?.providerId) setSelectedModelKey(bindingToNoteKey(saved));
  }, []);

  // 真实已配置的服务商列表
  const [providers, setProviders] = useState<ProviderItem[]>([]);

  const milkdownRef = useRef<MilkdownEditorHandle>(null);
  const inlineInputRef = useRef<HTMLTextAreaElement>(null);
  const inlineAbortRef = useRef<AbortController | null>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const saveTimeoutRef = useRef<number | null>(null);
  const currentContentRef = useRef<string>("");
  // 版本来源搭车：行内 AI 应用结果走 onChange→防抖链（无独立保存调用），
  // 在此挂待发 source，防抖到期一并透传给 onSaveContent。
  const pendingSaveSourceRef = useRef<string | undefined>(undefined);

  // 从磁盘读取多服务商真实配置（仅取启用的服务商与启用的模型）
  const refreshProviders = useCallback(async () => {
    try {
      const list = await loadProvidersConfigFromDisk(settings);
      setProviders(list);
    } catch (err) {
      console.warn("[NoteEditor] loadProvidersConfigFromDisk failed:", err);
    }
  }, [settings]);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  // 计算已启用服务商中所有已启用的模型列表
  const enabledModelOptions = useMemo(() => {
    const options: {
      key: string;
      providerId: string;
      providerName: string;
      modelId: string;
      modelName: string;
    }[] = [];

    providers
      .filter((p) => p.enabled)
      .forEach((p) => {
        (p.models || [])
          .filter((m) => m.enabled !== false)
          .forEach((m) => {
            options.push({
              key: `${p.id}/${m.id}`,
              providerId: p.id,
              providerName: p.name || p.id,
              modelId: m.id,
              modelName: m.name || m.id,
            });
          });
      });

    return options;
  }, [providers]);

  // 解析系统默认模型显示名
  const defaultModelDisplayName = useMemo(() => {
    const prov = providers.find((p) => p.id === settings.provider);
    const mod = prov?.models.find((m) => m.id === settings.modelId);
    if (mod) {
      return `${prov?.name || settings.provider}: ${mod.name || mod.id}`;
    }
    if (settings.modelId) {
      return `${settings.provider}: ${settings.modelId}`;
    }
    return "系统默认";
  }, [providers, settings.provider, settings.modelId]);

  // 当前触发按钮展示的模型名（默认模型时直接显示“默认模型”，对齐 Hetu 图一）
  const activeModelButtonLabel = useMemo(() => {
    if (!selectedModelKey) {
      return "默认模型";
    }
    const found = enabledModelOptions.find((o) => o.key === selectedModelKey);
    if (found) {
      return `${found.providerName}: ${found.modelName}`;
    }
    return selectedModelKey;
  }, [selectedModelKey, enabledModelOptions]);

  // 点击外部关闭模型选择器
  useEffect(() => {
    if (!showModelPicker) return;
    const handler = (e: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setShowModelPicker(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showModelPicker]);

  // 加载当前笔记内容
  useEffect(() => {
    if (!note) {
      setTitle("");
      setContent("");
      currentContentRef.current = "";
      setLoaded(false);
      setSaveStatus("saved");
      setSelectionCoords(null);
      setLinkDraft(null);
      setShowInlineAi(false);
      setInlineAiResult("");
      setAiSelection("");
      return;
    }
    setTitle(note.title);
    setLoaded(false);
    setSelectionCoords(null);
    setLinkDraft(null);
    setShowInlineAi(false);
    setInlineAiResult("");
    setAiSelection("");

    import("./notesService").then(({ notesService }) => {
      notesService.readNote(note.notebookRelPath, note.fileName).then((text) => {
        setContent(text);
        currentContentRef.current = text;
        setLoaded(true);
        setSaveStatus("saved");
      });
    });
  }, [note?.id]);

  // 防抖自动保存至磁盘
  const triggerAutoSave = useCallback(
    (newContent: string) => {
      currentContentRef.current = newContent;
      setSaveStatus("unsaved");
      if (saveTimeoutRef.current) {
        window.clearTimeout(saveTimeoutRef.current);
      }
      saveTimeoutRef.current = window.setTimeout(async () => {
        setSaveStatus("saving");
        try {
          await onSaveContent(newContent, pendingSaveSourceRef.current);
          setSaveStatus("saved");
        } catch (err) {
          console.error("Auto save failed:", err);
          setSaveStatus("unsaved");
        } finally {
          pendingSaveSourceRef.current = undefined;
        }
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [onSaveContent]
  );

  // Ctrl+S 手动保存（ROADMAP ④ source=manual）：冲刷防抖立即存盘——「强制留一版再大改」的抓手
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (saveTimeoutRef.current) {
          window.clearTimeout(saveTimeoutRef.current);
          saveTimeoutRef.current = null;
        }
        if (!currentContentRef.current) return;
        setSaveStatus("saving");
        void onSaveContent(currentContentRef.current, "manual")
          .then(() => setSaveStatus("saved"))
          .catch(() => setSaveStatus("unsaved"))
          .finally(() => {
            pendingSaveSourceRef.current = undefined;
          });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onSaveContent]);

  const handleContentChange = useCallback(
    (newContent: string) => {
      setContent(newContent);
      triggerAutoSave(newContent);
    },
    [triggerAutoSave]
  );

  const handleSelectionChange = useCallback(
    (info: SelectionInfo) => {
      if (info.hasSelection && info.coords) {
        setSelectionCoords(info.coords);
        setAiSelection(info.text);
      } else {
        setSelectionCoords(null);
        if (!inlineAiLoading && !inlineAiResult) {
          setShowInlineAi(false);
        }
      }
    },
    [inlineAiLoading, inlineAiResult]
  );

  const handleTitleBlur = async () => {
    const trimmed = title.trim();
    if (!trimmed || !note || trimmed === note.title) return;
    try {
      await onRenameTitle(trimmed);
    } catch (err) {
      console.error("Rename title error:", err);
      setTitle(note.title);
    }
  };

  const runFormat = useCallback((fn: (md: MilkdownEditorHandle) => void) => {
    const md = milkdownRef.current;
    if (md) fn(md);
  }, []);

  const openInlineAi = () => {
    const selInfo = milkdownRef.current?.getSelectionInfo();
    const coords = selInfo?.coords || selectionCoords || { top: 60, left: 32 };
    setInlineAiCoords(coords);
    if (selInfo?.hasSelection) {
      setAiSelection(selInfo.text);
    }
    setShowInlineAi(true);
    setInlineAiResult("");
    setInlineCustomPrompt("");
    setShowModelPicker(false);
    requestAnimationFrame(() => inlineInputRef.current?.focus());
  };

  const closeInlineAi = () => {
    setShowInlineAi(false);
    setInlineAiResult("");
    setInlineCustomPrompt("");
    setInlineAiAction("polish");
    setShowModelPicker(false);
    inlineAbortRef.current?.abort();
  };

  // 解析当前执行的模型配置：若 selectedModelKey 为空，则取全局默认配置；否则取对应服务商与模型
  const resolveCurrentGenerationConfig = useCallback((): ProviderConfig | null => {
    let targetProviderId = settings.provider;
    let targetModelId = settings.modelId;

    if (selectedModelKey) {
      const [pid, mid] = selectedModelKey.split("/");
      if (pid && mid) {
        targetProviderId = pid as any;
        targetModelId = mid;
      }
    }

    const providerItem = providers.find((p) => p.id === targetProviderId);
    if (!providerItem || !providerItem.enabled) {
      // 找不到服务商或已被禁用，若有 settings 则兜底
      if (settings.apiKey && settings.modelId) {
        return {
          provider: settings.provider,
          apiKey: settings.apiKey,
          modelId: settings.modelId,
          baseUrl: settings.baseUrl,
        };
      }
      return null;
    }

    const modelItem = providerItem.models.find((m) => m.id === targetModelId);
    return {
      provider: providerItem.id as any,
      apiKey: providerItem.apiKey || settings.apiKey || "",
      modelId: targetModelId,
      baseUrl: providerItem.baseUrl || settings.baseUrl || "",
      apiFormat: providerItem.apiFormat,
      contextWindow: modelItem?.contextWindow ?? null,
      maxOutputTokens: modelItem?.maxOutputTokens ?? null,
      supportsImage: modelItem?.supportsImage ?? null,
    };
  }, [providers, selectedModelKey, settings]);

  // 执行行内 AI
  const handleExecuteInlineAi = async (instruction: string) => {
    const selInfo = milkdownRef.current?.getSelectionInfo();
    const targetText = selInfo?.hasSelection ? selInfo.text : (aiSelection || milkdownRef.current?.getMarkdown() || content);
    const promptToSend = instruction.trim() || aiActionPreset(inlineAiAction);

    if (!targetText.trim() && !promptToSend) return;

    const providerConfig = resolveCurrentGenerationConfig();
    if (!providerConfig || (!providerConfig.apiKey && providerConfig.provider !== "ollama")) {
      setInlineAiResult("请先在「设置」中配置模型服务商（API Key 与模型），即可直接使用 AI 智能润色与续写。");
      return;
    }

    setInlineAiLoading(true);
    setInlineAiResult("");
    inlineAbortRef.current?.abort();
    const abortController = new AbortController();
    inlineAbortRef.current = abortController;

    try {
      const systemPrompt = "你是一位专业的 Markdown 编辑与写作助手。请直接输出处理后的正文内容，保留 Markdown 格式，不要包含多余的客套寒暄。严格的输出边界：只输出「待处理文本」处理后的结果，背景参考仅供理解语境，严禁把背景内容复述进输出。";
      // 分区 prompt（ROADMAP ④）：有选区时选区=待处理、全文=背景（防整篇回显覆盖）
      const hasSelection = Boolean(selInfo?.hasSelection && selInfo.text.trim());
      const fullMarkdown = milkdownRef.current?.getMarkdown() ?? content;
      const userPrompt = buildInlineAiPrompt({
        instruction: promptToSend,
        selection: hasSelection ? selInfo!.text : "",
        noteTitle: note?.title ?? "",
        fullMarkdown,
        selectionChars: selInfo?.text.length ?? 0,
        fullChars: fullMarkdown.length,
      });

      const generated = await completeOneShotText(
        providerConfig,
        systemPrompt,
        userPrompt,
        "off",
        abortController.signal,
        "note-ai",
      );

      setInlineAiResult(generated.trim());
    } catch (err) {
      if (abortController.signal.aborted) return;
      setInlineAiResult(`[ERROR] AI 生成出错: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setInlineAiLoading(false);
      inlineAbortRef.current = null;
    }
  };

  const handleStopInlineAi = () => {
    inlineAbortRef.current?.abort();
  };

  const handleReplaceSelection = () => {
    if (!inlineAiResult || inlineAiResult.startsWith("[ERROR]")) return;
    const cleaned = sanitizeAiResult(inlineAiResult, { noteTitle: note?.title, selectedText: aiSelection });
    if (!cleaned) return;
    const selection = milkdownRef.current?.getSelectionInfo();
    pendingSaveSourceRef.current = "ai";
    if (!selection?.hasSelection && !aiSelection) {
      milkdownRef.current?.appendContent(cleaned);
    } else {
      milkdownRef.current?.replaceSelection(cleaned);
    }
    closeInlineAi();
  };

  const handleAppendResult = () => {
    if (!inlineAiResult || inlineAiResult.startsWith("[ERROR]")) return;
    const cleaned = sanitizeAiResult(inlineAiResult, { noteTitle: note?.title, selectedText: aiSelection });
    if (!cleaned) return;
    pendingSaveSourceRef.current = "ai";
    milkdownRef.current?.appendContent(cleaned);
    closeInlineAi();
  };

  if (!note) {
    return (
      <div className="flex flex-col items-center justify-center h-full w-full text-[var(--text-dim)]">
        <Edit3 className="w-12 h-12 opacity-20 mb-3" />
        <p className="text-sm font-medium">{t("noNoteSelected")}</p>
      </div>
    );
  }

  // 格式工具条按钮内容（常驻工具条与选区浮动工具条共用）
  const formatToolbarButtons = (
    <div className="flex items-center gap-0.5">
      {/* 1. 基础排版动作组：H2, H3, B, I, S, </>, "", :=, 1=, [x]=, [<>] */}
      {FORMAT_ACTIONS.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.key}
            type="button"
            title={item.title}
            onMouseDown={(e) => {
              e.preventDefault();
              runFormat(item.run);
            }}
            className="p-1.5 rounded-lg hover:bg-[var(--surface-hover)] text-[var(--text-dim)] hover:text-[var(--text)] transition-colors cursor-pointer"
          >
            <Icon className="w-3.5 h-3.5" />
          </button>
        );
      })}

      {/* 2. 竖线分隔符 */}
      <span className="w-px h-3.5 bg-[var(--border)] mx-1" />

      {/* 3. ✨ AI 按钮 */}
      <button
        type="button"
        title="行内 AI"
        onMouseDown={(e) => {
          e.preventDefault();
          openInlineAi();
        }}
        className="flex h-7 items-center gap-1 rounded-lg px-2 text-[12px] font-medium text-indigo-400 hover:text-indigo-300 hover:bg-indigo-500/15 transition-colors cursor-pointer"
      >
        <Sparkles className="w-3.5 h-3.5" />
        <span>AI</span>
      </button>

      {/* 4. 链接 / 表格 / 分割线 / 流程图 */}
      {linkDraft === null ? (
        <>
          <button
            type="button"
            title="插入链接"
            onMouseDown={(e) => {
              e.preventDefault();
              setLinkDraft("");
            }}
            className="p-1.5 rounded-lg hover:bg-[var(--surface-hover)] text-[var(--text-dim)] hover:text-[var(--text)] transition-colors cursor-pointer"
          >
            <Link2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            title="插入表格"
            onMouseDown={(e) => {
              e.preventDefault();
              runFormat((md) => md.insertTable());
            }}
            className="p-1.5 rounded-lg hover:bg-[var(--surface-hover)] text-[var(--text-dim)] hover:text-[var(--text)] transition-colors cursor-pointer"
          >
            <Table2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            title="分割线"
            onMouseDown={(e) => {
              e.preventDefault();
              runFormat((md) => md.insertDivider());
            }}
            className="p-1.5 rounded-lg hover:bg-[var(--surface-hover)] text-[var(--text-dim)] hover:text-[var(--text)] transition-colors cursor-pointer"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            title="插入流程图 (Mermaid)"
            onMouseDown={(e) => {
              e.preventDefault();
              runFormat((md) => md.insertDiagram());
            }}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-[var(--surface-hover)] text-[var(--text-dim)] hover:text-[var(--text)] text-xs transition-colors cursor-pointer"
          >
            <Workflow className="w-3.5 h-3.5" />
            <span>流程图</span>
          </button>
        </>
      ) : (
        <div className="flex items-center gap-1 bg-[var(--bg-elev-2)] px-2 py-0.5 rounded-md border border-[var(--border)]">
          <input
            autoFocus
            type="text"
            value={linkDraft}
            onChange={(e) => setLinkDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && linkDraft.trim()) {
                runFormat((md) => md.insertLink(linkDraft.trim()));
                setLinkDraft(null);
              }
              if (e.key === "Escape") {
                setLinkDraft(null);
              }
            }}
            placeholder="输入链接回车..."
            className="w-36 text-xs bg-transparent border-none outline-hidden text-[var(--text)] placeholder:text-[var(--text-dim)]"
          />
          <button
            type="button"
            onClick={() => setLinkDraft(null)}
            className="text-[10px] text-[var(--text-dim)] hover:text-[var(--text)] ml-1 cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex flex-col h-full w-full bg-[var(--bg)] overflow-hidden">
      {/* 顶部笔记元信息与保存状态栏（固定在全宽顶部，绝对不动） */}
      <div className="flex items-center justify-between px-8 py-3 border-b border-[var(--border)] shrink-0 bg-[var(--bg)]">
        <div className="flex items-center gap-3 text-xs text-[var(--text-dim)]">
          <button
            type="button"
            onClick={() => void notesService.openNotebookFolder(note.notebookRelPath)}
            title="在系统文件管理器中打开"
            className="flex items-center gap-1.5 bg-[var(--bg-elev)] hover:bg-[var(--surface-hover)] px-2.5 py-1 rounded-md border border-[var(--border)] transition-colors cursor-pointer group/folder"
          >
            <Folder className="w-3.5 h-3.5 text-blue-500 group-hover/folder:scale-110 transition-transform" />
            <span className="font-medium text-[var(--text)]">{note.notebookRelPath}</span>
          </button>
          <span className="flex items-center gap-1 text-[11px]">
            <Calendar className="w-3 h-3 opacity-60" />
            {(() => {
              const d = new Date(note.createdAt);
              const yyyy = d.getFullYear();
              const mm = String(d.getMonth() + 1).padStart(2, "0");
              const dd = String(d.getDate()).padStart(2, "0");
              return `${yyyy}/${mm}/${dd}`;
            })()}
          </span>
          <span className="flex items-center gap-1 text-[11px]">
            <Clock className="w-3 h-3 opacity-60" />
            {(() => {
              const d = new Date(note.updatedAt);
              const hh = String(d.getHours()).padStart(2, "0");
              const mm = String(d.getMinutes()).padStart(2, "0");
              const ss = String(d.getSeconds()).padStart(2, "0");
              return `${hh}:${mm}:${ss}`;
            })()}
          </span>
        </div>

        {/* 右侧：自动保存状态指示 + ✨ AI 助手胶囊按钮 */}
        <div className="flex items-center gap-3 text-xs text-[var(--text-dim)]">
          <div className="flex items-center gap-1.5">
            {saveStatus === "saving" && (
              <span className="flex items-center gap-1 text-[var(--accent)]">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-ping" />
                {t("saveStatusSaving")}
              </span>
            )}
            {saveStatus === "unsaved" && (
              <span className="flex items-center gap-1 text-amber-500">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                {t("saveStatusUnsaved")}
              </span>
            )}
            {saveStatus === "saved" && (
              <span className="flex items-center gap-1 text-[var(--status-ok)]">
                <Check className="w-3.5 h-3.5" />
                {t("saveStatusSaved")}
              </span>
            )}
          </div>

          {/* 版本历史入口（ROADMAP ④） */}
          <button
            type="button"
            onClick={() => setIsVersionOpen(true)}
            title={t("notesVersionTitle", "版本历史")}
            className="p-1.5 rounded-lg hover:bg-[var(--surface-hover)] text-[var(--text-dim)] hover:text-[var(--text)] transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>
          </button>

          {/* ✨ AI 助手高亮胶囊按钮（100% 对齐 Hetu 截图） */}
          <button
            type="button"
            onClick={() => setIsAiSidebarOpen((prev) => !prev)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer shadow-xs active:scale-95 ${
              isAiSidebarOpen
                ? "bg-purple-600 text-white shadow-purple-500/20"
                : "bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white"
            }`}
          >
            <Sparkles className="w-3.5 h-3.5 text-white" />
            <span>AI 助手</span>
          </button>
        </div>
      </div>

      {/* 主体区域（含标题、工具栏、编辑画布与右侧 AI 助手侧弹窗，顶栏在上方固定不动） */}
      <div className="relative flex flex-1 min-h-0 w-full overflow-hidden">
        {/* 编辑器主体（100% 全宽保持不动，不随侧弹窗显示而收缩） */}
        <div className="flex flex-col w-full h-full overflow-hidden">
          {/* 笔记标题栏 */}
          <div className="px-8 pt-6 pb-4 border-b border-[var(--border)] shrink-0 bg-[var(--bg)]">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={handleTitleBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            }
          }}
          placeholder={t("untitledNote")}
          className="w-full text-2xl font-bold bg-transparent border-none outline-hidden text-[var(--text)] placeholder:text-[var(--text-dim)] tracking-tight"
        />
      </div>
      {/* 标签编辑条（ROADMAP ④）——AllTags 由 NotesPage 持有经 props 注入 */}
      <NoteTagEditor noteId={note.id} notebookRelPath={note.notebookRelPath} fileName={note.fileName} allTags={allTags ?? {}} onTagsChanged={onTagsChanged} />
      {isVersionOpen && (
        <NoteVersionPanel
          noteId={note.id}
          currentContent={currentContentRef.current}
          onRestore={(restored: string) => {
            void milkdownRef.current?.setMarkdown(restored);
            setContent(restored);
            // 立即保存（source=restore → 版本历史记还原来源；旧当前内容已在快照链中留存）
            void onSaveContent(restored, "restore");
          }}
          onClose={() => setIsVersionOpen(false)}
        />
      )}

      {/* 常驻格式工具条（100% 对齐 Hetu 截图图标与顺序） */}
      <div className="sticky top-0 z-10 flex items-center px-8 py-2 border-b border-[var(--border)] bg-[var(--bg-elev)] shrink-0 overflow-x-auto">
        {formatToolbarButtons}
      </div>

      {/* 所见即所得编辑画布 */}
      <div className="relative flex-1 min-h-0 overflow-y-auto px-8 py-6">
        {loaded && (
          <MilkdownEditor
            key={note.id}
            ref={milkdownRef}
            initialMarkdown={content}
            onChange={handleContentChange}
            onSelectionChange={handleSelectionChange}
            placeholder="开始记录你的思考与笔记..."
          />
        )}

        {/* 选区浮动工具栏（划选文字时在选区上方就地浮现） */}
        {selectionCoords && !showInlineAi && (
          <div
            className="absolute z-30 animate-in fade-in zoom-in-95 duration-150"
            style={{
              top: Math.max(selectionCoords.top - 46, 8),
              left: Math.max(selectionCoords.left, 16),
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <div className="p-1 rounded-xl border border-[var(--border)] bg-[var(--bg-elev-2)] shadow-lg shadow-black/20">
              {formatToolbarButtons}
            </div>
          </div>
        )}

        {/* 100% 对齐 Hetu 截图的行内 AI 浮动弹窗 */}
        {showInlineAi && inlineAiCoords && (
          <div
            className="absolute z-40 w-96 max-w-[calc(100%-2rem)] overflow-hidden rounded-xl border border-indigo-500/30 bg-[#161922] shadow-2xl shadow-black/60 animate-in fade-in zoom-in-95 duration-150"
            style={{
              top: Math.max(inlineAiCoords.top, 8),
              left: Math.min(Math.max(inlineAiCoords.left, 16), 500),
            }}
          >
            {/* 顶栏：Sparkles + 行内 AI + 字数胶囊 + 关闭 X */}
            <div className="flex items-center justify-between border-b border-white/[0.08] px-3 py-2 bg-[#1b1f2b]">
              <div className="flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                <span className="text-xs font-medium text-gray-200">行内 AI</span>
                <span className="rounded bg-indigo-900/40 border border-indigo-500/30 px-1.5 py-0.5 text-[10px] text-indigo-300">
                  {aiSelection.length > 0 ? `${aiSelection.length} 字` : "全文"}
                </span>
              </div>
              <button
                type="button"
                onClick={closeInlineAi}
                className="rounded p-1 text-gray-400 transition-colors hover:bg-white/[0.08] hover:text-gray-200 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* 中间操作区 */}
            <div className="p-3 space-y-2">
              {/* 动作胶囊：润色 · 翻译 · 精简 · 扩展 · 解释 */}
              {!inlineAiResult && (
                <div className="flex flex-wrap gap-1">
                  {AI_PRESET_ACTIONS.map((a) => (
                    <button
                      key={a.key}
                      type="button"
                      onClick={() => {
                        setInlineAiAction(a.key);
                        setInlineCustomPrompt(a.prompt);
                        setInlineAiResult("");
                        requestAnimationFrame(() => inlineInputRef.current?.focus());
                      }}
                      className={`rounded-md border px-2 py-1 text-[11px] transition-colors cursor-pointer ${
                        inlineAiAction === a.key
                          ? "border-indigo-500/50 bg-indigo-500/20 text-indigo-300"
                          : "border-white/[0.08] bg-white/[0.03] text-gray-300 hover:bg-white/[0.08]"
                      }`}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              )}

              {/* 输入框：描述想要的修改，回车执行... */}
              {!inlineAiResult && (
                <textarea
                  ref={inlineInputRef}
                  value={inlineCustomPrompt}
                  onChange={(e) => setInlineCustomPrompt(e.target.value)}
                  onFocus={() => setInlineAiAction("custom")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleExecuteInlineAi(inlineCustomPrompt);
                    }
                    if (e.key === "Escape") {
                      closeInlineAi();
                    }
                  }}
                  placeholder="描述想要的修改，回车执行..."
                  rows={2}
                  className="w-full resize-none rounded-lg border border-white/[0.1] bg-black/30 px-2.5 py-1.5 text-xs text-gray-100 placeholder:text-gray-500 outline-none focus:border-indigo-500 focus:bg-black/50 transition-colors"
                />
              )}

              {/* 生成结果回显区 */}
              {inlineAiResult && (
                <div className="max-h-48 overflow-y-auto rounded-lg border border-white/[0.08] bg-black/40 p-2.5 text-xs whitespace-pre-wrap text-gray-100 leading-relaxed font-sans">
                  {inlineAiResult}
                </div>
              )}
            </div>

            {/* 底栏：左侧模型切换，右侧执行/采纳按钮（100% 对齐 Hetu 原版图一） */}
            <div className="flex items-center justify-between border-t border-white/[0.08] bg-[#141720] px-3 py-2">
              {/* 左侧模型选择器（原版简洁形态） */}
              <div className="relative shrink-0" ref={modelPickerRef}>
                <button
                  type="button"
                  onClick={() => {
                    void refreshProviders();
                    setShowModelPicker((v) => !v);
                  }}
                  className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-gray-400 hover:text-gray-200 hover:bg-white/[0.08] transition-colors cursor-pointer"
                  title="选择模型"
                >
                  <Bot className="w-3 h-3 text-indigo-400 shrink-0" />
                  <span className="max-w-[120px] truncate">{activeModelButtonLabel}</span>
                  <ChevronDown
                    className={`w-2.5 h-2.5 transition-transform opacity-70 ${showModelPicker ? "rotate-180" : ""}`}
                  />
                </button>

                {showModelPicker && (
                  <div className="absolute bottom-full left-0 z-50 mb-1 w-64 max-h-64 overflow-y-auto rounded-xl border border-white/[0.12] bg-[#1a1e2a] py-1.5 shadow-2xl shadow-black/90 text-xs">
                    {/* 默认模型选项（对齐系统默认模型） */}
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedModelKey("");
                        kvSetJSON(NOTEAI_MODEL_KV_KEY, { providerId: "", modelId: "" });
                        setShowModelPicker(false);
                      }}
                      className={`flex w-full items-center justify-between px-3 py-1.5 text-left transition-colors cursor-pointer ${
                        !selectedModelKey
                          ? "bg-indigo-600/30 text-indigo-200 font-medium"
                          : "text-gray-200 hover:bg-white/[0.06]"
                      }`}
                    >
                      <div className="flex flex-col truncate pr-2">
                        <span className="font-medium">默认模型</span>
                        <span className="text-[10px] text-gray-400 truncate">
                          {defaultModelDisplayName}
                        </span>
                      </div>
                      {!selectedModelKey && (
                        <span className="text-xs text-emerald-400 font-bold shrink-0">✓</span>
                      )}
                    </button>

                    <div className="my-1 border-t border-white/[0.08]" />

                    {/* 按已启用的服务商分组展示所有已启用的模型 */}
                    {providers
                      .filter((p) => p.enabled)
                      .map((p) => {
                        const enabledModels = (p.models || []).filter((m) => m.enabled !== false);
                        if (enabledModels.length === 0) return null;

                        return (
                          <div key={p.id} className="py-1">
                            <div className="px-3 py-0.5 text-[10px] font-semibold text-gray-400/80 uppercase tracking-wider">
                              {p.name || p.id}
                            </div>
                            {enabledModels.map((m) => {
                              const key = `${p.id}/${m.id}`;
                              const isSelected = selectedModelKey === key;

                              return (
                                <button
                                  key={m.id}
                                  type="button"
                                  onClick={() => {
                                    setSelectedModelKey(key);
                                    kvSetJSON(NOTEAI_MODEL_KV_KEY, noteKeyToBinding(key) ?? { providerId: "", modelId: "" });
                                    setShowModelPicker(false);
                                  }}
                                  className={`flex w-full items-center justify-between px-3 py-1.5 text-left transition-colors cursor-pointer ${
                                    isSelected
                                      ? "bg-indigo-600/30 text-indigo-200 font-medium"
                                      : "text-gray-200 hover:bg-white/[0.06]"
                                  }`}
                                >
                                  <span className="truncate pr-2">{m.name || m.id}</span>
                                  {isSelected && (
                                    <span className="text-xs text-emerald-400 font-bold shrink-0">✓</span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        );
                      })}

                    {enabledModelOptions.length === 0 && (
                      <div className="px-3 py-2 text-center text-[11px] text-gray-400">
                        暂无启用的模型，请前往设置开启
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* 右侧动作按钮组（100% 对齐原版 Hetu 图一，禁止换行和挤压） */}
              <div className="flex items-center gap-1.5 shrink-0">
                {inlineAiResult && !inlineAiResult.startsWith("[ERROR]") && (
                  <>
                    <button
                      type="button"
                      onClick={handleReplaceSelection}
                      className="whitespace-nowrap shrink-0 rounded-md bg-emerald-600 hover:bg-emerald-700 px-2.5 py-1 text-[11px] font-medium text-white transition-colors cursor-pointer"
                    >
                      接受替换
                    </button>
                    <button
                      type="button"
                      onClick={handleAppendResult}
                      className="whitespace-nowrap shrink-0 rounded-md px-2.5 py-1 text-[11px] font-medium text-indigo-400 hover:text-indigo-300 hover:bg-indigo-950/30 transition-colors cursor-pointer"
                    >
                      追加
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setInlineAiResult("");
                        setInlineCustomPrompt("");
                      }}
                      className="whitespace-nowrap shrink-0 rounded-md px-2 py-1 text-[11px] font-medium text-gray-400 hover:text-gray-300 hover:bg-white/[0.06] transition-colors cursor-pointer"
                    >
                      重写
                    </button>
                  </>
                )}

                {!inlineAiResult && (
                  <button
                    type="button"
                    onClick={() => handleExecuteInlineAi(inlineCustomPrompt)}
                    disabled={inlineAiLoading}
                    className="flex items-center gap-1 whitespace-nowrap shrink-0 rounded-md bg-gradient-to-r from-blue-500 to-indigo-600 px-2.5 py-1 text-[11px] font-medium text-white hover:from-blue-600 hover:to-indigo-700 disabled:opacity-50 transition-all cursor-pointer shadow-sm"
                  >
                    <Send className="w-3 h-3" />
                    <span>{inlineAiLoading ? "生成中..." : "执行"}</span>
                  </button>
                )}

                {inlineAiLoading && (
                  <button
                    type="button"
                    onClick={handleStopInlineAi}
                    className="flex items-center gap-1 whitespace-nowrap shrink-0 rounded-md px-2.5 py-1 text-[11px] font-medium text-red-400 hover:bg-red-950/40 transition-colors cursor-pointer"
                  >
                    <Square className="w-2.5 h-2.5 fill-current" />
                    <span>停止</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      </div>

      {/* 右侧全文 AI 助手侧边栏 */}
      <NoteAiSidebar
        isOpen={isAiSidebarOpen}
        onClose={() => setIsAiSidebarOpen(false)}
        fullMarkdown={milkdownRef.current?.getMarkdown() || content}
        noteTitle={title || note.title}
        onReplaceFull={(newText) => {
          milkdownRef.current?.setMarkdown(newText);
          setContent(newText);
          void onSaveContent(newText, "ai");
        }}
        onAppendContent={(textToAppend) => {
          milkdownRef.current?.appendContent(textToAppend);
          const full = milkdownRef.current?.getMarkdown() || content;
          setContent(full);
          void onSaveContent(full, "ai");
        }}
      />
      </div>
    </div>
  );
}



