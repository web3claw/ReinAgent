import { useState, useRef, useEffect } from 'react';
import { useTranslation } from '../../i18n';
import { useAppStore } from '../../store/useAppStore';
import { Tooltip } from '../ui/Tooltip';
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  GripVertical,
  MessageSquarePlus,
  Plus,
  Edit2,
  Trash2,
  Check,
  X,
  Pin,
} from 'lucide-react';

export interface ProjectGroup {
  name: string;
  children: { name: string; daysAgo: number }[];
}

export type SectionType = "projects" | "tasks";

const STORAGE_PROJECTS_KEY = "reinagent-projects-open-groups";
const STORAGE_PROJECTS_SECTION_KEY = "reinagent-projects-section-expanded";
const STORAGE_TASKS_KEY = "reinagent-tasks-expanded";
const STORAGE_SECTION_ORDER_KEY = "reinagent-sidebar-section-order";

const getSavedOpenGroups = (projects: ProjectGroup[]): Record<string, boolean> => {
  const defaultOpen = projects.reduce((acc, p) => ({ ...acc, [p.name]: true }), {});
  if (typeof window === "undefined") return defaultOpen;
  try {
    const raw = localStorage.getItem(STORAGE_PROJECTS_KEY);
    if (!raw) return defaultOpen;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return { ...defaultOpen, ...parsed };
    }
  } catch (e) {
    console.error("Failed to parse saved project open groups", e);
  }
  return defaultOpen;
};

const getSavedProjectsSectionExpanded = (): boolean => {
  if (typeof window === "undefined") return true;
  try {
    const raw = localStorage.getItem(STORAGE_PROJECTS_SECTION_KEY);
    if (raw !== null) {
      return raw === "true";
    }
  } catch (e) {
    console.error("Failed to parse saved projects section expanded state", e);
  }
  return true;
};

const getSavedTasksExpanded = (): boolean => {
  if (typeof window === "undefined") return true;
  try {
    const raw = localStorage.getItem(STORAGE_TASKS_KEY);
    if (raw !== null) {
      return raw === "true";
    }
  } catch (e) {
    console.error("Failed to parse saved tasks expanded state", e);
  }
  return true;
};

const getSavedSectionOrder = (): SectionType[] => {
  const defaultOrder: SectionType[] = ["projects", "tasks"];
  if (typeof window === "undefined") return defaultOrder;
  try {
    const raw = localStorage.getItem(STORAGE_SECTION_ORDER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.includes("projects") && parsed.includes("tasks")) {
        return parsed as SectionType[];
      }
    }
  } catch (e) {
    console.error("Failed to parse saved section order", e);
  }
  return defaultOrder;
};

function formatRelativeTime(timestamp: number, locale: string): string {
  const now = Date.now();
  const diffMs = Math.max(0, now - timestamp);
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  const isZh = locale === 'zh-CN';

  if (diffMin < 1) {
    return isZh ? '刚刚' : 'just now';
  }
  if (diffMin < 60) {
    return isZh ? `${diffMin}分钟` : `${diffMin}m`;
  }
  if (diffHour < 24) {
    return isZh ? `${diffHour}小时` : `${diffHour}h`;
  }
  return isZh ? `${diffDay}天` : `${diffDay}d`;
}

