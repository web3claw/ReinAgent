import { useState, useEffect } from "react";
import type { Settings } from "../../../lib/settings/store";
import type { SettingsStatus } from "../../../lib/settings/useSettings";
import { ProviderNavigation } from "./ProviderNavigation";
import { ProviderDetailCard } from "./ProviderDetailCard";
import {
  getInitialPresetProviders,
  loadProvidersConfigFromDisk,
  saveProvidersConfigToDisk,
  type ProviderItem,
} from "./types";
import { useTranslation } from "../../../i18n";
import { CheckCircle2, AlertTriangle } from "lucide-react";

interface ModelProviderSettingsProps {
  settings: Settings;
  status: SettingsStatus;
  onChange: (patch: Partial<Settings>) => void;
}

/**
 * 设置页「最后浏览选中的服务商」记忆（localStorage）。
 * 与 settings.provider（系统默认服务商，真正发请求用）严格分离：这里只记住
 * 用户在左侧导航点了谁，下次进入页面恢复同一选中，不改变发请求走谁。
 */
const PROVIDER_PAGE_SELECTED_KEY = "reinagent-provider-page-selected";

function readStoredProviderSelection(): string {
  try {
    return localStorage.getItem(PROVIDER_PAGE_SELECTED_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeStoredProviderSelection(id: string): void {
  try {
    localStorage.setItem(PROVIDER_PAGE_SELECTED_KEY, id);
  } catch {
    // localStorage 不可用（隐私模式等）时静默降级为会话内记忆
  }
}

export function ModelProviderSettings({
  settings,
  status,
  onChange,
}: ModelProviderSettingsProps) {
  const { t, locale } = useTranslation();
  const isZh = locale === "zh-CN";

  const [providers, setProviders] = useState<ProviderItem[]>(() =>
    getInitialPresetProviders(settings)
  );

  useEffect(() => {
    let mounted = true;
    loadProvidersConfigFromDisk(settings).then((loaded) => {
      if (mounted && loaded && loaded.length > 0) {
        setProviders(loaded);
        // 记忆的选中项已不存在（配置被外部删改）→ 回退系统默认/首个，并同步记忆
        const remembered = readStoredProviderSelection();
        if (!loaded.some((p) => p.id === remembered)) {
          const fallback =
            loaded.find((p) => p.id === settings.provider) || loaded[0];
          setSelectedProviderId(fallback.id);
        }
      }
    });
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [selectedProviderId, setSelectedProviderIdState] = useState<string>(() => {
    return readStoredProviderSelection() || settings.provider || "deepseek";
  });

  // 统一选择入口：本地 state 与 localStorage 记忆同步写（所有选中路径都走这里）
  const setSelectedProviderId = (id: string) => {
    setSelectedProviderIdState(id);
    writeStoredProviderSelection(id);
  };

  const [successToast, setSuccessToast] = useState<string | null>(null);

  // 确保选中的 provider 存在
  const currentProvider =
    providers.find((p) => p.id === selectedProviderId) || providers[0];

  const showToast = (msg: string) => {
    setSuccessToast(msg);
    setTimeout(() => {
      setSuccessToast(null);
    }, 2500);
  };

  const handleUpdateProvider = (updated: ProviderItem) => {
    const nextProviders = providers.map((p) =>
      p.id === updated.id ? updated : p
    );
    setProviders(nextProviders);
    saveProvidersConfigToDisk(nextProviders);

    // 如果更新的是当前系统默认的服务商，自动同步写入 settings
    if (settings.provider === updated.id) {
      onChange({
        apiKey: updated.apiKey,
        baseUrl: updated.baseUrl,
      });
    }
  };

  const handleDeleteProvider = (id: string) => {
    const target = providers.find((p) => p.id === id);
    const nextProviders = providers.filter((p) => p.id !== id);
    setProviders(nextProviders);
    saveProvidersConfigToDisk(nextProviders);
    if (selectedProviderId === id) {
      setSelectedProviderId(nextProviders[0]?.id ?? "");
    }
    // 删除的是系统默认服务商 → 默认自动切到剩余第一个，避免 settings 悬空引用
    if (settings.provider === id && nextProviders.length > 0) {
      const fallback = nextProviders[0];
      onChange({
        provider: fallback.id as any,
        modelId: fallback.defaultModelId || fallback.models.find((m) => m.enabled)?.id || "",
        apiKey: fallback.apiKey,
        baseUrl: fallback.baseUrl,
      });
    }
    showToast(isZh ? `已删除服务商 "${target?.name ?? id}"` : `Deleted "${target?.name ?? id}"`);
  };

  // 「+ 添加」直接在列表末尾追加空白服务商并选中，配置在右侧表单填写（用户定稿：无弹窗）
  const handleAddProvider = () => {
    let n = 1;
    const base = isZh ? "新服务商" : "New Provider";
    while (providers.some((p) => p.name === (n > 1 ? `${base} ${n}` : base))) n += 1;
    const name = n > 1 ? `${base} ${n}` : base;
    const newProvider: ProviderItem = {
      id: `custom-${Date.now()}`,
      name,
      apiFormat: "openai-chat-completions",
      baseUrl: "",
      apiKey: "",
      enabled: false,
      isCustom: true,
      defaultModelId: "",
      models: [],
    };
    const nextProviders = [...providers, newProvider];
    setProviders(nextProviders);
    saveProvidersConfigToDisk(nextProviders);
    setSelectedProviderId(newProvider.id);
    showToast(isZh ? `已添加 "${name}"，请在右侧填写配置` : `Added "${name}" - configure it on the right`);
  };

  const handleSetAsDefault = (providerId: string, modelId: string) => {
    const targetProvider = providers.find((p) => p.id === providerId);
    if (!targetProvider) return;

    onChange({
      provider: providerId as any,
      modelId: modelId,
      apiKey: targetProvider.apiKey,
      baseUrl: targetProvider.baseUrl,
    });

    showToast(
      isZh
        ? `已将 ${targetProvider.name} (${modelId}) 设为系统默认模型`
        : `Set ${targetProvider.name} (${modelId}) as default`
    );
  };

  return (
    <div className="flex flex-col h-full min-h-0 w-full bg-[var(--bg-elev)] border border-[var(--border)] rounded-2xl overflow-hidden shadow-sm relative">
      {/* Toast Notification */}
      {successToast && (
        <div className="absolute top-4 right-4 z-50 flex items-center gap-2 px-3.5 py-2 bg-emerald-500 text-white rounded-xl shadow-lg text-xs font-medium animate-in fade-in slide-in-from-top-2 duration-200">
          <CheckCircle2 className="w-4 h-4" />
          <span>{successToast}</span>
        </div>
      )}

      {/* Top Banner: Status info */}
      <div className="flex items-center justify-between px-5 py-2.5 bg-[var(--bg-secondary)] border-b border-[var(--border)] text-xs">
        <div className="flex items-center gap-2 text-[var(--text-secondary)]">
          <span>{isZh ? "多模型服务商架构与凭证管理" : "Model Providers & Credentials"}</span>
        </div>
        <div className="flex items-center gap-2">
          {status.persistent ? (
            <span className="flex items-center gap-1 text-emerald-500 font-medium">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>{t("saved")}</span>
            </span>
          ) : (
            <span className="flex items-center gap-1 text-amber-500 font-medium">
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>Memory Mode</span>
            </span>
          )}
        </div>
      </div>

      {/* Main Dual-Column Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Providers Navigation */}
        <ProviderNavigation
          providers={providers}
          selectedId={selectedProviderId}
          onSelect={(id) => setSelectedProviderId(id)}
          onAddProvider={handleAddProvider}
        />

        {/* Right Provider Detail Form */}
        {currentProvider && (
          <ProviderDetailCard
            provider={currentProvider}
            isActiveDefault={settings.provider === currentProvider.id}
            activeDefaultModelId={settings.modelId}
            onUpdateProvider={handleUpdateProvider}
            onDeleteProvider={handleDeleteProvider}
            onSetAsDefault={handleSetAsDefault}
          />
        )}
      </div>
    </div>
  );
}
