import { useState } from "react";
import {
  ExternalLink,
  Eye,
  EyeOff,
  Plus,
  Trash2,
  CheckCircle2,
  XCircle,
  Loader2,
  Edit2,
  Check,
  X,
  Star,
  ChevronDown,
  RefreshCw,
  Search,
  Unplug,
  Pencil,
} from "lucide-react";
import { ProviderLogo } from "./ProviderLogo";
import { useAppStore } from "../../../store/useAppStore";
import { cleanBaseUrl } from "../../../lib/providers/modelFactory";
import {
  API_FORMAT_OPTIONS,
  type ProviderItem,
  type ModelItem,
  type ApiFormatType,
  formatModelContextWindowLabel,
} from "./types";
import { testModelConnectivity, type ConnectivityResult } from "./testConnectivity";
import { fetchProviderModels } from "./fetchModels";
import { ModelEditModal } from "./ModelEditModal";
import { useTranslation } from "../../../i18n";

interface ProviderDetailCardProps {
  provider: ProviderItem;
  isActiveDefault: boolean;
  activeDefaultModelId?: string;
  onUpdateProvider: (updated: ProviderItem) => void;
  onDeleteProvider?: (id: string) => void;
  onSetAsDefault: (providerId: string, modelId: string) => void;
}

export function ProviderDetailCard({
  provider,
  isActiveDefault,
  activeDefaultModelId,
  onUpdateProvider,
  onDeleteProvider,
  onSetAsDefault,
}: ProviderDetailCardProps) {
  const { locale } = useTranslation();
  const isZh = locale === "zh-CN";

  const [showApiKey, setShowApiKey] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [draftName, setDraftName] = useState(provider.name);

  // 连通性测试状态 map: modelId -> ConnectivityResult
  const [testResults, setTestResults] = useState<Record<string, ConnectivityResult>>({});
  const [testingModelId, setTestingModelId] = useState<string | null>(null);

  // 模型添加与编辑弹窗状态
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editModalMode, setEditModalMode] = useState<"add" | "edit">("add");
  const [targetEditModel, setTargetEditModel] = useState<ModelItem | null>(null);

  // 刷新与搜索模型状态
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshSuccessMsg, setRefreshSuccessMsg] = useState<string | null>(null);
  const [modelSearch, setModelSearch] = useState("");

  // API 格式切换后的端点探测结果（真实请求验证所选格式端点是否存在）
  const [formatProbe, setFormatProbe] = useState<{ ok: boolean; message: string } | null>(null);
  const [isProbingFormat, setIsProbingFormat] = useState(false);

  /**
   * 切换 API 格式：保存后立即用「测试连通性」同款真实请求探测新格式的端点。
   * 主聊天链路按此格式发请求（apiFormat 已接入 buildModel），端点不存在必须
   * 明确警告（如网关未部署 /v1/responses），绝不静默放行。
   */
  const handleApiFormatChange = async (next: ApiFormatType) => {
    onUpdateProvider({ ...provider, apiFormat: next });
    const probeModelId =
      provider.defaultModelId ||
      provider.models.find((m) => m.enabled)?.id ||
      provider.models[0]?.id ||
      "";
    if (!probeModelId) {
      setFormatProbe(null);
      return;
    }
    setIsProbingFormat(true);
    setFormatProbe(null);
    try {
      const res = await testModelConnectivity({ ...provider, apiFormat: next }, probeModelId);
      const label = API_FORMAT_OPTIONS.find((o) => o.value === next)?.label ?? next;
      if (res.success) {
        setFormatProbe({
          ok: true,
          message: isZh
            ? `端点探测通过 (${res.latencyMs}ms)：对话将按「${label}」协议发送`
            : `Endpoint probe OK (${res.latencyMs}ms): requests will use "${label}"`,
        });
      } else {
        setFormatProbe({
          ok: false,
          message: isZh
            ? `端点探测失败：${res.error ?? "unknown error"}。该服务商可能不支持「${label}」，对话请求按此格式发送将失败`
            : `Endpoint probe failed: ${res.error ?? "unknown error"}. This provider may not support "${label}"; requests will fail`,
        });
      }
    } finally {
      setIsProbingFormat(false);
    }
  };

  const handleRefreshModels = async () => {
    setRefreshError(null);
    setRefreshSuccessMsg(null);
    setIsRefreshing(true);

    try {
      const res = await fetchProviderModels(provider);
      if (!res.success) {
        setRefreshError(res.error || (isZh ? "刷新模型失败" : "Failed to refresh models"));
      } else if (res.models) {
        onUpdateProvider({
          ...provider,
          models: res.models,
        });
        if (res.newCount && res.newCount > 0) {
          setRefreshSuccessMsg(
            isZh
              ? `刷新完成，发现并添加了 ${res.newCount} 个新模型 (共 ${res.totalCount} 个)`
              : `Refreshed: added ${res.newCount} new model(s) (${res.totalCount} total)`
          );
        } else {
          setRefreshSuccessMsg(
            isZh
              ? `模型列表已是最新 (共 ${res.totalCount ?? res.models.length} 个模型)`
              : `Model list is up-to-date (${res.totalCount ?? res.models.length} models)`
          );
        }
      }
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleSaveName = () => {
    const trimmed = draftName.trim();
    if (trimmed) {
      onUpdateProvider({ ...provider, name: trimmed });
    }
    setIsEditingName(false);
  };

  const handleTestConnectivity = async (modelId: string) => {
    setTestingModelId(modelId);
    try {
      const res = await testModelConnectivity(provider, modelId);
      setTestResults((prev) => ({ ...prev, [modelId]: res }));
    } finally {
      setTestingModelId(null);
    }
  };

  const handleOpenAddModel = () => {
    setTargetEditModel(null);
    setEditModalMode("add");
    setIsEditModalOpen(true);
  };

  const handleOpenEditModel = (model: ModelItem) => {
    setTargetEditModel(model);
    setEditModalMode("edit");
    setIsEditModalOpen(true);
  };

  const handleSaveModelModal = (model: ModelItem) => {
    if (editModalMode === "add") {
      if (provider.models.some((m) => m.id === model.id)) {
        alert(isZh ? `已存在 ID 为 "${model.id}" 的模型` : `Model with ID "${model.id}" already exists`);
        return;
      }
      const nextModels = [model, ...provider.models];
      onUpdateProvider({
        ...provider,
        models: nextModels,
        defaultModelId: provider.defaultModelId || model.id,
      });
      if (model.effort?.defaultLevel) {
        useAppStore.getState().setThinkingLevel(model.effort.defaultLevel);
      }
    } else {
      const nextModels = provider.models.map((m) => (m.id === model.id ? model : m));
      onUpdateProvider({
        ...provider,
        models: nextModels,
      });
      if (model.effort?.defaultLevel) {
        useAppStore.getState().setThinkingLevel(model.effort.defaultLevel);
      }
    }
  };

  const handleDeleteModel = (modelId: string) => {
    const target = provider.models.find((m) => m.id === modelId);
    const displayName = target?.name || modelId;
    if (
      !confirm(
        isZh
          ? `确定要删除模型 "${displayName}" 吗？`
          : `Are you sure you want to delete model "${displayName}"?`
      )
    ) {
      return;
    }
    const nextModels = provider.models.filter((m) => m.id !== modelId);
    const nextDefaultModelId =
      provider.defaultModelId === modelId
        ? nextModels.find((m) => m.enabled)?.id || nextModels[0]?.id || ""
        : provider.defaultModelId;
    onUpdateProvider({
      ...provider,
      models: nextModels,
      defaultModelId: nextDefaultModelId,
    });
  };

  const handleToggleModelEnabled = (modelId: string) => {
    const nextModels = provider.models.map((m) =>
      m.id === modelId ? { ...m, enabled: !m.enabled } : m
    );
    onUpdateProvider({ ...provider, models: nextModels });
  };

  const visibleModels = provider.models.filter((m) => {
    if (!modelSearch.trim()) return true;
    const query = modelSearch.toLowerCase().trim();
    return m.id.toLowerCase().includes(query) || m.name.toLowerCase().includes(query);
  });

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 text-[var(--text-primary)]">
      {/* Header Card */}
      <div className="flex items-center justify-between p-4 bg-[var(--bg-elev)] border border-[var(--border)] rounded-xl">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--surface-hover)] border border-[var(--border)]">
            <ProviderLogo id={provider.id} className="w-6 h-6" />
          </div>
          <div>
            {isEditingName ? (
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSaveName()}
                  className="px-2 py-0.5 text-base font-semibold rounded bg-[var(--bg-card)] border border-[var(--accent)] text-[var(--text-primary)] outline-none"
                  autoFocus
                />
                <button
                  onClick={handleSaveName}
                  className="p-1 text-emerald-500 hover:bg-[var(--surface-hover)] rounded"
                >
                  <Check className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setIsEditingName(false)}
                  className="p-1 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] rounded"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold">{provider.name}</h3>
                <button
                  onClick={() => {
                    setDraftName(provider.name);
                    setIsEditingName(true);
                  }}
                  className="p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                  title={isZh ? "重命名" : "Rename"}
                >
                  <Edit2 className="w-3.5 h-3.5" />
                </button>
                {isActiveDefault && (
                  <span className="flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium bg-emerald-500/15 text-emerald-500 rounded-full border border-emerald-500/20">
                    <Star className="w-3 h-3 fill-current" />
                    {isZh ? "当前默认" : "Current Default"}
                  </span>
                )}
              </div>
            )}
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">ID: {provider.id}</p>
          </div>
        </div>

        {/* Right Delete & Switch —— 删除在「已启用」左侧（用户定稿）；所有服务商均可删 */}
        <div className="flex items-center gap-4">
          {onDeleteProvider && (
            <button
              onClick={() => {
                if (confirm(isZh ? `确定要删除服务商 "${provider.name}" 吗？` : `Delete provider "${provider.name}"?`)) {
                  onDeleteProvider(provider.id);
                }
              }}
              className="p-1.5 text-red-400 hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-colors"
              title={isZh ? "删除服务商" : "Delete Provider"}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <span className="text-xs text-[var(--text-secondary)]">
              {provider.enabled ? (isZh ? "已启用" : "Enabled") : (isZh ? "已禁用" : "Disabled")}
            </span>
            <input
              type="checkbox"
              checked={provider.enabled}
              onChange={(e) => onUpdateProvider({ ...provider, enabled: e.target.checked })}
              className="sr-only peer"
            />
            <div className="w-9 h-5 bg-[var(--border)] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[var(--accent)] relative" />
          </label>
        </div>
      </div>

      {/* Connection & Key Section */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Base URL */}
        <div className="p-4 bg-[var(--bg-elev)] border border-[var(--border)] rounded-xl space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
              {isZh ? "API 端点 (Base URL)" : "API Endpoint (Base URL)"}
            </label>
          </div>
          <input
            type="text"
            value={provider.baseUrl}
            onChange={(e) => onUpdateProvider({ ...provider, baseUrl: e.target.value })}
            onBlur={(e) => {
              const cleaned = cleanBaseUrl(e.target.value);
              if (cleaned !== provider.baseUrl) {
                onUpdateProvider({ ...provider, baseUrl: cleaned });
              }
            }}
            placeholder={isZh ? "例如 http://192.168.3.27:8787 (无需带 /v1)" : "e.g. http://localhost:8787 (no /v1)"}
            className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)] font-mono outline-none focus:border-[var(--accent)] transition-colors"
          />
        </div>

        {/* API Format */}
        <div className="p-4 bg-[var(--bg-elev)] border border-[var(--border)] rounded-xl space-y-2">
          <label className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
            {isZh ? "API 格式" : "API Format"}
          </label>
          <div className="relative">
            <select
              value={provider.apiFormat}
              onChange={(e) => void handleApiFormatChange(e.target.value as ApiFormatType)}
              disabled={isProbingFormat}
              className="w-full appearance-none px-3 py-2 pr-9 text-sm rounded-lg border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] cursor-pointer disabled:opacity-60"
            >
              {API_FORMAT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value} className="bg-[var(--bg-card)] text-[var(--text-primary)]">
                  {opt.label}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-secondary)] opacity-70" />
          </div>
          {isProbingFormat && (
            <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--accent)]" />
              <span>{isZh ? "正在探测端点..." : "Probing endpoint..."}</span>
            </div>
          )}
          {formatProbe && !isProbingFormat && (
            <div
              className={`flex items-start justify-between gap-2 p-2 rounded-lg text-xs ${
                formatProbe.ok
                  ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-500"
                  : "bg-red-500/10 border border-red-500/20 text-red-500"
              }`}
            >
              <span className="break-all">{formatProbe.message}</span>
              <button
                type="button"
                onClick={() => setFormatProbe(null)}
                className="shrink-0 opacity-70 hover:opacity-100"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        {/* API Key */}
        <div className="p-4 bg-[var(--bg-elev)] border border-[var(--border)] rounded-xl space-y-2 md:col-span-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
              {isZh ? "API 密钥 (API Key)" : "API Key"}
            </label>
            {provider.apiKeyUrl && (
              <a
                href={provider.apiKeyUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-xs text-[var(--accent)] hover:underline"
              >
                <span>{isZh ? "获取 API Key" : "Get API Key"}</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
          <div className="relative">
            <input
              type={showApiKey ? "text" : "password"}
              value={provider.apiKey}
              onChange={(e) => onUpdateProvider({ ...provider, apiKey: e.target.value })}
              placeholder={provider.id === "ollama" ? (isZh ? "本地 Ollama 无需填写 API Key" : "Ollama does not require an API Key") : (isZh ? "请输入 API 密钥" : "Enter API Key")}
              className="w-full pl-3 pr-10 py-2 text-sm rounded-lg border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)] font-mono outline-none focus:border-[var(--accent)] transition-colors"
            />
            <button
              type="button"
              onClick={() => setShowApiKey(!showApiKey)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
            >
              {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>

      {/* Models Section */}
      <div className="p-4 bg-[var(--bg-elev)] border border-[var(--border)] rounded-xl space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-[var(--border)] pb-3 gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-semibold">{isZh ? "支持的模型列表" : "Supported Models"}</h4>
              <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--surface-hover)] text-[var(--text-secondary)] font-mono">
                {provider.models.length}
              </span>
            </div>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">
              {isZh ? "管理模型启用状态、测试接口连通性或添加自定义模型" : "Manage enabled models, test connectivity, or add custom models"}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleRefreshModels}
              disabled={isRefreshing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[var(--surface-hover)] border border-[var(--border)] hover:border-[var(--accent)] rounded-lg text-[var(--text-primary)] transition-colors disabled:opacity-50 cursor-pointer"
              title={isZh ? "根据 Base URL 和 API Key 从远端服务商刷新模型列表" : "Refresh models list from remote provider API"}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
              <span>
                {isRefreshing
                  ? (isZh ? "获取中..." : "Fetching...")
                  : (isZh ? "刷新模型列表" : "Refresh Models")}
              </span>
            </button>
            <button
              type="button"
              onClick={handleOpenAddModel}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-[var(--surface-hover)] border border-[var(--border)] hover:border-[var(--accent)] rounded-lg text-[var(--text-primary)] transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{isZh ? "添加模型" : "Add Model"}</span>
            </button>
          </div>
        </div>

        {/* Model Search Bar */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-secondary)] opacity-70" />
          <input
            type="text"
            value={modelSearch}
            onChange={(e) => setModelSearch(e.target.value)}
            placeholder={isZh ? "搜索模型..." : "Search models..."}
            className="w-full pl-8 pr-7 py-1.5 text-xs rounded-lg border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] transition-colors font-mono"
          />
          {modelSearch && (
            <button
              type="button"
              onClick={() => setModelSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-secondary)] hover:text-[var(--text-primary)] p-0.5"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Refresh Error / Success Banners */}
        {refreshError && (
          <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-500 flex items-center justify-between">
            <span className="break-all">{refreshError}</span>
            <button type="button" onClick={() => setRefreshError(null)} className="ml-2 shrink-0">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {refreshSuccessMsg && (
          <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-500 flex items-center justify-between">
            <span>{refreshSuccessMsg}</span>
            <button type="button" onClick={() => setRefreshSuccessMsg(null)} className="ml-2 shrink-0">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Models List */}
        {visibleModels.length === 0 ? (
          <div className="p-8 text-center text-xs text-[var(--text-secondary)] bg-[var(--bg-card)] rounded-lg border border-dashed border-[var(--border)]">
            {modelSearch ? (
              isZh ? `未匹配到包含 "${modelSearch}" 的模型` : `No models matching "${modelSearch}"`
            ) : (
              isZh ? "填写 Base URL 和 API Key 后可点击上方按钮自动获取" : "Configure Base URL & API Key, then click Refresh Models"
            )}
          </div>
        ) : (
          <div className="space-y-1.5">
            {visibleModels.map((model) => {
              const isTesting = testingModelId === model.id;
              const testResult = testResults[model.id];
              const isCurrentDefault = isActiveDefault && activeDefaultModelId === model.id;
              const contextLabel = formatModelContextWindowLabel(model.contextWindow);

              return (
                <div
                  key={model.id}
                  className="flex items-center justify-between p-2.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] hover:border-[var(--accent)]/40 transition-all gap-3"
                >
                  {/* Left: Model Name & ID */}
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate text-[var(--text-primary)]">
                          {model.name}
                        </span>
                        {isCurrentDefault && (
                          <span className="px-1.5 py-0.5 text-[10px] font-semibold bg-emerald-500/15 text-emerald-500 rounded border border-emerald-500/20 shrink-0">
                            {isZh ? "当前默认" : "Default"}
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-[var(--text-secondary)] font-mono block truncate">
                        {model.id}
                      </span>
                    </div>
                  </div>

                  {/* Right Actions: Badges, Test, Edit, Delete, Switch */}
                  <div className="flex items-center gap-2 shrink-0">
                    {/* Test Result Indicator */}
                    {testResult && (
                      <div
                        className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded ${
                          testResult.success
                            ? "bg-emerald-500/10 text-emerald-500"
                            : "bg-red-500/10 text-red-500 max-w-[160px] truncate"
                        }`}
                        title={testResult.error || `Latency: ${testResult.latencyMs}ms`}
                      >
                        {testResult.success ? (
                          <>
                            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                            <span>{testResult.latencyMs}ms</span>
                          </>
                        ) : (
                          <>
                            <XCircle className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate">{testResult.error}</span>
                          </>
                        )}
                      </div>
                    )}

                    {/* Context Window Badge (e.g. 1M, 128K) */}
                    {contextLabel ? (
                      <span
                        className="inline-flex items-center px-1.5 py-0.5 text-xs font-mono font-medium rounded-md border border-[var(--border)] bg-[var(--surface-hover)] text-[var(--text-secondary)]"
                        title={
                          isZh
                            ? `上下文窗口大小: ${contextLabel} (${model.contextWindow} tokens)`
                            : `Context Window: ${contextLabel} (${model.contextWindow} tokens)`
                        }
                      >
                        {contextLabel}
                      </span>
                    ) : null}

                    {/* Vision Badge (视觉) */}
                    {model.supportsImage ? (
                      <span
                        className="inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full border border-[var(--border)] bg-[var(--surface-hover)] text-[var(--text-secondary)]"
                        title={isZh ? "支持图像/视觉输入" : "Supports Image/Vision Input"}
                      >
                        {isZh ? "视觉" : "Vision"}
                      </span>
                    ) : null}

                    {/* Test Model Button (Unplug) */}
                    <button
                      type="button"
                      disabled={isTesting}
                      onClick={() => handleTestConnectivity(model.id)}
                      className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
                      title={isZh ? "测试模型连通性" : "Test Model Connectivity"}
                    >
                      {isTesting ? (
                        <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)]" />
                      ) : (
                        <Unplug className="w-4 h-4" />
                      )}
                    </button>

                    {/* Edit Model Button (Pencil) */}
                    <button
                      type="button"
                      onClick={() => handleOpenEditModel(model)}
                      className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] rounded-lg transition-colors cursor-pointer"
                      title={isZh ? "编辑模型" : "Edit Model"}
                    >
                      <Pencil className="w-4 h-4" />
                    </button>

                    {/* Delete Model Button (Trash2) */}
                    <button
                      type="button"
                      onClick={() => handleDeleteModel(model.id)}
                      className="p-1.5 text-[var(--text-secondary)] hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors cursor-pointer"
                      title={isZh ? "删除模型" : "Delete Model"}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>

                    {/* Switch: Enable / Disable Model */}
                    <button
                      type="button"
                      role="switch"
                      aria-checked={model.enabled}
                      onClick={() => handleToggleModelEnabled(model.id)}
                      title={
                        model.enabled
                          ? isZh
                            ? "点击禁用此模型"
                            : "Click to disable model"
                          : isZh
                            ? "点击启用此模型"
                            : "Click to enable model"
                      }
                      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-colors focus:outline-none ${
                        model.enabled ? "bg-[var(--text-primary)]" : "bg-[var(--border)]"
                      }`}
                    >
                      <span
                        className={`pointer-events-none block h-4 w-4 rounded-full transition-transform ${
                          model.enabled
                            ? "translate-x-4 bg-[var(--bg)]"
                            : "translate-x-0 bg-[var(--text-secondary)]"
                        }`}
                      />
                    </button>

                    {/* Set as Default Button */}
                    {!isCurrentDefault && (
                      <button
                        type="button"
                        onClick={() => onSetAsDefault(provider.id, model.id)}
                        className="ml-1 px-2 py-1 text-xs rounded border border-[var(--border)] hover:bg-[var(--surface-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                        title={isZh ? "设为当前默认模型" : "Set as Default Model"}
                      >
                        {isZh ? "设为默认" : "Set Default"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Model Edit & Add Modal */}
      <ModelEditModal
        isOpen={isEditModalOpen}
        mode={editModalMode}
        model={targetEditModel}
        isZh={isZh}
        onClose={() => setIsEditModalOpen(false)}
        onSave={handleSaveModelModal}
      />
    </div>
  );
}
