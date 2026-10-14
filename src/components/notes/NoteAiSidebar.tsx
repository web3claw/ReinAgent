import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import {
  Sparkles,
  X,
  Send,
  Square,
  Bot,
  ChevronDown,
  Copy,
  Check,
  CornerDownLeft,
} from "lucide-react";
import { useSettings } from "../../lib/settings/useSettings";
import { completeOneShotText } from "../../lib/promptEnhancement/enhance";
import {
  loadProvidersConfigFromDisk,
  type ProviderItem,
} from "../settings/model-provider/types";
import type { ProviderConfig } from "../../lib/providers/modelFactory";

interface NoteAiSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  fullMarkdown: string;
  noteTitle: string;
  onReplaceFull: (newMarkdown: string) => void;
  onAppendContent: (textToAppend: string) => void;
}

const AI_PRESETS = [
  { id: "continue", label: "续写", prompt: "请依据全文主题与上下文，自然合理地续写下一段或后续要点。" },
  { id: "polish", label: "润色", prompt: "请对全文进行专业、流畅的语言润色，提升表达质感与可读性，保留原有 Markdown 格式与核心意思。" },
  { id: "translate", label: "翻译", prompt: "请将全文翻译为地道自然的目标语言（若当前为中文则翻译为英文，若为外语则翻译为中文）。" },
  { id: "summarize", label: "精简", prompt: "请在保留核心观点和主要信息的前提下，对全文进行精炼概括与精简提炼。" },
  { id: "expand", label: "扩展", prompt: "请对全文内容进行深度扩展，补充详细论据、背景分析、示例或操作指南。" },
  { id: "explain", label: "解释", prompt: "请深入浅出地解释全文所涉及的核心概念、逻辑脉络与关键要点。" },
];

