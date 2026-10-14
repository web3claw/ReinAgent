import { useState, useRef, useEffect, useMemo, createContext, useContext } from "react";
import {
  FileText,
  ChevronDown,
  Loader2,
  Check,
  X,
  ExternalLink,
} from "lucide-react";
import { notesService, type NotebookFolder, type NoteFileItem } from "../notes/notesService";
import { useSettings } from "../../lib/settings/useSettings";
import { completeOneShotText } from "../../lib/promptEnhancement/enhance";
import {
  loadProvidersConfigFromDisk,
  type ProviderItem,
} from "../settings/model-provider/types";
import type { ProviderConfig } from "../../lib/providers/modelFactory";

export type OrganizeStyle = "summary" | "detailed" | "qna";

export const STYLE_OPTIONS: { id: OrganizeStyle; label: string; desc: string }[] = [
  { id: "summary", label: "摘要式", desc: "提炼要点，精简到 500 字以内" },
  { id: "detailed", label: "详细式", desc: "保留完整信息，分章节组织，结构清晰" },
  { id: "qna", label: "Q&A 式", desc: "将对话改写为问答形式" },
];

export interface ChatMessageLike {
  role?: string;
  content?: any;
  [key: string]: any;
}

export interface OrganizeNoteState {
  isOpen: boolean;
  setIsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  organizeStyle: OrganizeStyle;
  setOrganizeStyle: (style: OrganizeStyle) => void;
  targetNotebook: string;
  setTargetNotebook: (notebook: string) => void;
  isOrganizing: boolean;
  organizeResult: { note: NoteFileItem; title: string } | null;
  setOrganizeResult: (res: { note: NoteFileItem; title: string } | null) => void;
  notebookTree: NotebookFolder[];
  targetNotebookDisplayName: string;
  hasMessages: boolean;
  handleStartOrganize: () => Promise<void>;
  onOpenNote?: (note: NoteFileItem) => void;
}

const OrganizeNoteContext = createContext<OrganizeNoteState | null>(null);

export function useOrganizeNoteContext() {
  const ctx = useContext(OrganizeNoteContext);
  if (!ctx) throw new Error("useOrganizeNoteContext must be used within OrganizeNoteProvider");
  return ctx;
}

interface OrganizeNoteProviderProps {
  children: React.ReactNode;
  messages: ChatMessageLike[];
  taskTitle: string;
  activeTaskId: string | null;
  taskProviderId?: string;
  taskModelId?: string;
  onOpenNote?: (note: NoteFileItem) => void;
}

