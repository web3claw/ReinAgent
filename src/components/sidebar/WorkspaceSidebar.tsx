import { useEffect, useState, type ReactNode } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { useAppStore } from '../../store/useAppStore';
import { useTranslation } from '../../i18n';
import {
  Sun, Moon, Plus, Search,
  Timer, Settings, Monitor, Plug,
} from 'lucide-react';
import { ProjectList, ProjectGroup } from './ProjectList';

/** 底栏图标按钮（对齐 PI-Desktop TooltipButton + footer-action：32×32 命中区和 top 气泡提示）。
 * 无 tooltip / 无 onClick 时为纯展示占位（不高亮、不可点）。 */
function FooterIconButton({
  tooltip,
  onClick,
  children,
}: {
  tooltip?: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  const interactive = Boolean(tooltip || onClick);
  // 纯 CSS hover 提示（弃用 Radix Tooltip：WebView2 下 pointerleave 丢失会残留不消失）
  return (
    <div className="group/tt relative inline-flex">
      <button
        type="button"
        onClick={onClick}
        aria-label={tooltip}
        title={tooltip}
        className={`inline-flex w-9 h-9 flex-none items-center justify-center rounded-md text-[var(--sidebar-text)] transition-colors ${
          interactive
            ? 'hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)] cursor-pointer'
            : 'cursor-default'
        }`}
      >
        {children}
      </button>
      {tooltip ? (
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-2.5 py-1.5 opacity-0 shadow-xl transition-opacity duration-100 group-hover/tt:opacity-100"
        >
          <span className="text-xs font-medium text-[var(--text)]">{tooltip}</span>
        </span>
      ) : null}
    </div>
  );
}

/** 应用 logo（内联 SVG，与 src-tauri/icons 应用图标同源设计：蓝色渐变圆角方块 + 白色粗体 R）。 */
export function AppLogo({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      aria-hidden="true"
      className="shrink-0"
    >
      <defs>
        <linearGradient id="reinagent-logo-gradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#4F7CFF" />
          <stop offset="100%" stopColor="#2563EB" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="224" fill="url(#reinagent-logo-gradient)" />
      <text
        x="512"
        y="530"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="Arial, sans-serif"
        fontWeight="bold"
        fontSize="620"
        fill="#FFFFFF"
      >
        R
      </text>
    </svg>
  );
}

/** 融合版 SVG 地球仪图标（内置中/EN状态镂空刻字） */
export function LanguageGlobeIcon({ locale, className = "w-4 h-4" }: { locale: string; className?: string }) {
  const isZh = locale === "zh-CN";
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {/* 地球仪外圆 */}
      <circle cx="12" cy="12" r="9.5" />
      {/* 经纬辅助弧线 */}
      <path d="M 4 7.5 C 7 9 17 9 20 7.5" strokeOpacity="0.35" strokeWidth="1.2" />
      <path d="M 4 16.5 C 7 15 17 15 20 16.5" strokeOpacity="0.35" strokeWidth="1.2" />
      {/* 赤道段（避开文字区） */}
      <line x1="2.5" y1="12" x2="5.5" y2="12" strokeWidth="1.5" />
      <line x1="18.5" y1="12" x2="21.5" y2="12" strokeWidth="1.5" />
      {/* 本初子午线段 */}
      <line x1="12" y1="2.5" x2="12" y2="5.5" strokeWidth="1.5" />
      <line x1="12" y1="18.5" x2="12" y2="21.5" strokeWidth="1.5" />
      {/* 镂空刻字状态 */}
      <text
        x="12"
        y={isZh ? "15.2" : "15"}
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontSize={isZh ? "8.5" : "7.5"}
        fontWeight="800"
        fontFamily="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        letterSpacing={isZh ? "0" : "-0.5"}
      >
        {isZh ? "中" : "EN"}
      </text>
    </svg>
  );
}

export const MOCK_PROJECTS: ProjectGroup[] = [];

