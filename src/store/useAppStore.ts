import { create } from "zustand";
import { kvGet, kvSet, kvGetJSON, kvSetJSON, getTaskListCached, syncTasks } from "../lib/storage/db";
import { destroyTask } from "../lib/chat/conversationPool";
import { KV_ASSISTANT_DEFAULT } from "../lib/assistants/assistantDefs";

export type ThemeMode = "dark" | "light";
export type LocaleMode = "zh-CN" | "en-US";
/** workbench=聊天工作台 / settings=设置 / automations=自动化定时任务 /
 *  skills / mcp / memory=资源中心页（照抄 LiveAgent resource-hub 导航） */
export type ViewMode = "workbench" | "settings" | "automations" | "assistants" | "skills" | "mcp" | "memory";
export type ThinkingLevel = "off" | "default" | "low" | "medium" | "high" | "xhigh" | "max";
/** 审批模式（对齐 ZCode 用户可切面）：plan=计划模式 ask=变更前确认 edit=自动编辑 full=完全访问。 */
export type ApprovalMode = "plan" | "ask" | "edit" | "full";

export interface AppTask {
  id: string;
  title: string;
  createdAt: number;
  updatedAt?: number;
  project: string | null;
  pinned?: boolean;
  providerId?: string;
  modelId?: string;
  /** 任务级推理强度覆盖；缺省=跟随全局默认（新任务/草稿档位）。 */
  thinkingLevel?: ThinkingLevel;
  /** 任务级审批模式覆盖；缺省=跟随全局默认。 */
  approvalMode?: ApprovalMode;
  /** 工具级审批策略（工具名 → allow/ask/deny）；未配置的工具回退审批模式默认。 */
  toolPolicies?: Record<string, "allow" | "ask" | "deny">;
  /** 当前助手（人设预设）；缺省/缺省值 general = 无定制。切助手时已采用其模型/思考/审批预设。 */
  assistantId?: string;
}

interface AppState {
  theme: ThemeMode;
  locale: LocaleMode;
  globalDefaultAssistantId: string;
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
  createTask: (
    title?: string,
    project?: string | null,
    providerId?: string,
    modelId?: string,
    thinkingLevel?: ThinkingLevel,
    approvalMode?: ApprovalMode
  ) => string;
  setActiveTaskId: (id: string | null) => void;
  setGlobalDefaultAssistant: (id: string) => void;
  registerExternalTasks: (tasks: AppTask[]) => void;
  updateTaskTitle: (id: string, title: string) => void;
  updateTaskModel: (id: string, providerId: string, modelId: string) => void;
  updateTaskAssistant: (id: string, assistantId: string) => void;
  updateTaskThinkingLevel: (id: string, level: ThinkingLevel) => void;
  updateTaskApprovalMode: (id: string, mode: ApprovalMode) => void;
  updateTaskToolPolicy: (id: string, toolName: string, policy: "allow" | "ask" | "deny" | null) => void;
  deleteTask: (id: string) => void;
  toggleTaskPin: (id: string) => void;
  startNewTaskDraft: (project?: string | null) => void;
  /** 启动时从 SQLite（经 db.ts 缓存）水合全部持久化字段。必须在渲染前调用一次。 */
  hydratePersisted: () => void;
  /** 右侧代码/变更预览面板（ZCode PreviewPane 移植）的打开状态 */
  codeViewerSource:
    | { type: "file"; title: string; path: string }
    | { type: "text"; title: string; content: string; language: string; path?: string; liveCategory?: string }
    | { type: "patch"; title: string; path: string; patch: string }
    | { type: "multi-file-diff"; title: string; path?: string }
    | { type: "subagents"; title: string; focusId?: string }
    | { type: "git"; title: string }
    | { type: "files"; title: string }
    | { type: "browser"; title: string; url?: string }
    | {
        type: "code-review";
        title: string;
        path: string;
        review: {
          requestId: string;
          title: string;
          body: string;
          priority?: 0 | 1 | 2 | 3;
          startLine?: number;
          endLine?: number;
        };
      }
    | null;
  openCodeViewer: (
    source:
      | { type: "file"; title: string; path: string }
      | { type: "text"; title: string; content: string; language: string; path?: string; liveCategory?: string }
      | { type: "patch"; title: string; path: string; patch: string }
      | { type: "multi-file-diff"; title: string; path?: string }
      | { type: "subagents"; title: string; focusId?: string }
      | { type: "git"; title: string }
      | { type: "files"; title: string }
      | { type: "browser"; title: string; url?: string }
      | {
          type: "code-review";
          title: string;
          path: string;
          review: {
            requestId: string;
            title: string;
            body: string;
            priority?: 0 | 1 | 2 | 3;
            startLine?: number;
            endLine?: number;
          };
        }
  ) => void;
  closeCodeViewer: () => void;
}

