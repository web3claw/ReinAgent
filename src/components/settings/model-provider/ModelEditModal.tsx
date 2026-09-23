import React, { useState, useEffect } from "react";
import { X, Sparkles, Image, Hash, Brain } from "lucide-react";
import {
  type ModelItem,
  type EffortLevel,
  ALL_EFFORT_LEVELS,
  formatModelContextWindowLabel,
} from "./types";

interface ModelEditModalProps {
  isOpen: boolean;
  mode: "add" | "edit";
  model?: ModelItem | null;
  isZh: boolean;
  onClose: () => void;
  onSave: (model: ModelItem) => void;
}

const CONTEXT_PRESETS = [
  { label: "32K", value: 32768 },
  { label: "64K", value: 65536 },
  { label: "128K", value: 131072 },
  { label: "200K", value: 200000 },
  { label: "1M", value: 1048576 },
  { label: "2M", value: 2097152 },
];

export function ModelEditModal({
  isOpen,
  mode,
  model,
  isZh,
  onClose,
  onSave,
}: ModelEditModalProps) {
  const [modelId, setModelId] = useState("");
  const [modelName, setModelName] = useState("");
  const [contextWindow, setContextWindow] = useState<number>(0);
  const [maxOutputTokens, setMaxOutputTokens] = useState<number>(0);
  const [supportsImage, setSupportsImage] = useState(false);
  const [enabled, setEnabled] = useState(true);

  // 推理等级 (Effort) 状态
  const [effortSupported, setEffortSupported] = useState(false);
  const [supportedLevels, setSupportedLevels] = useState<EffortLevel[]>([...ALL_EFFORT_LEVELS]);
  const [defaultLevel, setDefaultLevel] = useState<EffortLevel>("default");

  // 当弹窗打开或传入 model 改变时同步表单状态
  useEffect(() => {
    if (!isOpen) return;

    if (mode === "edit" && model) {
      setModelId(model.id);
      setModelName(model.name || model.id);
      setContextWindow(model.contextWindow ?? 0);
      setMaxOutputTokens(model.maxOutputTokens ?? 0);
      setSupportsImage(model.supportsImage ?? false);
      setEnabled(model.enabled ?? true);

      if (model.effort && Array.isArray(model.effort.supportedLevels) && model.effort.supportedLevels.length > 0) {
        setEffortSupported(true);
        setSupportedLevels([...model.effort.supportedLevels]);
        setDefaultLevel(model.effort.defaultLevel || model.effort.supportedLevels[0]);
      } else {
        setEffortSupported(false);
        setSupportedLevels([...ALL_EFFORT_LEVELS]);
        setDefaultLevel("default");
      }
    } else {
      setModelId("");
      setModelName("");
      setContextWindow(0);
      setMaxOutputTokens(0);
      setSupportsImage(false);
      setEnabled(true);
      setEffortSupported(false);
      setSupportedLevels([...ALL_EFFORT_LEVELS]);
      setDefaultLevel("default");
    }
  }, [isOpen, mode, model]);

  const handleModelIdChange = (newId: string) => {
    setModelId(newId);
    if (mode === "add") {
      const trimmed = newId.trim();
      if (!modelName || modelName === modelId) {
        setModelName(trimmed);
      }
    }
  };

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanId = modelId.trim();
    if (!cleanId) return;

    onSave({
      id: cleanId,
      name: modelName.trim() || cleanId,
      enabled,
      isCustom: mode === "add" ? true : model?.isCustom,
      ...(contextWindow > 0 ? { contextWindow: Number(contextWindow) } : {}),
      ...(maxOutputTokens > 0 ? { maxOutputTokens: Number(maxOutputTokens) } : {}),
      supportsImage,
      ...(effortSupported && supportedLevels.length > 0
        ? {
            effort: {
              supportedLevels,
              defaultLevel: defaultLevel || supportedLevels[0],
            },
          }
        : {}),
    });
    onClose();
  };

  const formattedContext = formatModelContextWindowLabel(contextWindow);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
      <div
        className="w-full max-w-lg bg-[var(--bg-elev)] border border-[var(--border)] rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-[var(--surface-hover)] text-[var(--accent)]">
              <Sparkles className="w-4 h-4" />
            </div>
            <h3 className="text-base font-semibold text-[var(--text-primary)]">
              {mode === "add"
                ? isZh
                  ? "添加新模型配置"
                  : "Add Model Configuration"
                : isZh
                  ? "编辑模型元数据"
                  : "Edit Model Metadata"}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] rounded-lg transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Model ID */}
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
              {isZh ? "模型 ID (必填)" : "Model ID (Required)"}
            </label>
            <input
              type="text"
              required
              disabled={mode === "edit" && !model?.isCustom}
              value={modelId}
              onChange={(e) => handleModelIdChange(e.target.value)}
              placeholder="e.g. gpt-4o, claude-3-5-sonnet, deepseek-chat"
              className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[var(--border)] bg-[var(--bg)] text-[var(--text-primary)] placeholder-[var(--text-secondary)]/50 focus:border-[var(--accent)] focus:outline-none transition-colors disabled:opacity-60"
            />
            {mode === "edit" && !model?.isCustom && (
              <p className="text-[11px] text-[var(--text-secondary)]">
                {isZh ? "预设模型 ID 不可修改" : "Preset Model ID is read-only"}
              </p>
            )}
          </div>

          {/* Model Name */}
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
              {isZh ? "显示名称 (Display Name)" : "Display Name"}
            </label>
            <input
              type="text"
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              placeholder={modelId || "e.g. GPT-4o Mini"}
              className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--border)] bg-[var(--bg)] text-[var(--text-primary)] placeholder-[var(--text-secondary)]/50 focus:border-[var(--accent)] focus:outline-none transition-colors"
            />
          </div>

          {/* Context Window */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
                <Hash className="w-3.5 h-3.5" />
                <span>{isZh ? "上下文窗口 (Context Window Tokens)" : "Context Window (Tokens)"}</span>
              </label>
              {formattedContext && (
                <span className="px-2 py-0.5 text-xs font-mono font-medium rounded-md border border-[var(--border)] bg-[var(--surface-hover)] text-[var(--text-primary)]">
                  {formattedContext}
                </span>
              )}
            </div>
            <input
              type="number"
              min={1024}
              step={1024}
              value={contextWindow > 0 ? contextWindow : ""}
              placeholder={isZh ? "留空表示未指定 (可通过下方预设填写)" : "Unspecified (click presets below)"}
              onChange={(e) => setContextWindow(parseInt(e.target.value, 10) || 0)}
              className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[var(--border)] bg-[var(--bg)] text-[var(--text-primary)] placeholder-[var(--text-secondary)]/50 focus:border-[var(--accent)] focus:outline-none transition-colors"
            />
            {/* Quick Presets */}
            <div className="flex flex-wrap gap-1.5 pt-1">
              {CONTEXT_PRESETS.map((p) => {
                const isActive = contextWindow === p.value;
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => setContextWindow(p.value)}
                    className={`px-2.5 py-1 text-xs font-mono rounded-md border transition-all ${
                      isActive
                        ? "border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent)] font-semibold"
                        : "border-[var(--border)] bg-[var(--surface-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Max Output Tokens */}
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
              {isZh ? "最大输出 (Max Output Tokens)" : "Max Output Tokens"}
            </label>
            <input
              type="number"
              min={256}
              step={256}
              value={maxOutputTokens > 0 ? maxOutputTokens : ""}
              placeholder={isZh ? "留空表示未指定 (例如 8192)" : "Unspecified (e.g. 8192)"}
              onChange={(e) => setMaxOutputTokens(parseInt(e.target.value, 10) || 0)}
              className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[var(--border)] bg-[var(--bg)] text-[var(--text-primary)] placeholder-[var(--text-secondary)]/50 focus:border-[var(--accent)] focus:outline-none transition-colors"
            />
          </div>

          {/* Toggles: Vision & Enabled */}
          <div className="pt-2 border-t border-[var(--border)] space-y-3">
            {/* Vision Support */}
            <div className="flex items-center justify-between p-3 rounded-xl bg-[var(--surface-hover)]/40 border border-[var(--border)]">
              <div className="flex items-center gap-2.5">
                <div className="p-1.5 rounded-lg bg-[var(--surface-hover)] text-[var(--text-secondary)]">
                  <Image className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-xs font-medium text-[var(--text-primary)]">
                    {isZh ? "支持图像 / 视觉输入" : "Supports Image / Vision"}
                  </div>
                  <div className="text-[11px] text-[var(--text-secondary)]">
                    {isZh
                      ? "开启后该模型支持多模态图片、图表分析"
                      : "Allows multimodal image & chart inputs"}
                  </div>
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={supportsImage}
                onClick={() => setSupportsImage(!supportsImage)}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-colors focus:outline-none ${
                  supportsImage ? "bg-[var(--text-primary)]" : "bg-[var(--border)]"
                }`}
              >
                <span
                  className={`pointer-events-none block h-4 w-4 rounded-full transition-transform ${
                    supportsImage
                      ? "translate-x-4 bg-[var(--bg)]"
                      : "translate-x-0 bg-[var(--text-secondary)]"
                  }`}
                />
              </button>
            </div>

            {/* Reasoning Effort Configuration */}
            <div className="p-3 rounded-xl bg-[var(--surface-hover)]/40 border border-[var(--border)] space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="p-1.5 rounded-lg bg-[var(--surface-hover)] text-[var(--text-secondary)]">
                    <Brain className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="text-xs font-medium text-[var(--text-primary)]">
                      {isZh ? "推理等级 (Reasoning Effort)" : "Reasoning Effort"}
                    </div>
                    <div className="text-[11px] text-[var(--text-secondary)]">
                      {effortSupported
                        ? isZh
                          ? `支持档位: ${supportedLevels.join(", ")}`
                          : `Supported: ${supportedLevels.join(", ")}`
                        : isZh
                          ? "上游接口未声明支持推理等级 (未返回 effort)"
                          : "Not advertised by upstream API"}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={effortSupported}
                  onClick={() => {
                    const next = !effortSupported;
                    setEffortSupported(next);
                    if (next && supportedLevels.length === 0) {
                      setSupportedLevels([...ALL_EFFORT_LEVELS]);
                      setDefaultLevel("default");
                    }
                  }}
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-colors focus:outline-none ${
                    effortSupported ? "bg-[var(--text-primary)]" : "bg-[var(--border)]"
                  }`}
                >
                  <span
                    className={`pointer-events-none block h-4 w-4 rounded-full transition-transform ${
                      effortSupported
                        ? "translate-x-4 bg-[var(--bg)]"
                        : "translate-x-0 bg-[var(--text-secondary)]"
                    }`}
                  />
                </button>
              </div>

              {/* 当开启推理等级时，一排按钮设置默认等级，点击高亮 */}
              {effortSupported && (
                <div className="pt-2 border-t border-[var(--border)] space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                      {isZh ? "默认推理等级 (点击按钮切换默认)" : "Default Effort Level (Click to set default)"}
                    </span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--surface-active)] text-[var(--text-dim)] border border-[var(--border)]">
                      当前默认: {defaultLevel}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(supportedLevels.length > 0 ? supportedLevels : ALL_EFFORT_LEVELS).map((lvl) => {
                      const isSelected = defaultLevel === lvl;
                      return (
                        <button
                          key={lvl}
                          type="button"
                          onClick={() => setDefaultLevel(lvl)}
                          className={`px-3 py-1.5 text-xs font-mono font-medium rounded-lg border transition-all cursor-pointer capitalize ${
                            isSelected
                              ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)] shadow-sm font-semibold scale-102"
                              : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-hover)]"
                          }`}
                        >
                          {lvl}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Model Enabled */}
            <div className="flex items-center justify-between p-3 rounded-xl bg-[var(--surface-hover)]/40 border border-[var(--border)]">
              <div>
                <div className="text-xs font-medium text-[var(--text-primary)]">
                  {isZh ? "启用此模型" : "Enable Model"}
                </div>
                <div className="text-[11px] text-[var(--text-secondary)]">
                  {isZh ? "禁用后该模型将不在会话切换列表中出现" : "Disabled models won't appear in chat selector"}
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                onClick={() => setEnabled(!enabled)}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-colors focus:outline-none ${
                  enabled ? "bg-[var(--text-primary)]" : "bg-[var(--border)]"
                }`}
              >
                <span
                  className={`pointer-events-none block h-4 w-4 rounded-full transition-transform ${
                    enabled
                      ? "translate-x-4 bg-[var(--bg)]"
                      : "translate-x-0 bg-[var(--text-secondary)]"
                  }`}
                />
              </button>
            </div>
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-3 pt-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors"
            >
              {isZh ? "取消" : "Cancel"}
            </button>
            <button
              type="submit"
              disabled={!modelId.trim()}
              className="px-4 py-2 text-xs font-medium rounded-lg bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50 transition-all shadow-sm"
            >
              {mode === "add" ? (isZh ? "添加模型" : "Add Model") : isZh ? "保存修改" : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
