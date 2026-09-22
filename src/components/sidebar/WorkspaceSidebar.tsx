import { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { useTranslation } from '../../i18n';
import {
  Sun, Moon, HelpCircle, Plus, Search,
  Timer, Puzzle, Hash, FolderOpen, Settings, Monitor,
  Filter,
} from 'lucide-react';
import { ProjectList, ProjectGroup } from './ProjectList';

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

export function WorkspaceSidebar({ onNewTask }: { onNewTask?: (project?: string | null) => void }) {
  const { t } = useTranslation();
  const isSidebarOpen = useAppStore(state => state.isSidebarOpen);
  const setCurrentView = useAppStore(state => state.setCurrentView);
  const theme = useAppStore(state => state.theme);
  const toggleTheme = useAppStore(state => state.toggleTheme);
  const locale = useAppStore(state => state.locale);
  const toggleLocale = useAppStore(state => state.toggleLocale);
  const startNewTaskDraft = useAppStore(state => state.startNewTaskDraft);
  const selectedProject = useAppStore(state => state.selectedProject);
  const [activeTab, setActiveTab] = useState<'groups' | 'projects'>('projects');

  const handleNewTask = () => {
    startNewTaskDraft(selectedProject);
    onNewTask?.(selectedProject);
  };

  if (!isSidebarOpen) return null;

  return (
    <div className="flex flex-col w-[260px] h-full bg-[var(--sidebar-bg)] border-r border-[var(--border)] transition-all duration-300">
      {/* Top Header */}
      <div className="flex items-center justify-between p-4 pb-2">
        <div className="flex items-center gap-2 font-bold text-[var(--sidebar-text-active)]">
          <div className="flex items-center justify-center w-6 h-6 bg-[var(--accent)] text-white rounded-md">
            R
          </div>
          <span>ReinAgent</span>
        </div>
        <div className="flex items-center gap-1 text-[var(--sidebar-text)]">
          <button
            onClick={toggleTheme}
            className="p-1 hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)] rounded-md transition-colors"
            title={theme === 'dark' ? t('lightMode') : t('darkMode')}
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          <button
            onClick={toggleLocale}
            className="p-1 hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)] rounded-md transition-colors"
            title={locale === 'zh-CN' ? 'Switch to English' : '切换为简体中文'}
          >
            <LanguageGlobeIcon locale={locale} className="w-4 h-4" />
          </button>
          <button
            onClick={() => setCurrentView('settings')}
            className="p-1 hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)] rounded-md transition-colors"
            title={t('settings')}
          >
            <HelpCircle className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="flex flex-col gap-1 p-3">
        <button
          onClick={handleNewTask}
          className="flex items-center justify-between w-full px-3 py-2 text-[var(--sidebar-text)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)] transition-colors rounded-md"
        >
          <div className="flex items-center gap-2">
            <Plus className="w-4 h-4" />
            <span className="text-sm">{t('newTask')}</span>
          </div>
          <span className="text-xs opacity-50">Ctrl+N</span>
        </button>
        <button className="flex items-center justify-between w-full px-3 py-2 text-[var(--sidebar-text)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)] transition-colors rounded-md">
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4" />
            <span className="text-sm">{t('search')}</span>
          </div>
          <span className="text-xs opacity-50">Ctrl+K</span>
        </button>
        <button className="flex items-center justify-between w-full px-3 py-2 text-[var(--sidebar-text)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)] transition-colors rounded-md">
          <div className="flex items-center gap-2">
            <Timer className="w-4 h-4" />
            <span className="text-sm">{t('automation')}</span>
          </div>
        </button>
        <button className="flex items-center justify-between w-full px-3 py-2 text-[var(--sidebar-text)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)] transition-colors rounded-md">
          <div className="flex items-center gap-2">
            <Puzzle className="w-4 h-4" />
            <span className="text-sm">{t('pluginMarket')}</span>
          </div>
        </button>
      </div>

      {/* Tabs */}
      <div className="flex items-center justify-between px-3 py-2 mx-3 bg-[var(--bg-elev)] rounded-md">
        <div className="flex items-center flex-1 gap-1">
          <button 
            onClick={() => setActiveTab('groups')}
            className={`flex items-center justify-center flex-1 py-1 text-sm rounded-md transition-colors ${activeTab === 'groups' ? 'bg-[var(--sidebar-hover)] text-[var(--sidebar-text-active)] shadow-sm' : 'text-[var(--sidebar-text)] hover:text-[var(--sidebar-text-active)]'}`}
          >
            <Hash className="w-4 h-4 mr-1" />
            {t('groups')}
          </button>
          <button 
            onClick={() => setActiveTab('projects')}
            className={`flex items-center justify-center flex-1 py-1 text-sm rounded-md transition-colors ${activeTab === 'projects' ? 'bg-[var(--sidebar-hover)] text-[var(--sidebar-text-active)] shadow-sm' : 'text-[var(--sidebar-text)] hover:text-[var(--sidebar-text-active)]'}`}
          >
            <FolderOpen className="w-4 h-4 mr-1" />
            {t('projects')}
          </button>
        </div>
        <div className="flex items-center gap-1 ml-2 text-[var(--sidebar-text)]">
          <button className="p-1 hover:bg-[var(--sidebar-hover)] rounded-md transition-colors">
            <Filter className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Project List */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden mt-2 p-2">
        {activeTab === 'projects' ? (
          <ProjectList projects={MOCK_PROJECTS} onNewTask={onNewTask} />
        ) : (
          <div className="p-3 text-sm text-[var(--sidebar-text)] opacity-50">
            {t('groups')} (WIP)
          </div>
        )}
      </div>

      {/* User Bar */}
      <div className="flex items-center justify-between p-3 mt-auto border-t border-[var(--border)] hover:bg-[var(--sidebar-hover)] transition-colors cursor-pointer">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-8 h-8 bg-blue-600 text-white rounded-md font-bold">
            K
          </div>
          <span className="text-sm font-medium text-[var(--sidebar-text-active)]">kwtgsgi8</span>
        </div>
        <div className="flex items-center gap-1 text-[var(--sidebar-text)]">
          <button className="p-1.5 hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)] rounded-md transition-colors">
            <Monitor className="w-4 h-4" />
          </button>
          <button 
            onClick={(e) => {
              e.stopPropagation();
              setCurrentView('settings');
            }}
            className="p-1.5 hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)] rounded-md transition-colors"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