function extractMessageText(m: any): string {
  if (!m) return "";
  if (typeof m.text === "string" && m.text.trim()) return m.text;
  if (typeof m.content === "string" && m.content.trim()) return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((part: any) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return "";
}

export function OrganizeNoteProvider({
  children,
  messages,
  taskTitle,
  activeTaskId,
  taskProviderId,
  taskModelId,
  onOpenNote,
}: OrganizeNoteProviderProps) {
  const { settings } = useSettings();
  const [isOpen, setIsOpen] = useState(false);
  const [organizeStyle, setOrganizeStyle] = useState<OrganizeStyle>("summary");
  const [targetNotebook, setTargetNotebook] = useState<string>("default");
  const [isOrganizing, setIsOrganizing] = useState(false);
  const [organizeResult, setOrganizeResult] = useState<{
    note: NoteFileItem;
    title: string;
  } | null>(null);

  const [notebookTree, setNotebookTree] = useState<NotebookFolder[]>([]);
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  // 加载笔记本目录
  useEffect(() => {
    let unmounted = false;
    void notesService.listNotebooks().then((tree) => {
      if (!unmounted) setNotebookTree(tree);
    });
    return () => {
      unmounted = true;
    };
  }, [isOpen]);

  // 加载模型服务商配置
  useEffect(() => {
    let unmounted = false;
    loadProvidersConfigFromDisk(settings)
      .then((items) => {
        if (!unmounted) setProviders(items);
      })
      .catch(() => {});
    return () => {
      unmounted = true;
    };
  }, [settings]);

  // 任务切换时清理状态
  useEffect(() => {
    setIsOpen(false);
    setOrganizeResult(null);
  }, [activeTaskId]);

  const targetNotebookDisplayName = useMemo(() => {
    if (!targetNotebook || targetNotebook === "default") return "默认笔记本";
    function findName(nodes: NotebookFolder[]): string | null {
      for (const n of nodes) {
        if (n.relativePath === targetNotebook) return n.name;
        if (n.children?.length) {
          const sub = findName(n.children);
          if (sub) return sub;
        }
      }
      return null;
    }
    return findName(notebookTree) || targetNotebook;
  }, [targetNotebook, notebookTree]);

  const resolveCurrentConfig = (): ProviderConfig | null => {
    const provId = taskProviderId || settings.provider;
    const modId = taskModelId || settings.modelId;

    const providerItem = providers.find((p) => p.id === provId);
    if (!providerItem) {
      if (settings.provider && (settings.apiKey || settings.provider === "ollama")) {
        return {
          provider: settings.provider,
          apiKey: settings.apiKey,
          modelId: settings.modelId,
          baseUrl: settings.baseUrl,
        };
      }
      return null;
    }

    const modelItem = providerItem.models.find((m) => m.id === modId);
    return {
      provider: providerItem.id as any,
      apiKey: providerItem.apiKey || settings.apiKey || "",
      modelId: modId || providerItem.models[0]?.id || "",
      baseUrl: providerItem.baseUrl || settings.baseUrl || "",
      apiFormat: providerItem.apiFormat,
      contextWindow: modelItem?.contextWindow ?? null,
      maxOutputTokens: modelItem?.maxOutputTokens ?? null,
      supportsImage: modelItem?.supportsImage ?? null,
    };
  };

  const hasMessages = messages.some((m) => {
    const text = extractMessageText(m);
    return Boolean(text.trim());
  });

  const handleStartOrganize = async () => {
    if (isOrganizing) return;
    const validPairs = messages
      .map((m) => ({
        role: m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : "消息",
        text: extractMessageText(m).trim(),
      }))
      .filter((m) => Boolean(m.text));

    if (validPairs.length === 0) {
      alert("当前任务对话暂无消息，无法进行整理。");
      return;
    }

    const config = resolveCurrentConfig();
    if (!config || (!config.apiKey && config.provider !== "ollama")) {
      alert("请先在「设置」中配置模型服务商 API Key 后再使用整理笔记功能。");
      return;
    }

    setIsOrganizing(true);
    setIsOpen(false);
    setOrganizeResult(null);

    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      const styleInstruction =
        organizeStyle === "detailed"
          ? "请整理为详细式笔记：保留完整信息，分章节组织，结构清晰。"
          : organizeStyle === "qna"
          ? "请整理为 Q&A 问答式笔记：将对话改写为问答形式。"
          : "请整理为摘要式笔记：提炼要点，精简到 500 字以内。";

      const conversationText = validPairs
        .map((m) => `## ${m.role}\n\n${m.text}`)
        .join("\n\n");

      const systemPrompt =
        "你是知识整理助手，擅长将对话内容整理为结构清晰、要点突出的 Markdown 笔记。";
      const userPrompt = `${styleInstruction}\n\n请直接输出 Markdown 格式的笔记内容，第一行使用 # 标题。\n\n对话内容：\n\n${conversationText}`;

      const generated = await completeOneShotText(
        config,
        systemPrompt,
        userPrompt,
        "off",
        abortController.signal
      );

      const trimmedResult = generated.trim();
      const firstLine =
        trimmedResult
          .split("\n")
          .find((l) => l.trim().length > 0)
          ?.trim() || "";
      const parsedTitle = firstLine.startsWith("#")
        ? firstLine.replace(/^#+\s*/, "").trim()
        : `${taskTitle || "对话"} 整理笔记`;

      const safeTitle = parsedTitle.slice(0, 50).replace(/[\\/:*?"<>|]/g, "_");

      const destNotebook = targetNotebook || "default";
      const newNoteItem = await notesService.createNote(destNotebook, safeTitle);
      await notesService.saveNote(
        newNoteItem.notebookRelPath,
        newNoteItem.fileName,
        trimmedResult
      );

      setOrganizeResult({
        note: newNoteItem,
        title: safeTitle,
      });
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      console.error("Organize notes error:", err);
      alert(`整理失败: ${(err as Error)?.message || String(err)}`);
    } finally {
      setIsOrganizing(false);
    }
  };

  return (
    <OrganizeNoteContext.Provider
      value={{
        isOpen,
        setIsOpen,
        organizeStyle,
        setOrganizeStyle,
        targetNotebook,
        setTargetNotebook,
        isOrganizing,
        organizeResult,
        setOrganizeResult,
        notebookTree,
        targetNotebookDisplayName,
        hasMessages,
        handleStartOrganize,
        onOpenNote,
      }}
    >
      {children}
    </OrganizeNoteContext.Provider>
  );
}

/** 顶栏右侧按钮组件 */
export function OrganizeNoteButton() {
  const { isOpen, setIsOpen, isOrganizing } = useOrganizeNoteContext();

  return (
    <button
      type="button"
      onClick={() => setIsOpen((prev) => !prev)}
      disabled={isOrganizing}
      title="将对话整理为 Markdown 笔记"
      className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg transition-all cursor-pointer ${
        isOrganizing
          ? "bg-emerald-500/20 text-emerald-400 cursor-wait"
          : isOpen
          ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
          : "text-emerald-500 hover:text-emerald-400 hover:bg-emerald-500/10"
      }`}
    >
      <FileText className="w-3.5 h-3.5" />
      <span>{isOrganizing ? "整理中..." : "整理笔记"}</span>
      <ChevronDown
        className={`w-3 h-3 transition-transform duration-200 ${
          isOpen ? "rotate-180" : ""
        }`}
      />
    </button>
  );
}

/** 顶栏下方抽屉与状态条组件 */
export function OrganizeNoteDrawer() {
  const {
    isOpen,
    setIsOpen,
    organizeStyle,
    setOrganizeStyle,
    targetNotebook,
    setTargetNotebook,
    isOrganizing,
    organizeResult,
    setOrganizeResult,
    notebookTree,
    targetNotebookDisplayName,
    handleStartOrganize,
    onOpenNote,
  } = useOrganizeNoteContext();

  const [showStyleMenu, setShowStyleMenu] = useState(false);
  const [showNotebookMenu, setShowNotebookMenu] = useState(false);
  const styleMenuRef = useRef<HTMLDivElement>(null);
  const notebookMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        styleMenuRef.current &&
        !styleMenuRef.current.contains(e.target as Node)
      ) {
        setShowStyleMenu(false);
      }
      if (
        notebookMenuRef.current &&
        !notebookMenuRef.current.contains(e.target as Node)
      ) {
        setShowNotebookMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const renderTreeOptions = (
    nodes: NotebookFolder[],
    depth = 0
  ): React.ReactNode[] => {
    const list: React.ReactNode[] = [];
    for (const node of nodes) {
      const isSelected = targetNotebook === node.relativePath;
      list.push(
        <button
          key={node.relativePath}
          type="button"
          onClick={() => {
            setTargetNotebook(node.relativePath);
            setShowNotebookMenu(false);
          }}
          className={`w-full text-left px-3 py-1.5 text-xs transition-colors cursor-pointer flex items-center justify-between ${
            isSelected
              ? "bg-emerald-500/15 text-emerald-400 font-medium"
              : "text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)]"
          }`}
          style={{ paddingLeft: `${12 + depth * 16}px` }}
        >
          <span className="truncate">
            {depth > 0 && <span className="opacity-40 mr-1.5">└</span>}
            {node.name}
          </span>
          {isSelected && <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0 ml-2" />}
        </button>
      );
      if (node.children && node.children.length > 0) {
        list.push(...renderTreeOptions(node.children, depth + 1));
      }
    }
    return list;
  };

  return (
    <>
      {/* 整理中状态条 */}
      {isOrganizing && (
        <div className="flex items-center gap-2 border-b border-emerald-500/20 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-400 shrink-0 select-none animate-in fade-in">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-500" />
          <span>正在将当前对话整理为笔记...</span>
        </div>
      )}

      {/* 整理完成通知条 */}
      {organizeResult && !isOrganizing && (
        <div className="flex items-center justify-between border-b border-emerald-500/20 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-400 shrink-0 select-none animate-in fade-in">
          <div className="flex items-center gap-2 min-w-0">
            <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
            <span className="truncate">
              已保存笔记：《{organizeResult.title}》
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-3">
            {onOpenNote && (
              <button
                type="button"
                onClick={() => onOpenNote(organizeResult.note)}
                className="flex items-center gap-1 px-2.5 py-0.5 rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 transition-colors cursor-pointer font-medium"
              >
                <span>查看笔记</span>
                <ExternalLink className="w-3 h-3" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setOrganizeResult(null)}
              className="p-1 rounded text-emerald-400/70 hover:text-emerald-300 hover:bg-emerald-500/20 transition-colors cursor-pointer"
              title="关闭提示"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}

      {/* 选项展开抽屉（100% 对齐截图） */}
      {isOpen && (
        <div className="border-b border-[var(--border)] bg-[var(--bg-elev)] px-4 py-3 shrink-0 animate-in slide-in-from-top-2 duration-150 select-none">
          <div className="flex items-end gap-3 max-w-4xl">
            {/* 整理风格 */}
            <div ref={styleMenuRef} className="w-36 shrink-0 relative">
              <span className="mb-1 block text-[11px] text-[var(--text-dim)] font-medium">
                整理风格
              </span>
              <button
                type="button"
                onClick={() => setShowStyleMenu((prev) => !prev)}
                className="w-full flex items-center justify-between px-3 py-1.5 text-xs rounded-lg border border-[var(--border)] bg-[var(--bg)] text-[var(--text)] hover:border-emerald-500/50 transition-colors cursor-pointer"
              >
                <span>
                  {STYLE_OPTIONS.find((s) => s.id === organizeStyle)?.label}
                </span>
                <ChevronDown
                  className={`w-3 h-3 text-[var(--text-dim)] transition-transform ${
                    showStyleMenu ? "rotate-180" : ""
                  }`}
                />
              </button>

              {showStyleMenu && (
                <div className="absolute top-full left-0 mt-1 w-full bg-[var(--bg-elev-2)] border border-[var(--border)] rounded-lg shadow-xl py-1 z-50 animate-in fade-in zoom-in-95 duration-100">
                  {STYLE_OPTIONS.map((opt) => {
                    const isSelected = organizeStyle === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => {
                          setOrganizeStyle(opt.id);
                          setShowStyleMenu(false);
                        }}
                        className={`w-full text-left px-3 py-1.5 text-xs transition-colors cursor-pointer flex items-center justify-between ${
                          isSelected
                            ? "bg-emerald-500/15 text-emerald-400 font-medium"
                            : "text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)]"
                        }`}
                      >
                        <span>{opt.label}</span>
                        {isSelected && (
                          <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 目标笔记本 */}
            <div ref={notebookMenuRef} className="flex-1 relative min-w-[200px]">
              <span className="mb-1 block text-[11px] text-[var(--text-dim)] font-medium">
                目标笔记本
              </span>
              <button
                type="button"
                onClick={() => setShowNotebookMenu((prev) => !prev)}
                className="w-full flex items-center justify-between px-3 py-1.5 text-xs rounded-lg border border-[var(--border)] bg-[var(--bg)] text-[var(--text)] hover:border-emerald-500/50 transition-colors cursor-pointer"
              >
                <span className="truncate">{targetNotebookDisplayName}</span>
                <ChevronDown
                  className={`w-3 h-3 text-[var(--text-dim)] shrink-0 ml-2 transition-transform ${
                    showNotebookMenu ? "rotate-180" : ""
                  }`}
                />
              </button>

              {showNotebookMenu && (
                <div className="absolute top-full left-0 mt-1 w-full max-h-56 overflow-y-auto bg-[var(--bg-elev-2)] border border-[var(--border)] rounded-lg shadow-xl py-1 z-50 animate-in fade-in zoom-in-95 duration-100">
                  <button
                    type="button"
                    onClick={() => {
                      setTargetNotebook("default");
                      setShowNotebookMenu(false);
                    }}
                    className={`w-full text-left px-3 py-1.5 text-xs transition-colors cursor-pointer flex items-center justify-between ${
                      targetNotebook === "default"
                        ? "bg-emerald-500/15 text-emerald-400 font-medium"
                        : "text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)]"
                    }`}
                  >
                    <span>默认笔记本</span>
                    {targetNotebook === "default" && (
                      <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    )}
                  </button>
                  {renderTreeOptions(notebookTree, 1)}
                </div>
              )}
            </div>

            {/* 开始整理按钮 */}
            <button
              type="button"
              onClick={handleStartOrganize}
              disabled={isOrganizing}
              className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 transition-colors cursor-pointer shadow-xs whitespace-nowrap"
            >
              开始整理
            </button>

            {/* 取消按钮 */}
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="px-3 py-1.5 text-xs text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)] rounded-lg transition-colors cursor-pointer whitespace-nowrap"
            >
              取消
            </button>
          </div>
        </div>
      )}
    </>
  );
}