const getInitialTheme = (): ThemeMode => {
  if (typeof window !== "undefined") {
    const saved = kvGet("reinagent-theme") as ThemeMode | null;
    if (saved === "light" || saved === "dark") return saved;
  }
  return "dark";
};

const getInitialLocale = (): LocaleMode => {
  if (typeof window !== "undefined") {
    const saved = kvGet("reinagent-locale") as LocaleMode | null;
    if (saved === "zh-CN" || saved === "en-US") return saved;
  }
  return "zh-CN";
};

const getInitialSidebarOpen = (): boolean => {
  if (typeof window !== "undefined") {
    const saved = kvGet("reinagent-sidebar");
    if (saved !== null) return saved === "true";
  }
  return true;
};

const getInitialTasks = (): AppTask[] => {
  if (typeof window !== "undefined") {
    try {
      return getTaskListCached()
        .map((row) => {
          try {
            return JSON.parse(row.payload) as AppTask;
          } catch {
            return null;
          }
        })
        .filter((t): t is AppTask => t !== null);
    } catch (e) {
      console.error("Failed to load initial tasks", e);
    }
  }
  return [];
};

const getInitialThinkingLevel = (): ThinkingLevel => {
  if (typeof window !== "undefined") {
    const saved = kvGet("reinagent-thinking-level");
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

const getInitialGlobalAssistant = (): string => {
  if (typeof window !== "undefined") {
    const saved = kvGetJSON<string | null>(KV_ASSISTANT_DEFAULT);
    if (typeof saved === "string" && saved) return saved;
  }
  return "general";
};

const getInitialApprovalMode = (): ApprovalMode => {
  if (typeof window !== "undefined") {
    const saved = kvGet("reinagent-approval-mode");
    if (saved === "plan" || saved === "ask" || saved === "edit" || saved === "full") return saved;
  }
  return "full";
};

const getInitialActiveTaskId = (tasks: AppTask[]): string | null => {
  if (typeof window !== "undefined") {
    const saved = kvGet("reinagent-active-task-id");
    if (saved && tasks.some((t) => t.id === saved)) {
      return saved;
    }
  }
  return null;
};

const getInitialProjects = (): string[] => {
  if (typeof window !== "undefined") {
    try {
      const saved = kvGet("reinagent-user-projects");
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
  codeViewerSource: null,
  isSidebarOpen: getInitialSidebarOpen(),
  currentView: "workbench",
  globalDefaultAssistantId: getInitialGlobalAssistant(),
  thinkingLevel: getInitialThinkingLevel(),
  approvalMode: getInitialApprovalMode(),
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
          kvSetJSON("reinagent-user-projects", nextProjects);
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
          kvSetJSON("reinagent-user-projects", nextProjects);
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
        kvSet("reinagent-active-task-id", activeTaskId);
      } else {
        kvSet("reinagent-active-task-id", "");
      }
    }
    set((state) => {
      const targetTask = activeTaskId ? state.tasks.find((t) => t.id === activeTaskId) : null;
      return {
        activeTaskId,
        // 从资源中心页（自动化/Skills/MCP/记忆）激活任务（点击侧栏任务/新建任务）时
        // 切回聊天工作台；自动化自身的派发走 createTask（不经此 action），不会打断页面停留。
        currentView:
          state.currentView === "workbench" || state.currentView === "settings"
            ? state.currentView
            : "workbench",
        // 切到已有任务严格跟随任务自身项目（无项目如实为 null，绝不残留上一个任务的项目）；
        // 切回草稿态（null）保留当前所选项目（供新任务默认归属）。
        selectedProject: targetTask ? (targetTask.project ?? null) : state.selectedProject,
      };
    });
  },

  /** 全局默认助手（无任务草稿态点「应用」= 设为全局默认；响应式，驱动顶栏 chip 即时刷新）。 */
  setGlobalDefaultAssistant: (id) => {
    kvSetJSON(KV_ASSISTANT_DEFAULT, id === "general" ? null : id);
    set({ globalDefaultAssistantId: id });
  },

  /** 批量登记外部导入的任务（会话导入）：追加到列表尾部并落库（唯一写入口，勿在调用方重复 syncTasks）。 */
  registerExternalTasks: (tasks) => {
    set((state) => {
      const nextTasks = [...state.tasks, ...tasks];
      if (typeof window !== "undefined") {
        try {
          syncTasks(nextTasks.map((t) => ({ id: t.id, payload: JSON.stringify(t), updated_at: Date.now() })));
        } catch (e) {
          console.error("Failed to save tasks", e);
        }
      }
      return { tasks: nextTasks };
    });
  },

  createTask: (title, project = null, providerId, modelId, thinkingLevel, approvalMode) => {
    const newId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const newTask: AppTask = {
      id: newId,
      title: title || (kvGet("reinagent-locale") === "en-US" ? "New Task" : "新建任务"),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      project: project,
      providerId: providerId,
      modelId: modelId,
      // 草稿态所选的推理等级/审批模式在首次发送（草稿提升）时落到新任务上，实现任务级隔离。
      thinkingLevel: thinkingLevel,
      approvalMode: approvalMode,
    };
    set((state) => {
      const nextTasks = [newTask, ...state.tasks];
      if (typeof window !== "undefined") {
        try {
          syncTasks(nextTasks.map((t) => ({ id: t.id, payload: JSON.stringify(t), updated_at: Date.now() })));
          kvSet("reinagent-active-task-id", newId);
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
      kvSet("reinagent-active-task-id", "");
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
          syncTasks(nextTasks.map((t) => ({ id: t.id, payload: JSON.stringify(t), updated_at: Date.now() })));
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
          syncTasks(nextTasks.map((t) => ({ id: t.id, payload: JSON.stringify(t), updated_at: Date.now() })));
        } catch (e) {
          console.error("Failed to save tasks", e);
        }
      }
      return { tasks: nextTasks };
    });
  },

  /** 切换任务助手：显式选择（含 general=通用助手）一律按任务记忆；仅「从未选择过」的任务回退全局默认。
   *  助手是纯人设——不携带模型/推理预设，模型与推理强度跟随设置里的默认。 */
  updateTaskAssistant: (id, assistantId) => {
    set((state) => {
      const nextTasks = state.tasks.map((t) =>
        t.id === id
          ? {
              ...t,
              assistantId,
              updatedAt: Date.now(),
            }
          : t
      );
      if (typeof window !== "undefined") {
        try {
          syncTasks(nextTasks.map((t) => ({ id: t.id, payload: JSON.stringify(t), updated_at: Date.now() })));
        } catch (e) {
          console.error("Failed to save tasks", e);
        }
      }
      return { tasks: nextTasks };
    });
  },

  updateTaskThinkingLevel: (id, level) => {
    set((state) => {
      const nextTasks = state.tasks.map((t) =>
        t.id === id ? { ...t, thinkingLevel: level, updatedAt: Date.now() } : t
      );
      if (typeof window !== "undefined") {
        try {
          syncTasks(nextTasks.map((t) => ({ id: t.id, payload: JSON.stringify(t), updated_at: Date.now() })));
        } catch (e) {
          console.error("Failed to save tasks", e);
        }
      }
      return { tasks: nextTasks };
    });
  },

  updateTaskToolPolicy: (id, toolName, policy) => {
    set((state) => {
      const nextTasks = state.tasks.map((t) => {
        if (t.id !== id) return t;
        const nextPolicies = { ...(t.toolPolicies ?? {}) };
        if (policy === null) delete nextPolicies[toolName];
        else nextPolicies[toolName] = policy;
        return { ...t, toolPolicies: nextPolicies, updatedAt: Date.now() };
      });
      if (typeof window !== "undefined") {
        try {
          syncTasks(nextTasks.map((t) => ({ id: t.id, payload: JSON.stringify(t), updated_at: Date.now() })));
        } catch (e) {
          console.error("Failed to save tasks", e);
        }
      }
      return { tasks: nextTasks };
    });
  },

  updateTaskApprovalMode: (id, mode) => {
    set((state) => {
      const nextTasks = state.tasks.map((t) =>
        t.id === id ? { ...t, approvalMode: mode, updatedAt: Date.now() } : t
      );
      if (typeof window !== "undefined") {
        try {
          syncTasks(nextTasks.map((t) => ({ id: t.id, payload: JSON.stringify(t), updated_at: Date.now() })));
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
        void destroyTask(id);
      } catch (e) {
        console.error("Failed to remove task message chunk", e);
      }
      // 检查点数据（索引 + blobs）以任务为单位存放，随任务删除一并清理
      //（对齐 LiveAgent deleteChatHistory → checkpoint_clear；失败不影响删除流程）。
      import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke("checkpoint_clear", { conversationId: id }))
        .catch((e) => console.warn("[checkpoint] clear failed:", e));
    }
    set((state) => {
      const nextTasks = state.tasks.filter((t) => t.id !== id);
      const isDeletingActive = state.activeTaskId === id;
      if (typeof window !== "undefined") {
        try {
          syncTasks(nextTasks.map((t) => ({ id: t.id, payload: JSON.stringify(t), updated_at: Date.now() })));
          if (isDeletingActive) {
            kvSet("reinagent-active-task-id", "");
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
          syncTasks(nextTasks.map((t) => ({ id: t.id, payload: JSON.stringify(t), updated_at: Date.now() })));
        } catch (e) {
          console.error("Failed to save tasks", e);
        }
      }
      return { tasks: nextTasks };
    });
  },

  setTheme: (theme) => {
    if (typeof window !== "undefined") {
      kvSet("reinagent-theme", theme);
      document.documentElement.setAttribute("data-theme", theme);
    }
    set({ theme });
  },

  toggleTheme: () => {
    set((state) => {
      const next = state.theme === "dark" ? "light" : "dark";
      if (typeof window !== "undefined") {
        kvSet("reinagent-theme", next);
        document.documentElement.setAttribute("data-theme", next);
      }
      return { theme: next };
    });
  },

  setLocale: (locale) => {
    if (typeof window !== "undefined") {
      kvSet("reinagent-locale", locale);
    }
    set({ locale });
  },

  toggleLocale: () => {
    set((state) => {
      const next = state.locale === "zh-CN" ? "en-US" : "zh-CN";
      if (typeof window !== "undefined") {
        kvSet("reinagent-locale", next);
      }
      return { locale: next };
    });
  },

  openCodeViewer: (source) => set({ codeViewerSource: source }),
  closeCodeViewer: () => set({ codeViewerSource: null }),
  // 渲染前水合：store 在模块求值时创建（此时 initStorage 尚未运行，缓存为空），
  // 因此初始值全部为默认；这里在渲染前用缓存重设全部持久化字段。
  hydratePersisted: () =>
    set(() => {
      // activeTaskId 依赖 tasks 列表（校验任务存在），先 tasks 后 active
      const tasks = getInitialTasks();
      const activeTaskId = getInitialActiveTaskId(tasks);
      return {
        theme: getInitialTheme(),
        locale: getInitialLocale(),
        isSidebarOpen: getInitialSidebarOpen(),
        tasks,
        activeTaskId,
        // selectedProject 必须跟随恢复的活动任务：漏掉它会导致重启自动恢复的任务
        // 工作区回退 DefaultProject（任务在项目下显示、工具却落在默认目录）。
        selectedProject:
          (activeTaskId ? tasks.find((t) => t.id === activeTaskId)?.project : null) ?? null,
        projects: getInitialProjects(),
        thinkingLevel: getInitialThinkingLevel(),
        approvalMode: getInitialApprovalMode(),
        globalDefaultAssistantId: getInitialGlobalAssistant(),
      };
    }),
  setTerminalOpen: (open) => set({ isTerminalOpen: open }),
  toggleTerminal: () => set((s) => ({ isTerminalOpen: !s.isTerminalOpen })),
  setSettingsOpen: (open) => set({ isSettingsOpen: open }),
  toggleSettings: () => set((s) => ({ isSettingsOpen: !s.isSettingsOpen })),
  setSidebarOpen: (open) => {
    if (typeof window !== "undefined") {
      kvSet("reinagent-sidebar", String(open));
    }
    set({ isSidebarOpen: open });
  },
  toggleSidebar: () => {
    set((state) => {
      const next = !state.isSidebarOpen;
      if (typeof window !== "undefined") {
        kvSet("reinagent-sidebar", String(next));
      }
      return { isSidebarOpen: next };
    });
  },
  setCurrentView: (view) => set({ currentView: view }),
  setThinkingLevel: (level) => {
    if (typeof window !== "undefined") {
      kvSet("reinagent-thinking-level", level);
    }
    set({ thinkingLevel: level });
  },
  setApprovalMode: (mode) => {
    if (typeof window !== "undefined") {
      kvSet("reinagent-approval-mode", mode);
    }
    set({ approvalMode: mode });
  },
}));