export function ProjectList({
  projects,
  onNewTask,
  onAddProject,
}: {
  projects: ProjectGroup[];
  onNewTask?: (project?: string | null) => void;
  onAddProject?: () => void;
}) {
  const { t, locale } = useTranslation();
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() =>
    getSavedOpenGroups(projects)
  );
  const [projectsExpanded, setProjectsExpanded] = useState<boolean>(getSavedProjectsSectionExpanded);
  const [tasksExpanded, setTasksExpanded] = useState<boolean>(getSavedTasksExpanded);
  const [sectionOrder, setSectionOrder] = useState<SectionType[]>(getSavedSectionOrder);
  const [draggingSection, setDraggingSection] = useState<SectionType | null>(null);

  // Inline rename state
  const [renamingTaskId, setRenamingTaskId] = useState<string | null>(null);
  const [renameDraftTitle, setRenameDraftTitle] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Inline delete confirm state (ZCode pattern)
  const [pendingDeleteTaskId, setPendingDeleteTaskId] = useState<string | null>(null);

  const dragStartYRef = useRef<number>(0);
  const currentOrderRef = useRef<SectionType[]>(sectionOrder);
  currentOrderRef.current = sectionOrder;

  const tasks = useAppStore((state) => state.tasks);
  const activeTaskId = useAppStore((state) => state.activeTaskId);
  const setActiveTaskId = useAppStore((state) => state.setActiveTaskId);
  const updateTaskTitle = useAppStore((state) => state.updateTaskTitle);
  const deleteTask = useAppStore((state) => state.deleteTask);
  const toggleTaskPin = useAppStore((state) => state.toggleTaskPin);
  const startNewTaskDraft = useAppStore((state) => state.startNewTaskDraft);

  // Listen for Escape or outside clicks to cancel inline delete confirm
  useEffect(() => {
    if (!pendingDeleteTaskId) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPendingDeleteTaskId(null);
      }
    };

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest("[data-delete-confirm-btn]")) {
        return;
      }
      setPendingDeleteTaskId(null);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [pendingDeleteTaskId]);

  const toggleProjectsSection = () => {
    setProjectsExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_PROJECTS_SECTION_KEY, String(next));
      } catch (e) {
        console.error("Failed to save projects section expanded", e);
      }
      return next;
    });
  };

  const toggleGroup = (name: string) => {
    setOpenGroups((prev) => {
      const next = { ...prev, [name]: !prev[name] };
      try {
        localStorage.setItem(STORAGE_PROJECTS_KEY, JSON.stringify(next));
      } catch (e) {
        console.error("Failed to save project open groups", e);
      }
      return next;
    });
  };

  const toggleTasks = () => {
    setTasksExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_TASKS_KEY, String(next));
      } catch (e) {
        console.error("Failed to save tasks expanded", e);
      }
      return next;
    });
  };

  const handleCreateTask = (e: React.MouseEvent, project: string | null = null) => {
    e.stopPropagation();
    startNewTaskDraft(project);
    onNewTask?.(project);
  };

  const handleStartRename = (e: React.MouseEvent, task: { id: string; title: string }) => {
    e.stopPropagation();
    setRenamingTaskId(task.id);
    setRenameDraftTitle(task.title);
    setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 50);
  };

  const handleSaveRename = (taskId: string) => {
    const trimmed = renameDraftTitle.trim();
    if (trimmed.length > 0) {
      updateTaskTitle(taskId, trimmed);
    }
    setRenamingTaskId(null);
  };

  const handleDeleteTaskClick = (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation();
    if (pendingDeleteTaskId === taskId) {
      deleteTask(taskId);
      setPendingDeleteTaskId(null);
    } else {
      setPendingDeleteTaskId(taskId);
    }
  };

  const handleTogglePinTask = (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation();
    toggleTaskPin(taskId);
  };

  const handleAddProject = (e: React.MouseEvent) => {
    e.stopPropagation();
    onAddProject?.();
  };

  const formatDays = (days: number) => {
    return locale === 'zh-CN' ? `${days}天` : `${days}d`;
  };

  // Reorder dragging handlers
  const handleDragStart = (section: SectionType, e: React.MouseEvent) => {
    e.preventDefault();
    setDraggingSection(section);
    dragStartYRef.current = e.clientY;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = moveEvent.clientY - dragStartYRef.current;
      const current = currentOrderRef.current;
      const currentIndex = current.indexOf(section);
      if (currentIndex === 0 && deltaY > 30) {
        // Move down
        const nextOrder: SectionType[] = [current[1], current[0]];
        setSectionOrder(nextOrder);
        try {
          localStorage.setItem(STORAGE_SECTION_ORDER_KEY, JSON.stringify(nextOrder));
        } catch (err) {
          console.error(err);
        }
        dragStartYRef.current = moveEvent.clientY;
      } else if (currentIndex === 1 && deltaY < -30) {
        // Move up
        const nextOrder: SectionType[] = [current[1], current[0]];
        setSectionOrder(nextOrder);
        try {
          localStorage.setItem(STORAGE_SECTION_ORDER_KEY, JSON.stringify(nextOrder));
        } catch (err) {
          console.error(err);
        }
        dragStartYRef.current = moveEvent.clientY;
      }
    };

    const handleMouseUp = () => {
      setDraggingSection(null);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  // Filter tasks that do not belong to a specific sub-project and sort pinned tasks on top
  const globalTasks = tasks
    .filter((task) => !task.project)
    .sort((a, b) => {
      // Pinned tasks go first
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      // Secondary: sort by updatedAt or createdAt desc
      const timeA = a.updatedAt || a.createdAt;
      const timeB = b.updatedAt || b.createdAt;
      return timeB - timeA;
    });

  // Render Projects Section JSX
  const renderProjectsSection = () => (
    <div
      key="projects"
      className={`flex flex-col w-full group/project-section transition-all duration-200 ${
        draggingSection === "projects" ? "opacity-75 ring-1 ring-[var(--accent)] rounded-lg bg-[var(--sidebar-hover)]" : ""
      }`}
    >
      <div className="flex items-center justify-between h-7 px-3 py-1 text-[var(--sidebar-text)] hover:text-[var(--sidebar-text-active)] transition-colors">
        <button
          type="button"
          onClick={toggleProjectsSection}
          className="flex items-center gap-1 min-w-0 text-left cursor-pointer outline-none select-none text-[var(--sidebar-text)] hover:text-[var(--sidebar-text-active)]"
        >
          <span className="text-sm font-medium text-[var(--sidebar-text-active)]">
            {t('projects')}
          </span>
          {projectsExpanded ? (
            <ChevronDown className="w-3.5 h-3.5 opacity-60 transition-opacity" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 opacity-60 transition-opacity" />
          )}
        </button>

        {/* Action icons on right (Drag handle without title & Add Project button with Tooltip) */}
        <div className="flex items-center gap-1">
          {/* 6-dot drag handle - without any title tooltip */}
          <div
            onMouseDown={(e) => handleDragStart("projects", e)}
            className="p-1 opacity-25 hover:opacity-70 cursor-grab active:cursor-grabbing text-[var(--sidebar-text)] transition-opacity select-none"
          >
            <GripVertical className="w-3.5 h-3.5" />
          </div>

          {/* Add Project icon button with Radix Tooltip */}
          <Tooltip title={t('newProject')} side="top">
            <button
              type="button"
              onClick={handleAddProject}
              className="p-1 rounded-md text-[var(--sidebar-text)] hover:text-[var(--sidebar-text-active)] hover:bg-[var(--sidebar-hover)] transition-colors cursor-pointer"
            >
              <Plus className="w-4 h-4" />
            </button>
          </Tooltip>
        </div>
      </div>

      {projectsExpanded && (
        <div className="flex flex-col w-full px-1 py-0.5 space-y-0.5">
          {projects.length === 0 ? (
            <div className="px-3 py-1.5 text-[var(--sidebar-text)] opacity-50 text-xs">
              {t('noProjects')}
            </div>
          ) : (
            projects.map((project) => {
              const isOpen = !!openGroups[project.name];
              return (
                <div key={project.name} className="flex flex-col w-full">
                  <div className="flex items-center w-full px-3 py-1.5 text-[var(--sidebar-text)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)] transition-colors rounded-md group">
                    <button
                      type="button"
                      onClick={() => toggleGroup(project.name)}
                      className="flex items-center flex-1 min-w-0 text-left cursor-pointer outline-none select-none"
                    >
                      {isOpen ? (
                        <ChevronDown className="w-4 h-4 mr-1 opacity-70 shrink-0" />
                      ) : (
                        <ChevronRight className="w-4 h-4 mr-1 opacity-70 shrink-0" />
                      )}
                      {isOpen ? (
                        <FolderOpen className="w-4 h-4 mr-2 text-[var(--accent)] shrink-0" />
                      ) : (
                        <Folder className="w-4 h-4 mr-2 text-[var(--accent)] shrink-0" />
                      )}
                      <span className="truncate flex-1 text-left">{project.name}</span>
                    </button>

                    {/* Project action: New task within this project */}
                    <Tooltip title={t("newTask")} side="right">
                      <button
                        type="button"
                        onClick={(e) => handleCreateTask(e, project.name)}
                        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[var(--surface-hover)] text-[var(--sidebar-text)] hover:text-[var(--sidebar-text-active)] transition-all cursor-pointer shrink-0"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </Tooltip>
                  </div>

                  {isOpen && (
                    <div className="flex flex-col w-full pl-8 pr-3">
                      {project.children.map((child) => (
                        <button
                          key={child.name}
                          className="flex items-center justify-between w-full py-1.5 text-[var(--sidebar-text)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)] transition-colors rounded-md text-sm"
                        >
                          <span className="truncate mr-2 border-l border-[var(--border)] pl-2 -ml-2">
                            {child.name}
                          </span>
                          <span className="text-xs opacity-50 whitespace-nowrap">
                            {formatDays(child.daysAgo)}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );

  // Render Tasks Section JSX
  const renderTasksSection = () => (
    <div
      key="tasks"
      className={`flex flex-col w-full group/task-section transition-all duration-200 ${
        draggingSection === "tasks" ? "opacity-75 ring-1 ring-[var(--accent)] rounded-lg bg-[var(--sidebar-hover)]" : ""
      }`}
    >
      <div className="flex items-center justify-between h-7 px-3 py-1 text-[var(--sidebar-text)] hover:text-[var(--sidebar-text-active)] transition-colors">
        <button
          type="button"
          onClick={toggleTasks}
          className="flex items-center gap-1 min-w-0 text-left cursor-pointer outline-none select-none text-[var(--sidebar-text)] hover:text-[var(--sidebar-text-active)]"
        >
          <span className="text-sm font-medium text-[var(--sidebar-text-active)]">
            {t('tasks')}
          </span>
          {tasksExpanded ? (
            <ChevronDown className="w-3.5 h-3.5 opacity-60 transition-opacity" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 opacity-60 transition-opacity" />
          )}
        </button>

        {/* Action icons on right (Drag handle without title & New Task button with Tooltip) */}
        <div className="flex items-center gap-1">
          {/* 6-dot drag handle - without any title tooltip */}
          <div
            onMouseDown={(e) => handleDragStart("tasks", e)}
            className="p-1 opacity-25 hover:opacity-70 cursor-grab active:cursor-grabbing text-[var(--sidebar-text)] transition-opacity select-none"
          >
            <GripVertical className="w-3.5 h-3.5" />
          </div>

          {/* New Task icon button with Radix Tooltip */}
          <Tooltip title={t('newTask')} side="top">
            <button
              type="button"
              onClick={handleCreateTask}
              className="p-1 rounded-md text-[var(--sidebar-text)] hover:text-[var(--sidebar-text-active)] hover:bg-[var(--sidebar-hover)] transition-colors cursor-pointer"
            >
              <MessageSquarePlus className="w-4 h-4" />
            </button>
          </Tooltip>
        </div>
      </div>

      {tasksExpanded && (
        <div className="flex flex-col w-full px-1 py-0.5 space-y-0.5">
          {globalTasks.length === 0 ? (
            <div className="px-3 py-1.5 text-[var(--sidebar-text)] opacity-50 text-xs">
              {t('noTasks')}
            </div>
          ) : (
            globalTasks.map((task) => {
              const isActive = activeTaskId === task.id;
              const isRenaming = renamingTaskId === task.id;

              if (isRenaming) {
                return (
                  <div
                    key={task.id}
                    className="flex items-center gap-1 w-full px-2 py-1 rounded-md bg-[var(--sidebar-hover)] border border-[var(--brand)]"
                  >
                    <input
                      ref={renameInputRef}
                      type="text"
                      value={renameDraftTitle}
                      onChange={(e) => setRenameDraftTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleSaveRename(task.id);
                        } else if (e.key === "Escape") {
                          setRenamingTaskId(null);
                        }
                      }}
                      onBlur={() => handleSaveRename(task.id)}
                      className="flex-1 bg-transparent text-sm text-[var(--sidebar-text-active)] outline-none min-w-0"
                    />
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handleSaveRename(task.id);
                      }}
                      className="p-1 rounded text-emerald-500 hover:bg-[var(--surface-hover)]"
                      title={t("save")}
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setRenamingTaskId(null);
                      }}
                      className="p-1 rounded text-[var(--sidebar-text)] hover:text-red-500"
                      title={t("cancel")}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              }

              const isConfirmingDelete = pendingDeleteTaskId === task.id;
              const isPinned = !!task.pinned;

              return (
                <div
                  key={task.id}
                  onClick={() => setActiveTaskId(task.id)}
                  className={`flex items-center justify-between w-full px-2.5 py-1.5 rounded-md transition-colors text-base text-left group cursor-pointer ${
                    isActive
                      ? 'bg-[var(--sidebar-hover)] text-[var(--sidebar-text-active)] font-medium'
                      : 'text-[var(--sidebar-text-active)] hover:bg-[var(--sidebar-hover)]'
                  }`}
                >
                  {/* Left: Pin Button (hover or when pinned) */}
                  <div className="flex items-center shrink-0 mr-1.5">
                    <Tooltip title={isPinned ? t("unpin") : t("pin")} side="top">
                      <button
                        type="button"
                        onClick={(e) => handleTogglePinTask(e, task.id)}
                        className={`p-1 rounded transition-colors ${
                          isPinned
                            ? 'text-[var(--brand)] opacity-90 hover:opacity-100'
                            : 'opacity-0 group-hover:opacity-60 hover:!opacity-100 text-[var(--sidebar-text)] hover:text-[var(--sidebar-text-active)]'
                        }`}
                      >
                        <Pin
                          className={`w-3.5 h-3.5 transition-transform ${
                            isPinned ? 'rotate-45 fill-current' : ''
                          }`}
                        />
                      </button>
                    </Tooltip>
                  </div>

                  <span className="truncate flex-1 mr-2 text-[15px]">{task.title}</span>

                  {/* Right side: Time display + Hover Action buttons (Rename & Delete/Confirm) */}
                  <div className="flex items-center gap-1 shrink-0">
                    {/* Time display: hide when hovering or when confirming delete */}
                    {!isConfirmingDelete && (
                      <span className="text-sm opacity-55 whitespace-nowrap group-hover:hidden">
                        {formatRelativeTime(task.createdAt, locale)}
                      </span>
                    )}

                    {/* When in inline confirm delete state (ZCode style red confirm capsule) */}
                    {isConfirmingDelete ? (
                      <div className="flex items-center gap-1" data-delete-confirm-btn="true">
                        <button
                          type="button"
                          onClick={(e) => handleDeleteTaskClick(e, task.id)}
                          className="px-2.5 py-0.5 rounded-md text-xs font-medium bg-red-500 hover:bg-red-600 text-white shadow-sm transition-all"
                        >
                          {t("confirm")}
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPendingDeleteTaskId(null);
                          }}
                          className="p-1 rounded text-[var(--sidebar-text)] hover:text-[var(--sidebar-text-active)] hover:bg-[var(--surface-hover)] transition-colors"
                          title={t("cancel")}
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      /* Hover buttons: Rename & Trash */
                      <div className="hidden group-hover:flex items-center gap-0.5">
                        <Tooltip title={t("rename")} side="top">
                          <button
                            type="button"
                            onClick={(e) => handleStartRename(e, task)}
                            className="p-1 rounded hover:bg-[var(--surface-hover)] text-[var(--sidebar-text)] hover:text-[var(--sidebar-text-active)] transition-colors"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                        </Tooltip>

                        <Tooltip title={t("delete")} side="top">
                          <button
                            type="button"
                            onClick={(e) => handleDeleteTaskClick(e, task.id)}
                            className="p-1 rounded hover:bg-red-500/15 text-[var(--sidebar-text)] hover:text-red-500 transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </Tooltip>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-2 w-full text-sm">
      {sectionOrder.map((sec) =>
        sec === "projects" ? renderProjectsSection() : renderTasksSection()
      )}
    </div>
  );
}
