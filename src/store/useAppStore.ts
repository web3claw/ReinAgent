import { create } from "zustand";

export type ThemeMode = "dark" | "light";
export type LocaleMode = "zh-CN" | "en-US";
export type ViewMode = "workbench" | "settings";
export type ThinkingLevel = "off" | "low" | "medium" | "high" | "max";
export type ApprovalMode = "always" | "suggest" | "auto";

export interface AppTask {
  id: string;
  title: string;
  createdAt: number;
  updatedAt?: number;
  project: string | null;
  pinned?: boolean;
}

interface AppState {
  theme: ThemeMode;
  locale: LocaleMode;
  isTerminalOpen: boolean;
  isSettingsOpen: boolean;
  isSidebarOpen: boolean;
  currentView: ViewMode;
  thinkingLevel: ThinkingLevel;
  approvalMode: ApprovalMode;
  selectedProject: string | null;
  tasks: AppTask[];
  activeTaskId: string | null;
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
  setSelectedProject: (project: string | null) => void;
  createTask: (title?: string, project?: string | null) => string;
  setActiveTaskId: (id: string | null) => void;
  updateTaskTitle: (id: string, title: string) => void;
  deleteTask: (id: string) => void;
  toggleTaskPin: (id: string) => void;
  startNewTaskDraft: (project?: string | null) => void;
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

const getInitialTasks = (): AppTask[] => {
  if (typeof window !== "undefined") {
    try {
      const saved = localStorage.getItem("reinagent-tasks");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      }
    } catch (e) {
      console.error("Failed to load initial tasks", e);
    }
  }
  return [];
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
  selectedProject: null,
  tasks: getInitialTasks(),
  activeTaskId: null,
  setSelectedProject: (selectedProject) => set({ selectedProject }),
  setActiveTaskId: (activeTaskId) => set({ activeTaskId }),

  createTask: (title, project = null) => {
    const newId = `task-${Date.now()}`;
    const newTask: AppTask = {
      id: newId,
      title: title || (typeof window !== "undefined" && localStorage.getItem("reinagent-locale") === "en-US" ? "New Task" : "新建任务"),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      project: project,
    };
    set((state) => {
      const nextTasks = [newTask, ...state.tasks];
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem("reinagent-tasks", JSON.stringify(nextTasks));
        } catch (e) {
          console.error("Failed to save tasks", e);
        }
      }
      return { tasks: nextTasks, activeTaskId: newId };
    });
    return newId;
  },

  startNewTaskDraft: (project = null) => {
    set({
      activeTaskId: null,
      selectedProject: project,
    });
  },

  updateTaskTitle: (id, title) => {
    set((state) => {
      const nextTasks = state.tasks.map((t) =>
        t.id === id ? { ...t, title, updatedAt: Date.now() } : t
      );
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem("reinagent-tasks", JSON.stringify(nextTasks));
        } catch (e) {
          console.error("Failed to save tasks", e);
        }
      }
      return { tasks: nextTasks };
    });
  },

  deleteTask: (id) => {
    if (typeof window !== "undefined") {
      try {
        localStorage.removeItem(`reinagent-task-msg-${id}`);
      } catch (e) {
        console.error("Failed to remove task message chunk", e);
      }
    }
    set((state) => {
      const nextTasks = state.tasks.filter((t) => t.id !== id);
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem("reinagent-tasks", JSON.stringify(nextTasks));
        } catch (e) {
          console.error("Failed to save tasks", e);
        }
      }
      return {
        tasks: nextTasks,
        activeTaskId: state.activeTaskId === id ? null : state.activeTaskId,
      };
    });
  },

  toggleTaskPin: (id) => {
    set((state) => {
      const nextTasks = state.tasks.map((t) =>
        t.id === id ? { ...t, pinned: !t.pinned } : t
      );
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem("reinagent-tasks", JSON.stringify(nextTasks));
        } catch (e) {
          console.error("Failed to save tasks", e);
        }
      }
      return { tasks: nextTasks };
    });
  },

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
