import { create } from "zustand";

export type ThemeMode = "dark" | "light";
export type LocaleMode = "zh-CN" | "en-US";
export type ViewMode = "workbench" | "settings";
export type ThinkingLevel = "off" | "low" | "medium" | "high" | "max";
export type ApprovalMode = "always" | "suggest" | "auto";

interface AppState {
  theme: ThemeMode;
  locale: LocaleMode;
  isTerminalOpen: boolean;
  isSettingsOpen: boolean;
  isSidebarOpen: boolean;
  currentView: ViewMode;
  thinkingLevel: ThinkingLevel;
  approvalMode: ApprovalMode;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  setLocale: (locale: LocaleMode) => void;
  toggleLocale: () => void;
  setTerminalOpen: (open: boolean) => void;
  toggleTerminal: () => void;
  setSettingsOpen: (open: boolean) => void;
  toggleSettings: () => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setCurrentView: (view: ViewMode) => void;
  setThinkingLevel: (level: ThinkingLevel) => void;
  setApprovalMode: (mode: ApprovalMode) => void;
}

const getInitialTheme = (): ThemeMode => {
  if (typeof window !== "undefined") {
    const saved = localStorage.getItem("reinagent-theme") as ThemeMode;
    if (saved === "light" || saved === "dark") return saved;
  }
  return "dark";
};

const getInitialLocale = (): LocaleMode => {
  if (typeof window !== "undefined") {
    const saved = localStorage.getItem("reinagent-locale") as LocaleMode;
    if (saved === "zh-CN" || saved === "en-US") return saved;
  }
  return "zh-CN";
};

const getInitialSidebarOpen = (): boolean => {
  if (typeof window !== "undefined") {
    const saved = localStorage.getItem("reinagent-sidebar");
    if (saved !== null) return saved === "true";
  }
  return true;
};

export const useAppStore = create<AppState>((set) => ({
  theme: getInitialTheme(),
  locale: getInitialLocale(),
  isTerminalOpen: false,
  isSettingsOpen: false,
  isSidebarOpen: getInitialSidebarOpen(),
  currentView: "workbench",
  thinkingLevel: "max",
  approvalMode: "suggest",

  setTheme: (theme) => {
    if (typeof window !== "undefined") {
      localStorage.setItem("reinagent-theme", theme);
      document.documentElement.setAttribute("data-theme", theme);
    }
    set({ theme });
  },

  toggleTheme: () => {
    set((state) => {
      const next = state.theme === "dark" ? "light" : "dark";
      if (typeof window !== "undefined") {
        localStorage.setItem("reinagent-theme", next);
        document.documentElement.setAttribute("data-theme", next);
      }
      return { theme: next };
    });
  },

  setLocale: (locale) => {
    if (typeof window !== "undefined") {
      localStorage.setItem("reinagent-locale", locale);
    }
    set({ locale });
  },

  toggleLocale: () => {
    set((state) => {
      const next = state.locale === "zh-CN" ? "en-US" : "zh-CN";
      if (typeof window !== "undefined") {
        localStorage.setItem("reinagent-locale", next);
      }
      return { locale: next };
    });
  },

  setTerminalOpen: (open) => set({ isTerminalOpen: open }),
  toggleTerminal: () => set((s) => ({ isTerminalOpen: !s.isTerminalOpen })),
  setSettingsOpen: (open) => set({ isSettingsOpen: open }),
  toggleSettings: () => set((s) => ({ isSettingsOpen: !s.isSettingsOpen })),
  setSidebarOpen: (open) => {
    if (typeof window !== "undefined") {
      localStorage.setItem("reinagent-sidebar", String(open));
    }
    set({ isSidebarOpen: open });
  },
  toggleSidebar: () => {
    set((state) => {
      const next = !state.isSidebarOpen;
      if (typeof window !== "undefined") {
        localStorage.setItem("reinagent-sidebar", String(next));
      }
      return { isSidebarOpen: next };
    });
  },
  setCurrentView: (view) => set({ currentView: view }),
  setThinkingLevel: (level) => set({ thinkingLevel: level }),
  setApprovalMode: (mode) => set({ approvalMode: mode }),
}));
