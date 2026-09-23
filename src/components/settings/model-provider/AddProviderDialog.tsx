import { useState } from "react";
import { X, Server, ChevronDown } from "lucide-react";
import { type ProviderItem, type ApiFormatType, API_FORMAT_OPTIONS } from "./types";
import { cleanBaseUrl } from "../../../lib/providers/modelFactory";
import { useTranslation } from "../../../i18n";

interface AddProviderDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (provider: ProviderItem) => void;
}

export function AddProviderDialog({ isOpen, onClose, onAdd }: AddProviderDialogProps) {
  const { locale } = useTranslation();
  const isZh = locale === "zh-CN";

  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://localhost:8000");
  const [apiKey, setApiKey] = useState("");
  const [apiFormat, setApiFormat] = useState<ApiFormatType>("openai-chat-completions");
  const [initialModel, setInitialModel] = useState("default-model");

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    const cleanedBaseUrl = cleanBaseUrl(baseUrl);
    const trimmedModel = initialModel.trim() || "default-model";

    if (!trimmedName || !cleanedBaseUrl) {
      alert(isZh ? "请填写服务商名称和端点" : "Name and Base URL are required");
      return;
    }

    const id = `custom-${Date.now()}`;
    const newProvider: ProviderItem = {
      id,
      name: trimmedName,
      apiFormat,
      baseUrl: cleanedBaseUrl,
      apiKey: apiKey.trim(),
      enabled: true,
      isCustom: true,
      defaultModelId: trimmedModel,
      models: [
        {
          id: trimmedModel,
          name: trimmedModel,
          enabled: true,
          isCustom: true,
        },
      ],
    };

    onAdd(newProvider);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-md bg-[var(--bg-elev)] border border-[var(--border)] rounded-2xl shadow-xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]">
          <div className="flex items-center gap-2">
            <Server className="w-5 h-5 text-[var(--accent)]" />
            <h3 className="text-base font-semibold text-[var(--text-primary)]">
              {isZh ? "添加自定义服务商" : "Add Custom Provider"}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">
              {isZh ? "服务商名称 *" : "Provider Name *"}
            </label>
            <input
              type="text"
              required
              placeholder="e.g. OneAPI / vLLM / Moonshot"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">
              {isZh ? "API 端点 (Base URL) *" : "Base URL *"}
            </label>
            <input
              type="text"
              required
              placeholder="https://api.example.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)] font-mono outline-none focus:border-[var(--accent)]"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">
              {isZh ? "API 格式" : "API Format"}
            </label>
            <div className="relative">
              <select
                value={apiFormat}
                onChange={(e) => setApiFormat(e.target.value as ApiFormatType)}
                className="w-full appearance-none px-3 py-2 pr-9 text-sm rounded-lg border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] cursor-pointer"
              >
                {API_FORMAT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value} className="bg-[var(--bg-card)] text-[var(--text-primary)]">
                    {opt.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-secondary)] opacity-70" />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">
              {isZh ? "API 密钥 (选填)" : "API Key (Optional)"}
            </label>
            <input
              type="password"
              placeholder="sk-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)] font-mono outline-none focus:border-[var(--accent)]"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">
              {isZh ? "初始模型 ID *" : "Initial Model ID *"}
            </label>
            <input
              type="text"
              required
              placeholder="e.g. gpt-4o or qwen"
              value={initialModel}
              onChange={(e) => setInitialModel(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)] font-mono outline-none focus:border-[var(--accent)]"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--border)]">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium rounded-lg border border-[var(--border)] hover:bg-[var(--surface-hover)] text-[var(--text-secondary)]"
            >
              {isZh ? "取消" : "Cancel"}
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-medium rounded-lg bg-[var(--accent)] text-white hover:opacity-95"
            >
              {isZh ? "确认创建" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
