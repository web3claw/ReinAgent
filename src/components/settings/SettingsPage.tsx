import { useState } from 'react';
import { Settings } from '../../lib/settings/store';
import { SettingsStatus } from '../../lib/settings/useSettings';
import { useTranslation } from '../../i18n';
import { ProviderForm } from './ProviderForm';
import { useAppStore } from '../../store/useAppStore';
import {
  Settings as SettingsIcon,
  Palette,
  Server,
  Terminal,
  Brain,
  Info,
  ArrowLeft,
  Moon,
  Sun
} from 'lucide-react';

interface SettingsPageProps {
  settings: Settings;
  status: SettingsStatus;
  onChange: (patch: Partial<Settings>) => void;
  onBack: () => void;
}

export function SettingsPage({ settings, status, onChange, onBack }: SettingsPageProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<'general' | 'appearance' | 'provider' | 'terminal' | 'agent' | 'about'>('general');
  const { theme, toggleTheme, locale, toggleLocale } = useAppStore();

  const navItems = [
    { id: 'general', label: t('settingsGeneral'), icon: SettingsIcon },
    { id: 'appearance', label: t('settingsAppearance'), icon: Palette },
    { id: 'provider', label: t('settingsProvider'), icon: Server },
    { id: 'terminal', label: t('settingsTerminal'), icon: Terminal },
    { id: 'agent', label: t('settingsAgent'), icon: Brain },
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

      {/* Content Area */}
      <div className="flex-1 overflow-y-auto p-8 flex justify-center">
        <div className="max-w-3xl w-full">
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
                  Toggle
                </button>
              </div>
            </div>
          )}

          {activeTab === 'appearance' && (
            <div className="space-y-6">
              <h2 className="text-xl font-semibold mb-6">{t('settingsAppearance')}</h2>
              <div className="grid grid-cols-2 gap-4 max-w-md">
                <button
                  onClick={() => theme !== 'light' && toggleTheme()}
                  className={`p-4 rounded-xl border flex flex-col items-center gap-3 transition-colors ${
                    theme === 'light' ? 'border-[var(--brand)] bg-[var(--brand-dim)] text-[var(--brand)]' : 'border-[var(--border)] bg-[var(--bg-elev)] hover:border-[var(--brand)]'
                  }`}
                >
                  <Sun className="w-8 h-8" />
                  <span>{t('lightMode')}</span>
                </button>
                <button
                  onClick={() => theme !== 'dark' && toggleTheme()}
                  className={`p-4 rounded-xl border flex flex-col items-center gap-3 transition-colors ${
                    theme === 'dark' ? 'border-[var(--brand)] bg-[var(--brand-dim)] text-[var(--brand)]' : 'border-[var(--border)] bg-[var(--bg-elev)] hover:border-[var(--brand)]'
                  }`}
                >
                  <Moon className="w-8 h-8" />
                  <span>{t('darkMode')}</span>
                </button>
              </div>
            </div>
          )}

          {activeTab === 'provider' && (
            <div className="space-y-6">
              <h2 className="text-xl font-semibold mb-6">{t('settingsProvider')}</h2>
              <ProviderForm settings={settings} status={status} onChange={onChange} />
            </div>
          )}

          {activeTab === 'terminal' && (
            <div className="space-y-6">
              <h2 className="text-xl font-semibold mb-6">{t('settingsTerminal')}</h2>
              <div className="text-[var(--text-dim)]">Terminal settings coming soon</div>
            </div>
          )}

          {activeTab === 'agent' && (
            <div className="space-y-6">
              <h2 className="text-xl font-semibold mb-6">{t('settingsAgent')}</h2>
              <div className="text-[var(--text-dim)]">Agent capabilities coming soon</div>
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
