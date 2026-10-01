import { useEffect, useState } from 'react';
import { Settings } from '../../lib/settings/store';
import { SettingsStatus } from '../../lib/settings/useSettings';
import { useTranslation } from '../../i18n';
import { isNotificationSoundEnabled, setNotificationSoundEnabled } from '../../lib/chat/taskNotifications';
import { getWebProxy, setWebProxy, getWebNoProxy, setWebNoProxy } from '../../lib/web/webProxy';
import { ModelProviderSettings } from './model-provider/ModelProviderSettings';
import { AppUpdaterCard } from './AppUpdaterCard';
import { PluginsSection } from './PluginsSection';
import { HooksSection } from './HooksSection';
import { AgentSubagentsPage } from './AgentSubagentsPage';
import { ShortcutsSection } from './ShortcutsSection';
import { TerminalShellSetting } from './TerminalShellSetting';
import { invoke } from '@tauri-apps/api/core';
import { AppUsagePanel } from './usage-stats/AppUsagePanel';
import { useAppStore } from '../../store/useAppStore';
import {
  Settings as SettingsIcon,
  Server,
  Bot,
  Brain,
  Blend,
  Cable,
  Info,
  PackageOpen,
  Webhook,
  ArrowLeft,
  Moon,
  Sun,
  ChartColumn
} from 'lucide-react';
import { McpHubPage } from '../mcp/McpHubPage';
import { SkillsHubPage } from '../skills/SkillsHubPage';
import { MemoryPanel } from '../memory/MemoryPanel';

interface SettingsPageProps {
  settings: Settings;
  status: SettingsStatus;
  onChange: (patch: Partial<Settings>) => void;
  onBack: () => void;
  /** 活动工作区根（hooks 管理读写其 .ReinAgent/config.json） */
  workspaceRoot?: string;
  /** 记忆面板的驱动模型选择器选项（App 的 hubModelOptions 接线） */
  memoryModelOptions?: Array<{ value: string; label: string; group?: string }>;
  /** 外部定位初始 tab（侧栏插件图标 → 'plugins'；变化时跟随切换） */
  initialTab?: string;
}