export function WorkspaceSidebar({
  onNewTask,
  onOpenSearch,
  onOpenPlugins,
}: {
  onNewTask?: (project?: string | null) => void;
  /** 打开全局搜索弹窗（放大镜按钮；对齐 LiveAgent ConversationSearchDialog 入口） */
  onOpenSearch?: () => void;
  /** 底部插件图标：打开设置并直落插件 tab */
  onOpenPlugins?: () => void;
}) {
  const { t } = useTranslation();
  const isSidebarOpen = useAppStore(state => state.isSidebarOpen);
  const setCurrentView = useAppStore(state => state.setCurrentView);
  const theme = useAppStore(state => state.theme);
  const toggleTheme = useAppStore(state => state.toggleTheme);
  const locale = useAppStore(state => state.locale);
  const toggleLocale = useAppStore(state => state.toggleLocale);
  const startNewTaskDraft = useAppStore(state => state.startNewTaskDraft);
  const selectedProject = useAppStore(state => state.selectedProject);
  // 应用版本号（tauri.conf.json version；浏览器模式取不到则不显示）
  const [versionText, setVersionText] = useState("");
  useEffect(() => {
    getVersion().then(setVersionText).catch(() => setVersionText(""));
  }, []);

  const handleNewTask = () => {
    startNewTaskDraft(selectedProject);
    onNewTask?.(selectedProject);
  };

  if (!isSidebarOpen) return null;

  return (
    <div className="flex flex-col w-full h-full bg-[var(--sidebar-bg)] border-r border-[var(--border)] transition-all duration-300">
      {/* Quick Actions（顶部品牌区已移除：与系统窗口标题栏重复；主题/语言开关移至底栏图标排）。
          新建任务行右侧 = 搜索按钮（对齐 LiveAgent：放大镜在侧栏顶部，Ctrl+N 字样已移除）；
          自动化下方为 Skills / MCP / 记忆（照抄 LiveAgent sidebarShortcuts，图标 lucide 同款）；
          插件市场占位已删除。 */}
      <div className="flex flex-col gap-1 p-3">
        <button
          onClick={handleNewTask}
          className="flex items-center justify-between w-full px-3 py-2 text-[var(--sidebar-text)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)] transition-colors rounded-md"
        >
          <div className="flex items-center gap-2">
            <Plus className="w-4 h-4" />
            <span className="text-sm font-semibold">{t('newTask')}</span>
          </div>
          <span
            role="button"
            aria-label={t('searchConversations')}
            title={t('searchConversations')}
            className="p-1 rounded-md transition-colors hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)]"
            onClick={(e) => {
              e.stopPropagation();
              onOpenSearch?.();
            }}
          >
            <Search className="w-4 h-4" />
          </span>
        </button>
        <button
          onClick={() => setCurrentView('automations')}
          className="flex items-center justify-between w-full px-3 py-2 text-[var(--sidebar-text)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)] transition-colors rounded-md cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <Timer className="w-4 h-4" />
            <span className="text-sm font-semibold">{t('automation')}</span>
          </div>
        </button>
      </div>

      {/* Project List（分组/项目 Tabs 已移除：分组为 WIP 死功能，固定渲染项目任务列表） */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden mt-2 p-2">
        <ProjectList projects={MOCK_PROJECTS} onNewTask={onNewTask} />
      </div>

      {/* 底部图标条（对齐 PI-Desktop sidebar-footer）：主题/语言开关 + 齿轮=设置 /
          插头=插件页（直落设置插件 tab）/ 电脑占位；提示为纯 CSS hover（无残留）。 */}
      <div className="flex items-center justify-between p-3 mt-auto border-t border-[var(--border)]">
        <div className="flex items-center">
          <FooterIconButton tooltip={theme === 'dark' ? t('lightMode') : t('darkMode')} onClick={toggleTheme}>
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </FooterIconButton>
          <FooterIconButton
            tooltip={locale === 'zh-CN' ? 'Switch to English' : '切换为简体中文'}
            onClick={toggleLocale}
          >
            <LanguageGlobeIcon locale={locale} className="w-4 h-4" />
          </FooterIconButton>
          <FooterIconButton tooltip={t('settings')} onClick={() => setCurrentView('settings')}>
            <Settings className="w-4 h-4" />
          </FooterIconButton>
          <FooterIconButton tooltip={t('navPlugins')} onClick={onOpenPlugins}>
            <Plug className="w-4 h-4" />
          </FooterIconButton>
          <FooterIconButton>
            <Monitor className="w-4 h-4" />
          </FooterIconButton>
        </div>
        {versionText && (
          <span className="text-[13px] leading-none tabular-nums text-[var(--text)] font-medium">
            v{versionText}
          </span>
        )}
      </div>
    </div>
  );
}
