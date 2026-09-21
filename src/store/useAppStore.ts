import { create } from "zustand";

export type ThemeMode = "dark" | "light";
export type LocaleMode = "zh-CN" | "en-US";

interface AppState {
  theme: ThemeMode;
  locale: LocaleMode;
  isTerminalOpen: boolean;
  isSettingsOpen: boolean;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  setLocale: (locale: LocaleMode) => void;
  toggleLocale: () => void;
  setTerminalOpen: (open: boolean) => void;
  toggleTerminal: () => void;
  setSettingsOpen: (open: boolean) => void;
  toggleSettings: () => void;
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

export const useAppStore = create<AppState>((set) => ({
  theme: getInitialTheme(),
  locale: getInitialLocale(),
  isTerminalOpen: false,
  isSettingsOpen: false,

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
}));
