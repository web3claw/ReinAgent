import { create } from "zustand";

export type ThemeMode = "dark" | "light";
export type LocaleMode = "zh-CN" | "en-US";
export type ViewMode = "workbench" | "settings";
export type ThinkingLevel = "off" | "default" | "low" | "medium" | "high" | "xhigh" | "max";
export type ApprovalMode = "always" | "suggest" | "auto";

export interface AppTask {
  id: string;
  title: string;
  createdAt: number;
  updatedAt?: number;
  project: string | null;
  pinned?: boolean;
  providerId?: string;
  modelId?: string;
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
  projects: string[];
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
  addProject: (project: string) => void;
  removeProject: (project: string) => void;
  createTask: (title?: string, project?: string | null, providerId?: string, modelId?: string) => string;
  setActiveTaskId: (id: string | null) => void;
  updateTaskTitle: (id: string, title: string) => void;
  updateTaskModel: (id: string, providerId: string, modelId: string) => void;
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

const getInitialThinkingLevel = (): ThinkingLevel => {
  if (typeof window !== "undefined") {
    const saved = localStorage.getItem("reinagent-thinking-level");
    if (
      saved === "off" ||
      saved === "default" ||
      saved === "low" ||
      saved === "medium" ||
      saved === "high" ||
      saved === "xhigh" ||
      saved === "max"
    ) {
      return saved;
    }
  }
  return "default";
};

const getInitialActiveTaskId = (tasks: AppTask[]): string | null => {
  if (typeof window !== "undefined") {
    const saved = localStorage.getItem("reinagent-active-task-id");
    if (saved && tasks.some((t) => t.id === saved)) {
      return saved;
    }
  }
  return null;
};

const getInitialProjects = (): string[] => {
  if (typeof window !== "undefined") {
    try {
      const saved = localStorage.getItem("reinagent-user-projects");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          return parsed.filter((p) => typeof p === "string" && p.trim().length > 0);
        }
      }
    } catch (e) {
      console.error("Failed to load initial projects", e);
    }
  }
  return [];
};

const initialTasks = getInitialTasks();
const initialProjects = getInitialProjects();
const initialActiveTaskId = getInitialActiveTaskId(initialTasks);
const initialActiveTask = initialActiveTaskId ? initialTasks.find((t) => t.id === initialActiveTaskId) : null;

export const useAppStore = create<AppState>((set) => ({
  theme: getInitialTheme(),
  locale: getInitialLocale(),
  isTerminalOpen: false,
  isSettingsOpen: false,
  isSidebarOpen: getInitialSidebarOpen(),
  currentView: "workbench",
  thinkingLevel: getInitialThinkingLevel(),
  approvalMode: "suggest",
  selectedProject: initialActiveTask ? initialActiveTask.project : null,
  projects: initialProjects,
  tasks: initialTasks,
  activeTaskId: initialActiveTaskId,
  setSelectedProject: (selectedProject) => set({ selectedProject }),
  addProject: (project: string) => {
    const trimmed = project.trim();
    if (!trimmed) return;
    set((state) => {
      const nextProjects = state.projects.includes(trimmed)
        ? state.projects
        : [trimmed, ...state.projects];
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem("reinagent-user-projects", JSON.stringify(nextProjects));
        } catch (e) {
          console.error("Failed to save projects", e);
        }
      }
      return { projects: nextProjects, selectedProject: trimmed };
    });
  },
  removeProject: (project: string) => {
    set((state) => {
      const nextProjects = state.projects.filter((p) => p !== project);
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem("reinagent-user-projects", JSON.stringify(nextProjects));
        } catch (e) {
          console.error("Failed to save projects", e);
        }
      }
      return {
        projects: nextProjects,
        selectedProject: state.selectedProject === project ? null : state.selectedProject,
      };
    });
  },
  setActiveTaskId: (activeTaskId) => {
    if (typeof window !== "undefined") {
      if (activeTaskId) {
        localStorage.setItem("reinagent-active-task-id", activeTaskId);
      } else {
        localStorage.removeItem("reinagent-active-task-id");
      }
    }
    set((state) => {
      const targetTask = activeTaskId ? state.tasks.find((t) => t.id === activeTaskId) : null;
      return {
        activeTaskId,
        selectedProject: targetTask ? targetTask.project : state.selectedProject,
      };
    });
  },

  createTask: (title, project = null, providerId, modelId) => {
    const newId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const newTask: AppTask = {
      id: newId,
      title: title || (typeof window !== "undefined" && localStorage.getItem("reinagent-locale") === "en-US" ? "New Task" : "新建任务"),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      project: project,
      providerId: providerId,
      modelId: modelId,
    };
    set((state) => {
      const nextTasks = [newTask, ...state.tasks];
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem("reinagent-tasks", JSON.stringify(nextTasks));
          localStorage.setItem("reinagent-active-task-id", newId);
        } catch (e) {
          console.error("Failed to save tasks", e);
        }
      }
      return { tasks: nextTasks, activeTaskId: newId, selectedProject: project };
    });
    return newId;
  },

  startNewTaskDraft: (project = null) => {
    if (typeof window !== "undefined") {
      localStorage.removeItem("reinagent-active-task-id");
    }
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

  updateTaskModel: (id, providerId, modelId) => {
    set((state) => {
      const nextTasks = state.tasks.map((t) =>
        t.id === id ? { ...t, providerId, modelId, updatedAt: Date.now() } : t
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
      const isDeletingActive = state.activeTaskId === id;
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem("reinagent-tasks", JSON.stringify(nextTasks));
          if (isDeletingActive) {
            localStorage.removeItem("reinagent-active-task-id");
          }
        } catch (e) {
          console.error("Failed to save tasks", e);
        }
      }
      return {
        tasks: nextTasks,
        activeTaskId: isDeletingActive ? null : state.activeTaskId,
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
  setThinkingLevel: (level) => {
    if (typeof window !== "undefined") {
      localStorage.setItem("reinagent-thinking-level", level);
    }
    set({ thinkingLevel: level });
  },
  setApprovalMode: (mode) => set({ approvalMode: mode }),
}));
