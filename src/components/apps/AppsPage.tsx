import React from "react";
import {
  Network,
  BookText,
  Plug,
  Bot,
  Columns3,
  Timer,
  BookOpen,
  Globe,
  Sparkles,
} from "lucide-react";
import type { ViewMode } from "../../store/useAppStore";
import { useAppStore } from "../../store/useAppStore";
import { useTranslation } from "../../i18n";

// 从 CherryHQ/cherry-studio 官方仓库及官网导入的矢量与高清品牌图标
import geminiIcon from "../../assets/model-icons/gemini.svg";
import openaiIcon from "../../assets/model-icons/openai-dark.svg";
import claudeIcon from "../../assets/model-icons/claude.svg";
import grokIcon from "../../assets/model-icons/grok-dark.svg";
import museIcon from "../../assets/model-icons/muse.svg";
import duckIcon from "../../assets/model-icons/duck.svg";
import deepseekIcon from "../../assets/model-icons/deepseek.svg";
import doubaoIcon from "../../assets/model-icons/doubao.png";
import qwenIcon from "../../assets/model-icons/qwen.svg";

interface LocalAppItem {
  id: string;
  name: string;
  nameEn: string;
  icon: React.ComponentType<{ className?: string }>;
  bgClass: string;
  action: () => void;
}

interface ModelPortalItem {
  id: string;
  name: string;
  nameEn?: string;
  url: string;
  iconSrc: string;
  bgClass: string;
  badge?: string;
  noPadding?: boolean;
}

interface AppsPageProps {
  onNavigate: (view: ViewMode) => void;
  onOpenPlugins?: () => void;
}