export function NoteAiSidebar({
  isOpen,
  onClose,
  fullMarkdown,
  noteTitle,
  onReplaceFull,
  onAppendContent,
}: NoteAiSidebarProps) {
  const { settings } = useSettings();
  const [activePreset, setActivePreset] = useState<string>("continue");
  const [customPrompt, setCustomPrompt] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [aiResult, setAiResult] = useState("");
  const [copied, setCopied] = useState(false);

  // 模型选择态
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [selectedModelKey, setSelectedModelKey] = useState<string>("");
  const [showModelPicker, setShowModelPicker] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  // 加载系统真实服务商配置
  const refreshProviders = useCallback(async () => {
    try {
      const list = await loadProvidersConfigFromDisk(settings);
      setProviders(list);
    } catch (err) {
      console.warn("[NoteAiSidebar] loadProvidersConfigFromDisk failed:", err);
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

  // 解析当前模型配置
  const resolveCurrentConfig = (): ProviderConfig | null => {
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
  };

  const currentDisplayName = useMemo(() => {
    if (!selectedModelKey) {
      return "默认模型";
    }
    const found = enabledModelOptions.find((m) => m.key === selectedModelKey);
    return found ? `${found.providerName}: ${found.modelName}` : selectedModelKey;
  }, [selectedModelKey, enabledModelOptions]);

  // 执行 AI 生成
  const handleExecute = async (instruction?: string) => {
    const promptToSend =
      (instruction ?? customPrompt).trim() ||
      AI_PRESETS.find((p) => p.id === activePreset)?.prompt ||
      "请针对全文进行处理。";

    const config = resolveCurrentConfig();
    if (!config || (!config.apiKey && config.provider !== "ollama")) {
      setAiResult("请先在「设置」中配置模型服务商（API Key 与模型），即可直接使用全文 AI 助手。");
      return;
    }

    setIsLoading(true);
    setAiResult("");
    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      const systemPrompt =
        "你是一位专业强大的 Markdown 写作与内容处理助手。你的任务是根据用户的指令对整篇笔记进行处理。请直接输出处理后的 Markdown 正文，保持格式工整，不要包含多余的客套寒暄。";
      const userPrompt = `${promptToSend}\n\n当前笔记标题：《${noteTitle}》\n当前全文内容如下：\n"""\n${fullMarkdown}\n"""`;

      const generated = await completeOneShotText(
        config,
        systemPrompt,
        userPrompt,
        "off",
        abortController.signal
      );

      setAiResult(generated.trim());
    } catch (err) {
      if (abortController.signal.aborted) return;
      setAiResult(`[ERROR] AI 生成出错: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsLoading(false);
      abortRef.current = null;
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
    setIsLoading(false);
  };

  const handleCopy = () => {
    if (!aiResult) return;
    navigator.clipboard.writeText(aiResult);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (!isOpen) return null;

  return (
    <div className="absolute top-0 right-0 bottom-0 w-84 z-30 border-l border-[var(--border)] bg-[var(--sidebar-bg)] shadow-2xl flex flex-col select-none animate-in slide-in-from-right duration-200">
      {/* 1. 顶栏：✨ AI 助手 + 全文徽标 + 关闭 ✕ */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 text-indigo-400 font-semibold text-xs">
            <Sparkles className="w-4 h-4 text-indigo-400" />
            <span>AI 助手</span>
          </div>
          <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
            全文
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-md text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer"
          title="关闭"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 2. 快捷指令胶囊区 */}
      <div className="px-3 pt-3 pb-2 border-b border-[var(--border)]">
        <div className="flex flex-wrap gap-1.5">
          {AI_PRESETS.map((preset) => {
            const isActive = activePreset === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => {
                  setActivePreset(preset.id);
                  setCustomPrompt(preset.prompt);
                }}
                className={`px-2.5 py-1 text-xs rounded-lg transition-all cursor-pointer font-medium ${
                  isActive
                    ? "bg-indigo-600/30 text-indigo-300 border border-indigo-500/50 shadow-xs"
                    : "bg-[var(--bg-elev-2)] text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)] border border-transparent"
                }`}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 3. 自定义指令输入框 */}
      <div className="p-3 border-b border-[var(--border)]">
        <div className="relative rounded-xl border border-[var(--border)] bg-[#161922] focus-within:border-indigo-500/60 transition-colors p-2.5">
          <textarea
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (!isLoading) {
                  void handleExecute();
                }
              }
            }}
            placeholder="输入自定义指令，回车执行..."
            rows={3}
            className="w-full bg-transparent text-xs text-gray-200 placeholder:text-gray-500 outline-hidden resize-none leading-relaxed"
          />
          <div className="flex items-center justify-between mt-1 pt-1 border-t border-white/5 text-[10px] text-gray-400">
            <span>Shift+Enter 换行</span>
            <span className="flex items-center gap-0.5 text-gray-400">
              <CornerDownLeft className="w-2.5 h-2.5" /> Enter 执行
            </span>
          </div>
        </div>
      </div>

      {/* 4. 中间主视口：生成结果展示与采纳操作 */}
      <div
        ref={resultRef}
        className="flex-1 overflow-y-auto p-3 space-y-3 text-xs"
      >
        {isLoading && (
          <div className="flex flex-col items-center justify-center h-48 space-y-3 text-[var(--text-dim)]">
            <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-xs font-medium animate-pulse">AI 正在深度处理全文...</p>
          </div>
        )}

        {!isLoading && !aiResult && (
          <div className="flex flex-col items-center justify-center h-52 text-center text-[var(--text-dim)] px-4">
            <Bot className="w-10 h-10 opacity-20 mb-2" />
            <p className="text-xs font-medium">针对全文的智能写作助手</p>
            <p className="text-[11px] opacity-70 mt-1 leading-relaxed">
              选择上方胶囊或输入指令，AI 将结合整篇文档进行续写、润色与提炼。
            </p>
          </div>
        )}

        {!isLoading && aiResult && (
          <div className="rounded-xl border border-indigo-500/30 bg-[#161922] p-3 shadow-lg space-y-2.5">
            <div className="flex items-center justify-between pb-2 border-b border-white/10">
              <span className="text-[11px] font-semibold text-indigo-300 flex items-center gap-1">
                <Sparkles className="w-3.5 h-3.5" /> 生成结果
              </span>
              <button
                type="button"
                onClick={handleCopy}
                className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-200 transition-colors cursor-pointer"
                title="复制结果"
              >
                {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                <span>{copied ? "已复制" : "复制"}</span>
              </button>
            </div>

            <div className="max-h-80 overflow-y-auto font-mono text-[11px] text-gray-200 whitespace-pre-wrap leading-relaxed select-text bg-black/20 p-2.5 rounded-lg border border-white/5">
              {aiResult}
            </div>

            {/* 采纳操作按钮组 */}
            {!aiResult.startsWith("[ERROR]") && (
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    onReplaceFull(aiResult);
                    onClose();
                  }}
                  className="flex-1 py-1.5 px-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-medium transition-colors cursor-pointer text-center"
                >
                  替换全文
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onAppendContent(`\n\n${aiResult}`);
                    onClose();
                  }}
                  className="flex-1 py-1.5 px-2 bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-300 border border-indigo-500/40 rounded-lg text-xs font-medium transition-colors cursor-pointer text-center"
                >
                  在文末追加
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 5. 底栏：模型选择 + 执行按钮 */}
      <div className="p-3 border-t border-[var(--border)] flex items-center justify-between gap-2 bg-[var(--sidebar-bg)] relative">
        {/* 左侧模型切换下拉 */}
        <div className="relative flex-1 min-w-0">
          <button
            type="button"
            onClick={() => setShowModelPicker((prev) => !prev)}
            className="flex w-full items-center justify-between gap-1.5 rounded-lg px-2 py-1.5 text-xs text-[var(--text)] bg-[var(--bg-elev-2)] hover:bg-[var(--surface-hover)] border border-[var(--border)] transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-1.5 truncate">
              <Bot className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
              <span className="truncate">{currentDisplayName}</span>
            </div>
            <ChevronDown className="w-3 h-3 text-[var(--text-dim)] shrink-0" />
          </button>

          {/* 模型弹出列表 */}
          {showModelPicker && (
            <div className="absolute bottom-full left-0 mb-1.5 w-64 max-h-56 overflow-y-auto rounded-xl border border-[var(--border)] bg-[#181a20] p-1 shadow-2xl z-50 animate-in fade-in zoom-in-95">
              <button
                type="button"
                onClick={() => {
                  setSelectedModelKey("");
                  setShowModelPicker(false);
                }}
                className={`flex w-full items-center justify-between px-3 py-1.5 text-xs rounded-lg text-left transition-colors cursor-pointer ${
                  !selectedModelKey
                    ? "bg-indigo-600/30 text-indigo-200 font-medium"
                    : "text-gray-200 hover:bg-white/[0.06]"
                }`}
              >
                <span>默认模型</span>
                {!selectedModelKey && <span className="text-emerald-400 font-bold">✓</span>}
              </button>

              {providers
                .filter((p) => p.enabled)
                .map((p) => {
                  const enabledModels = (p.models || []).filter((m) => m.enabled !== false);
                  if (enabledModels.length === 0) return null;

                  return (
                    <div key={p.id} className="py-1 border-t border-white/5">
                      <div className="px-3 py-0.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
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
                              setShowModelPicker(false);
                            }}
                            className={`flex w-full items-center justify-between px-3 py-1.5 text-xs rounded-lg text-left transition-colors cursor-pointer ${
                              isSelected
                                ? "bg-indigo-600/30 text-indigo-200 font-medium"
                                : "text-gray-200 hover:bg-white/[0.06]"
                            }`}
                          >
                            <span className="truncate pr-2">{m.name || m.id}</span>
                            {isSelected && <span className="text-emerald-400 font-bold">✓</span>}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
            </div>
          )}
        </div>

        {/* 右侧执行 / 停止按钮 */}
        {!isLoading ? (
          <button
            type="button"
            onClick={() => void handleExecute()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-xs transition-all cursor-pointer shrink-0"
          >
            <Send className="w-3 h-3" />
            <span>执行</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={handleStop}
            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-red-600/20 text-red-400 hover:bg-red-600/30 border border-red-500/40 transition-colors cursor-pointer shrink-0"
          >
            <Square className="w-3 h-3 fill-current" />
            <span>停止</span>
          </button>
        )}
      </div>
    </div>
  );
}