export function SettingsPage({ settings, status, onChange, onBack, workspaceRoot, memoryModelOptions, initialTab }: SettingsPageProps) {
  const { t } = useTranslation();
  const [soundEnabled, setSoundEnabled] = useState(isNotificationSoundEnabled());
  const [proxyInput, setProxyInput] = useState(getWebProxy());
  const [noProxyInput, setNoProxyInput] = useState(getWebNoProxy());
  const [proxySavedNote, setProxySavedNote] = useState(false);
  const [noProxySavedNote, setNoProxySavedNote] = useState(false);
  const [hideToTray, setHideToTray] = useState(true);
  const [activeTab, setActiveTab] = useState<'general' | 'appearance' | 'provider' | 'terminal' | 'agent' | 'skills' | 'mcp' | 'memory' | 'usage' | 'hooks' | 'plugins' | 'about'>('general');
  // 外部定位（侧栏插件图标 → plugins）：initialTab 变化时跟随切换
  useEffect(() => {
    if (initialTab) setActiveTab(initialTab as typeof activeTab);
  }, [initialTab]);
  const { theme, toggleTheme, locale, toggleLocale } = useAppStore();

  const navItems = [
    { id: 'general', label: t('settingsGeneral'), icon: SettingsIcon },
    { id: 'provider', label: t('settingsProvider'), icon: Server },
    { id: 'usage', label: t('settingsUsage'), icon: ChartColumn },
    { id: 'agent', label: t('settingsAgent'), icon: Bot },
    { id: 'skills', label: t('navSkills'), icon: Blend },
    { id: 'mcp', label: t('navMcp'), icon: Cable },
    { id: 'memory', label: t('navMemory'), icon: Brain },
    { id: 'hooks', label: t('hooksTitle'), icon: Webhook },
    { id: 'plugins', label: t('pluginsTitle'), icon: PackageOpen },
    { id: 'about', label: t('settingsAbout'), icon: Info },
  ] as const;

  return (
    <div className="flex h-screen w-full bg-[var(--bg)] text-[var(--text)]">
      {/* Left Nav */}
      <div className="w-56 bg-[var(--settings-nav-bg)] border-r border-[var(--border)] flex flex-col">
        <div className="p-4 border-b border-[var(--border)]">
          <button
            onClick={onBack}
            className="flex items-center gap-2 text-sm text-[var(--text-dim)] hover:text-[var(--text)] transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </button>
        </div>
        <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                activeTab === id
                  ? 'bg-[var(--settings-nav-active)] text-[var(--text)]'
                  : 'text-[var(--text-dim)] hover:bg-[var(--settings-nav-hover)] hover:text-[var(--text)]'
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </nav>
      </div>

      {/* Content Area —— 背景色与间距对齐 Skills/MCP/记忆三个 hub 页：
          hub-scope 提供 LA 色板（bg-background = hub 同款底色），hub 页自带
          bg-background+内边距原样嵌入；其它 tab 用 hub 同款 padding 节奏
          （px-5 sm:6 lg:8 xl:10、顶 pt-4 底 pb-6）+ 内容 max-w-1320px 居中。
          ⚠ 底部间距放在滚动内容上（inner pb-6）+ items-start，原因见 git 历史：
          flex 滚动容器 padding-bottom 不计入可滚动区域、stretch 会把 inner 拉成固定高。 */}
      <div className="flex min-h-0 flex-1 bg-background">
      {activeTab === 'skills' || activeTab === 'mcp' || activeTab === 'memory' ? (
        <div className="flex min-h-0 w-full flex-col overflow-hidden">
          {activeTab === 'skills' && <SkillsHubPage />}
          {activeTab === 'mcp' && <McpHubPage />}
          {activeTab === 'memory' && (
            <MemoryPanel
              workdir={workspaceRoot || undefined}
              modelOptions={memoryModelOptions ?? []}
            />
          )}
        </div>
      ) : activeTab === 'provider' ? (
        /* 模型服务商：固定高分栏（框 h-full 跟随页面高度，内部自带滚动），底部留同款 pb-6 */
        <div className="flex min-h-0 w-full flex-col px-5 pt-4 pb-6 sm:px-6 lg:px-8 xl:px-10">
          <h2 className="text-xl font-semibold mb-4">{t('settingsProvider')}</h2>
          <div className="min-h-0 flex-1">
            <ModelProviderSettings settings={settings} status={status} onChange={onChange} />
          </div>
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto px-5 pt-4 sm:px-6 lg:px-8 xl:px-10 flex justify-center items-start">
        <div className="w-full max-w-1320px pb-6 transition-all duration-200">
          {activeTab === 'general' && (
            <div className="space-y-6">
              <h2 className="text-xl font-semibold mb-6">{t('settingsGeneral')}</h2>
              <div className="p-4 bg-[var(--bg-elev)] rounded-xl border border-[var(--border)] flex items-center justify-between">
                <div>
                  <div className="font-medium">{t('language')}</div>
                  <div className="text-sm text-[var(--text-dim)]">{locale === 'zh-CN' ? '中文' : 'English'}</div>
                </div>
                <button
                  onClick={toggleLocale}
                  className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg hover:bg-[var(--accent-dim)] transition-colors text-sm"
                >
                  {locale === 'zh-CN' ? '切换' : 'Toggle'}
                </button>
              </div>
              <div className="p-4 bg-[var(--bg-elev)] rounded-xl border border-[var(--border)] flex items-center justify-between">
                <div>
                  <div className="font-medium">{t('settingsAppearance')}</div>
                  <div className="text-sm text-[var(--text-dim)]">{theme === 'dark' ? t('darkMode') : t('lightMode')}</div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => theme !== 'light' && toggleTheme()}
                    aria-label={t('lightMode')}
                    className={`w-10 h-10 rounded-lg border flex items-center justify-center transition-colors ${theme === 'light' ? 'border-[var(--brand)] bg-[var(--brand-dim)] text-[var(--brand)]' : 'border-[var(--border)] text-[var(--text-dim)] hover:border-[var(--brand)]'}`}
                  >
                    <Sun className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => theme !== 'dark' && toggleTheme()}
                    aria-label={t('darkMode')}
                    className={`w-10 h-10 rounded-lg border flex items-center justify-center transition-colors ${theme === 'dark' ? 'border-[var(--brand)] bg-[var(--brand-dim)] text-[var(--brand)]' : 'border-[var(--border)] text-[var(--text-dim)] hover:border-[var(--brand)]'}`}
                  >
                    <Moon className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className="p-4 bg-[var(--bg-elev)] rounded-xl border border-[var(--border)] flex items-center justify-between">
                <div>
                  <div className="font-medium">{t('notificationSound')}</div>
                  <div className="text-sm text-[var(--text-dim)]">{t('notificationSoundDesc')}</div>
                </div>
                <button
                  onClick={() => {
                    const next = !soundEnabled;
                    setNotificationSoundEnabled(next);
                    setSoundEnabled(next);
                  }}
                  role="switch"
                  aria-checked={soundEnabled}
                  className={`relative w-11 h-6 rounded-full transition-colors ${soundEnabled ? 'bg-[var(--brand)]' : 'bg-[var(--border)]'}`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${soundEnabled ? 'translate-x-5' : ''}`}
                  />
                </button>
              </div>
              <div className="p-4 bg-[var(--bg-elev)] rounded-xl border border-[var(--border)] space-y-3">
                <div>
                  <div className="font-medium">{t('webProxyLabel')}</div>
                  <div className="text-sm text-[var(--text-dim)]">{t('webProxyDesc')}</div>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={proxyInput}
                    placeholder="http://127.0.0.1:7890"
                    onChange={(e) => setProxyInput(e.target.value)}
                    onBlur={() => setWebProxy(proxyInput)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        setWebProxy(proxyInput);
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                    className="min-w-0 flex-1 px-3 py-2 rounded-lg bg-[var(--bg)] border border-[var(--border)] text-sm text-[var(--text)] focus:outline-none focus:border-[var(--brand)]"
                  />
                  <button
                    onClick={() => {
                      setWebProxy(proxyInput);
                      setProxySavedNote(true);
                    }}
                    className="shrink-0 px-4 py-2 bg-[var(--accent)] text-white rounded-lg hover:bg-[var(--accent-dim)] transition-colors text-sm"
                  >
                    {t('webProxySave')}
                  </button>
                </div>
                {proxySavedNote ? (
                  <p className="text-xs text-[var(--status-ok)]">{t('webProxySavedNote')}</p>
                ) : null}
              </div>
              <div className="p-4 bg-[var(--bg-elev)] rounded-xl border border-[var(--border)] space-y-3">
                <div>
                  <div className="font-medium">{t('webNoProxyLabel')}</div>
                  <div className="text-sm text-[var(--text-dim)]">{t('webNoProxyDesc')}</div>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={noProxyInput}
                    placeholder="localhost,127.0.0.1,::1,.example.com"
                    onChange={(e) => setNoProxyInput(e.target.value)}
                    onBlur={() => setWebNoProxy(noProxyInput)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        setWebNoProxy(noProxyInput);
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                    className="min-w-0 flex-1 px-3 py-2 rounded-lg bg-[var(--bg)] border border-[var(--border)] text-sm text-[var(--text)] focus:outline-none focus:border-[var(--brand)]"
                  />
                  <button
                    onClick={() => {
                      setWebNoProxy(noProxyInput);
                      setNoProxySavedNote(true);
                    }}
                    className="shrink-0 px-4 py-2 bg-[var(--accent)] text-white rounded-lg hover:bg-[var(--accent-dim)] transition-colors text-sm"
                  >
                    {t('webNoProxySave')}
                  </button>
                </div>
                {noProxySavedNote ? (
                  <p className="text-xs text-[var(--status-ok)]">{t('webNoProxySavedNote')}</p>
                ) : null}
              </div>
              <TerminalShellSetting />
              <div className="p-4 bg-[var(--bg-elev)] rounded-xl border border-[var(--border)] flex items-center justify-between">
                <div>
                  <div className="font-medium">{t('hideToTrayLabel')}</div>
                  <div className="text-sm text-[var(--text-dim)]">{t('hideToTrayDesc')}</div>
                </div>
                <button
                  onClick={() => {
                    const next = !hideToTray;
                    setHideToTray(next);
                    void invoke('set_hide_to_tray', { enabled: next });
                  }}
                  role="switch"
                  aria-checked={hideToTray}
                  className={`relative w-11 h-6 rounded-full transition-colors ${hideToTray ? 'bg-[var(--brand)]' : 'bg-[var(--border)]'}`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${hideToTray ? 'translate-x-5' : ''}`}
                  />
                </button>
              </div>
              <ShortcutsSection />
            </div>
          )}

          {activeTab === 'usage' && (
            <div className="space-y-6">
              <AppUsagePanel />
            </div>
          )}

          {activeTab === 'agent' && (
            <div className="space-y-6">
              <h2 className="text-xl font-semibold mb-6">{t('settingsAgent')}</h2>
              <AgentSubagentsPage />
            </div>
          )}

          {activeTab === 'hooks' && (
            <div className="space-y-6">
              <h2 className="text-xl font-semibold mb-6">{t('hooksTitle')}</h2>
              <HooksSection workspaceRoot={workspaceRoot} />
            </div>
          )}

          {activeTab === 'plugins' && (
            <div className="space-y-6">
              <h2 className="text-xl font-semibold mb-6">{t('pluginsTitle')}</h2>
              <PluginsSection />
            </div>
          )}

          {activeTab === 'about' && (
            <div className="space-y-6">
              <h2 className="text-xl font-semibold mb-6">{t('settingsAbout')}</h2>
              <div className="p-6 bg-[var(--bg-elev)] rounded-xl border border-[var(--border)] space-y-4">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-[var(--brand)] rounded-xl flex items-center justify-center text-white font-bold text-xl">
                    R
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold">ReinAgent</h3>
                    <p className="text-sm text-[var(--text-dim)]">Version 0.1.0</p>
                  </div>
                </div>
                <div className="pt-4 border-t border-[var(--border)] text-sm text-[var(--text-dim)] space-y-2">
                  <p>A desktop AI coding assistant built with Tauri v2.</p>
                  <p>MIT License</p>
                  <p>Tech Stack: React 19, TypeScript, Vite, Tailwind CSS v4, Zustand</p>
                </div>
              </div>
              <AppUpdaterCard />
            </div>
          )}
        </div>
      </div>
      )}
      </div>
    </div>
  );
}