export function AppsPage({ onNavigate, onOpenPlugins }: AppsPageProps) {
  const { t, locale } = useTranslation();
  const isZh = locale === "zh-CN";
  const openCodeViewer = useAppStore((s) => s.openCodeViewer);

  // 本地能力与工具清单
  const localApps: LocalAppItem[] = [
    {
      id: "graph",
      name: "知识图谱",
      nameEn: "Knowledge Graph",
      icon: Network,
      bgClass: "bg-emerald-500 hover:bg-emerald-600",
      action: () => onNavigate("graph"),
    },
    {
      id: "wiki",
      name: "Wiki 文档",
      nameEn: "Wiki Docs",
      icon: BookText,
      bgClass: "bg-sky-500 hover:bg-sky-600",
      action: () => onNavigate("wiki"),
    },
    {
      id: "plugins",
      name: "插件",
      nameEn: "Plugins",
      icon: Plug,
      bgClass: "bg-purple-500 hover:bg-purple-600",
      action: () => {
        if (onOpenPlugins) {
          onOpenPlugins();
        } else {
          onNavigate("settings");
        }
      },
    },
    {
      id: "assistants",
      name: "助手库",
      nameEn: "Assistant Library",
      icon: Bot,
      bgClass: "bg-indigo-500 hover:bg-indigo-600",
      action: () => onNavigate("assistants"),
    },
    {
      id: "kanban",
      name: "看板",
      nameEn: "Kanban",
      icon: Columns3,
      bgClass: "bg-amber-500 hover:bg-amber-600",
      action: () => onNavigate("kanban"),
    },
    {
      id: "automations",
      name: "自动化",
      nameEn: "Automations",
      icon: Timer,
      bgClass: "bg-pink-500 hover:bg-pink-600",
      action: () => onNavigate("automations"),
    },
    {
      id: "notes",
      name: "笔记本",
      nameEn: "Notes",
      icon: BookOpen,
      bgClass: "bg-orange-500 hover:bg-orange-600",
      action: () => onNavigate("notes"),
    },
  ];

  // 8 大国内外顶流大模型官网清单（图标来自 Cherry Studio 官方仓库）
  const modelPortals: ModelPortalItem[] = [
    {
      id: "gemini",
      name: "Gemini",
      url: "https://gemini.google.com",
      iconSrc: geminiIcon,
      bgClass: "bg-[#141522] border border-blue-500/25 hover:border-blue-500/60 shadow-sm",
    },
    {
      id: "chatgpt",
      name: "ChatGPT",
      url: "https://chatgpt.com",
      iconSrc: openaiIcon,
      bgClass: "bg-black border border-white/15 hover:border-emerald-500/50 shadow-sm",
    },
    {
      id: "claude",
      name: "Claude",
      url: "https://claude.ai",
      iconSrc: claudeIcon,
      bgClass: "bg-[#251813] border border-[#d97757]/30 hover:border-[#d97757]/60 shadow-sm",
    },
    {
      id: "grok",
      name: "Grok",
      url: "https://grok.com",
      iconSrc: grokIcon,
      bgClass: "bg-black border border-white/15 hover:border-white/50 shadow-sm",
    },
    {
      id: "muse",
      name: "Muse",
      url: "https://muse.ai/",
      iconSrc: museIcon,
      bgClass: "bg-[#0b101b] border border-blue-500/25 hover:border-blue-500/60 shadow-sm",
    },
    {
      id: "duckduckgo",
      name: "DuckDuckGo",
      url: "https://duckduckgo.com/chat",
      iconSrc: duckIcon,
      bgClass: "bg-[#231512] border border-[#de5833]/30 hover:border-[#de5833]/60 shadow-sm",
    },
    {
      id: "deepseek",
      name: "DeepSeek",
      url: "https://chat.deepseek.com",
      iconSrc: deepseekIcon,
      bgClass: "bg-[#0e172a] border border-[#4d6bfe]/30 hover:border-[#4d6bfe]/70 shadow-sm",
    },
    {
      id: "doubao",
      name: "豆包",
      nameEn: "Doubao",
      url: "https://www.doubao.com/chat/",
      iconSrc: doubaoIcon,
      bgClass: "bg-[#D2E9FF] border border-blue-400/30 hover:border-blue-400/70 shadow-sm",
      noPadding: true,
    },
    {
      id: "qwen",
      name: "千问",
      nameEn: "Qwen",
      url: "https://www.qianwen.com/",
      iconSrc: qwenIcon,
      bgClass: "bg-[#615CED] border border-indigo-400/30 hover:border-indigo-400/70 shadow-sm",
    },
  ];

  const handleOpenModelPortal = (model: ModelPortalItem) => {
    openCodeViewer({
      type: "browser",
      title: model.name,
      url: model.url,
      tabId: `tab-${model.id}-${Date.now()}`,
    });
  };

  return (
    <div className="flex-1 h-full overflow-y-auto bg-[var(--bg)] p-6 sm:p-8 select-none">
      <div className="max-w-5xl mx-auto space-y-10">
        {/* 顶部标题区 */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--foreground)]">
            {t("appsTitle") || "应用中心"}
          </h1>
          <p className="text-sm text-[var(--text-dim)] mt-1">
            {t("appsSubtitle") || "本地工具与大模型导航"}
          </p>
        </div>

        {/* 分区 1：本地能力与工具 */}
        <section>
          <div className="flex items-center gap-2 mb-5">
            <Sparkles className="w-4 h-4 text-[var(--brand)]" />
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-dim)]">
              {t("appsSectionLocal") || "本地能力与工具"}
            </h2>
          </div>

          <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 gap-x-6 gap-y-6">
            {localApps.map((app) => {
              const IconComponent = app.icon;
              const displayName = isZh ? app.name : app.nameEn;
              return (
                <button
                  key={app.id}
                  onClick={app.action}
                  className="group flex flex-col items-center cursor-pointer focus:outline-none transition-transform"
                  title={displayName}
                >
                  {/* Squircle 圆角彩色底块 */}
                  <div
                    className={`w-16 h-16 sm:w-18 sm:h-18 rounded-2xl flex items-center justify-center text-white shadow-md transition-all duration-200 group-hover:scale-105 group-hover:shadow-lg group-active:scale-95 ${app.bgClass}`}
                  >
                    <IconComponent className="w-8 h-8 stroke-[1.8]" />
                  </div>
                  {/* 居中文字标签 */}
                  <span className="mt-2 text-xs sm:text-sm font-medium text-[var(--sidebar-text)] group-hover:text-[var(--sidebar-text-active)] text-center line-clamp-1 max-w-[90px] transition-colors">
                    {displayName}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* 细分割线 */}
        <div className="border-t border-[var(--border)]" />

        {/* 分区 2：国内外大模型官网 */}
        <section>
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <Globe className="w-4 h-4 text-sky-400" />
              <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-dim)]">
                {t("appsSectionModels") || "大模型官网"}
              </h2>
              <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-full bg-[var(--surface-hover)] text-[var(--text-dim)]">
                {modelPortals.length}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 gap-x-6 gap-y-6">
            {modelPortals.map((model) => {
              const displayName = isZh && model.nameEn ? model.name : (model.nameEn || model.name);
              return (
                <button
                  key={model.id}
                  onClick={() => handleOpenModelPortal(model)}
                  className="group flex flex-col items-center cursor-pointer focus:outline-none transition-transform"
                  title={`${model.name} (${model.url})`}
                >
                  {/* Squircle 容器 + 官方 SVG / 高清图标 */}
                  <div
                    className={`w-16 h-16 sm:w-18 sm:h-18 rounded-2xl flex items-center justify-center transition-all duration-200 group-hover:scale-105 group-hover:shadow-lg group-active:scale-95 ${
                      model.noPadding ? "p-0 overflow-hidden" : "p-3.5"
                    } ${model.bgClass}`}
                  >
                    <img
                      src={model.iconSrc}
                      alt={model.name}
                      className={`w-full h-full pointer-events-none drop-shadow-sm select-none ${
                        model.noPadding ? "object-cover" : "object-contain"
                      }`}
                      loading="lazy"
                    />
                  </div>
                  {/* 居中文字标签 */}
                  <span className="mt-2 text-xs sm:text-sm font-medium text-[var(--sidebar-text)] group-hover:text-[var(--sidebar-text-active)] text-center line-clamp-1 max-w-[90px] transition-colors">
                    {displayName}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
