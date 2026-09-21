import { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { useTranslation } from '../../i18n';
import {
  ChevronLeft, ChevronRight, Plus, Search,
  Timer, Puzzle, Hash, FolderOpen, Settings, Monitor,
  Filter,
} from 'lucide-react';
import { ProjectList, ProjectGroup } from './ProjectList';

const MOCK_PROJECTS: ProjectGroup[] = [
  {
    name: 'deepseek-plugin',
    children: [
      { name: 'dsh-core', daysAgo: 5 },
      { name: 'dsh-desktop', daysAgo: 20 },
      { name: 'freeIlmapi', daysAgo: 21 },
    ],
  },
  {
    name: 'ZCodeProject',
    children: [
      { name: '你好', daysAgo: 12 },
    ],
  },
];

export function WorkspaceSidebar() {
  const { t } = useTranslation();
  const isSidebarOpen = useAppStore(state => state.isSidebarOpen);
  const setCurrentView = useAppStore(state => state.setCurrentView);
  const [activeTab, setActiveTab] = useState<'groups' | 'projects'>('projects');

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
          <button className="p-1 hover:bg-[var(--sidebar-hover)] rounded-md transition-colors">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button className="p-1 hover:bg-[var(--sidebar-hover)] rounded-md transition-colors">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="flex flex-col gap-1 p-3">
        <button className="flex items-center justify-between w-full px-3 py-2 text-[var(--sidebar-text)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)] transition-colors rounded-md">
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
          <ProjectList projects={MOCK_PROJECTS} />
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
