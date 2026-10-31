import { useState, useEffect, useCallback } from "react";
import {
  LayoutDashboard,
  Clock,
  Box,
  Maximize2,
  Minimize2,
  PanelRightClose,
  FolderOpen,
  RotateCw,
  FileText,
  FileCode,
  File,
  ArrowRight,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Terminal,
  Trash2,
} from "lucide-react";
import { useAppStore, type AppTask } from "../../store/useAppStore";
import { useTranslation } from "../../i18n";
import { ReinBotBadge } from "./ReinBotBadge";
import { getTaskExecutionStatus, subscribeStreaming } from "../../lib/chat/conversationPool";
import { isReinBotTask } from "../../lib/reinbot/reinBotTools";
import { toast } from "../lw/ui/toast";

export interface ReinBotWorkspaceProps {
  workspaceRoot?: string;
  onToggleCollapse?: () => void;
  isCollapsed?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  onOpenTask?: (task: AppTask) => void;
  onOpenFile?: (fileName: string, fullPath: string) => void;
  onCloseTaskTab?: (taskId: string) => void;
  onCloseFileTab?: (fileName: string) => void;
  hideHeader?: boolean;
}

export function ReinBotWorkspace({
  workspaceRoot: initialWorkspaceRoot,
  onToggleCollapse,
  isCollapsed: _isCollapsed,
  isExpanded = false,
  onToggleExpand,
  onOpenTask,
  onOpenFile,
  onCloseTaskTab,
  onCloseFileTab,
  hideHeader = false,
}: ReinBotWorkspaceProps) {
  const { reinBotName, tasks, setActiveTaskId, setCurrentView, deleteTask } = useAppStore();
  const { t } = useTranslation();

  // 产物目录锁定在 ~/.ReinAgent/ReinBot
  const workspaceRoot = initialWorkspaceRoot || "";

  // 工作产物列表扫描
  const [artifacts, setArtifacts] = useState<string[]>([]);
  const [isLoadingArtifacts, setIsLoadingArtifacts] = useState(false);

  const refreshArtifacts = useCallback(async () => {
    if (!workspaceRoot) return;
    setIsLoadingArtifacts(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const list = await invoke<string[]>("fs_list_dir", { path: workspaceRoot });
      // 过滤隐藏文件与临时隐藏目录
      const filtered = (list || []).filter(
        (name) => !name.startsWith(".") && name !== "target" && name !== "node_modules",
      );
      setArtifacts(filtered);
    } catch (err) {
      console.warn("[ReinBotWorkspace] fs_list_dir failed:", err);
      setArtifacts([]);
    } finally {
      setIsLoadingArtifacts(false);
    }
  }, [workspaceRoot]);

  useEffect(() => {
    void refreshArtifacts();
  }, [refreshArtifacts]);

  // 打开文件或产物目录
  const handleOpenFolder = async (path?: string) => {
    const target = path || workspaceRoot;
    if (!target) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_in_file_manager", { path: target });
    } catch (err) {
      console.warn("[ReinBotWorkspace] open_in_file_manager failed:", err);
    }
  };

  // 一键删除任务（同步销毁会话与检查点）
  const handleDeleteTask = (e: React.MouseEvent, task: AppTask) => {
    e.stopPropagation();
    deleteTask(task.id);
    onCloseTaskTab?.(task.id);
    toast.success(`已删除任务: ${task.title || "未命名任务"}`);
  };

  // 一键删除工作产物（物理删除文件并刷新）
  const handleDeleteArtifact = async (e: React.MouseEvent, fileName: string, fullPath: string) => {
    e.stopPropagation();
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("fs_remove_entry", {
        path: fullPath,
        workspaceRoot: workspaceRoot || "",
        checkpoint: null,
      });
      toast.success(`已删除产物: ${fileName}`);
      onCloseFileTab?.(fileName);
      await refreshArtifacts();
    } catch (err) {
      console.warn("[ReinBotWorkspace] failed to delete artifact via fs_remove_entry:", err);
      // 非桌面环境兜底过滤
      setArtifacts((prev) => prev.filter((name) => name !== fileName));
      onCloseFileTab?.(fileName);
      toast.success(`已删除产物: ${fileName}`);
    }
  };

  const getFileIcon = (fileName: string) => {
    const lower = fileName.toLowerCase();
    if (lower.endsWith(".md") || lower.endsWith(".txt") || lower.endsWith(".doc")) {
      return <FileText className="w-4 h-4 text-[var(--brand)]" />;
    }
    if (
      lower.endsWith(".ts") ||
      lower.endsWith(".tsx") ||
      lower.endsWith(".js") ||
      lower.endsWith(".json") ||
      lower.endsWith(".py") ||
      lower.endsWith(".rs") ||
      lower.endsWith(".sh")
    ) {
      return <FileCode className="w-4 h-4 text-emerald-500" />;
    }
    return <File className="w-4 h-4 text-[var(--text-muted)]" />;
  };

  const [, setStreamingTick] = useState(0);
  useEffect(() => {
    return subscribeStreaming(() => setStreamingTick((t) => t + 1));
  }, []);

  const recentTasks = (tasks || []).filter(isReinBotTask).slice(0, 10);

  return (
    <div className="flex flex-col h-full w-full bg-[var(--surface)] border-l border-[var(--border)] overflow-hidden transition-all duration-200">
      {/* 顶部标题栏（若外层使用多标签页 header 则可隐藏内部标题） */}
      {!hideHeader && (
        <div className="flex items-center justify-between h-10 px-3 bg-[var(--bg-sunken)] border-b border-[var(--border)] select-none">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text)]">
            <div className="flex items-center justify-center w-5 h-5 rounded-md bg-[var(--surface)] border border-[var(--border)] text-[var(--brand)] shadow-xs">
              <LayoutDashboard className="w-3.5 h-3.5" />
            </div>
            <span>
              {reinBotName}
              {t("reinbotWorkspaceTab")}
            </span>
          </div>

          {/* 右侧操作按钮 */}
          <div className="flex items-center gap-1 text-[var(--text-muted)]">
            {onToggleExpand && (
              <button
                type="button"
                onClick={onToggleExpand}
                title={isExpanded ? "还原分屏" : "放大至侧边栏"}
                className="p-1.5 rounded hover:text-[var(--text)] hover:bg-[var(--surface)] transition-colors cursor-pointer"
              >
                {isExpanded ? (
                  <Minimize2 className="w-3.5 h-3.5" />
                ) : (
                  <Maximize2 className="w-3.5 h-3.5" />
                )}
              </button>
            )}
            {onToggleCollapse && !isExpanded && (
              <button
                type="button"
                onClick={onToggleCollapse}
                title="收起面板"
                className="p-1.5 rounded hover:text-[var(--text)] hover:bg-[var(--surface)] transition-colors cursor-pointer"
              >
                <PanelRightClose className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* 内容区域：工牌 + 最近任务 + 工作产物 */}
      <div className="flex-1 overflow-y-auto divide-y divide-[var(--border)]">
        {/* 1. 顶部工牌 */}
        <ReinBotBadge />

        {/* 2. 最近任务模块 */}
        <div className="px-5 py-6">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
              {t("reinbotRecentTasks")}
            </h4>
            <span className="text-[11px] font-mono text-[var(--text-muted)]">
              {recentTasks.length} 个任务
            </span>
          </div>

          {recentTasks.length === 0 ? (
            /* 空态 */
            <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
              <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-[var(--bg-sunken)] border border-[var(--border)] text-[var(--text-muted)] mb-3 shadow-inner">
                <Clock className="w-5 h-5 opacity-70" />
              </div>
              <p className="text-sm font-medium text-[var(--text)]">{t("reinbotNoTasks")}</p>
              <p className="text-xs text-[var(--text-muted)] mt-1">{t("reinbotNoTasksDesc")}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {recentTasks.map((task) => {
                const status = getTaskExecutionStatus(task.id);
                return (
                  <div
                    key={task.id}
                    onClick={() => {
                      if (onOpenTask) {
                        onOpenTask(task);
                      } else {
                        setActiveTaskId(task.id);
                        setCurrentView("workbench");
                      }
                    }}
                    className="flex items-center justify-between w-full p-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--bg-sunken)] hover:border-[var(--brand)]/30 transition-all text-left cursor-pointer group shadow-2xs"
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      {status === "running" ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--brand)] shrink-0" />
                      ) : status === "done" ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                      ) : status === "error" ? (
                        <AlertCircle className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                      ) : (
                        <Terminal className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium text-[var(--text)] truncate group-hover:text-[var(--brand)] transition-colors">
                          {task.title || "未命名任务"}
                        </div>
                        <div className="text-[10px] text-[var(--text-muted)] truncate">
                          {task.project || "~/.ReinAgent/ReinBot"}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0 ml-2">
                      <button
                        type="button"
                        onClick={(e) => handleDeleteTask(e, task)}
                        className="p-1 rounded hover:bg-rose-500/10 text-[var(--text-muted)] hover:text-rose-500 transition-colors cursor-pointer opacity-70 group-hover:opacity-100"
                        title="删除任务"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                      <ArrowRight className="w-3.5 h-3.5 text-[var(--text-muted)] group-hover:translate-x-0.5 group-hover:text-[var(--brand)] transition-all" />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 3. 工作产物模块（~/.ReinAgent/ReinBot） */}
        <div className="px-5 py-6">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
              {t("reinbotArtifacts")}
            </h4>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void refreshArtifacts()}
                disabled={isLoadingArtifacts}
                title="刷新产物列表"
                className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-sunken)] transition-colors cursor-pointer"
              >
                <RotateCw
                  className={`w-3.5 h-3.5 ${isLoadingArtifacts ? "animate-spin" : ""}`}
                />
              </button>
              <button
                type="button"
                onClick={() => void handleOpenFolder()}
                title="在系统文件管理器中打开 ReinBot 产物目录"
                className="flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-[var(--brand)] bg-[var(--brand)]/10 hover:bg-[var(--brand)]/20 rounded-md transition-colors cursor-pointer"
              >
                <FolderOpen className="w-3 h-3" />
                <span>产物目录</span>
              </button>
            </div>
          </div>

          {/* 路径提示 */}
          <div className="mb-3 px-2.5 py-1.5 rounded-lg bg-[var(--bg-sunken)] border border-[var(--border)] text-[10px] text-[var(--text-muted)] font-mono truncate">
            {workspaceRoot || "~/.ReinAgent/ReinBot"}
          </div>

          {artifacts.length === 0 ? (
            /* 空态 */
            <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
              <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-[var(--bg-sunken)] border border-[var(--border)] text-[var(--text-muted)] mb-3 shadow-inner">
                <Box className="w-5 h-5 opacity-70" />
              </div>
              <p className="text-sm font-medium text-[var(--text)]">{t("reinbotNoArtifacts")}</p>
              <p className="text-xs text-[var(--text-muted)] mt-1">
                ReinBot 生成的文件将保存在产物目录并在此处显示
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {artifacts.map((fileName) => {
                const fullPath = `${workspaceRoot}/${fileName}`;
                return (
                  <div
                    key={fileName}
                    onClick={() => {
                      if (onOpenFile) {
                        onOpenFile(fileName, fullPath);
                      } else {
                        void handleOpenFolder(workspaceRoot);
                      }
                    }}
                    className="flex items-center justify-between p-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--bg-sunken)] hover:border-[var(--brand)]/30 transition-all cursor-pointer group text-left"
                    title={`点击在右侧新建标签页预览: ${fileName}`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {getFileIcon(fileName)}
                      <span className="text-xs font-mono text-[var(--text)] truncate group-hover:text-[var(--brand)] transition-colors">
                        {fileName}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0 ml-2">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleOpenFolder(workspaceRoot);
                        }}
                        className="p-1 rounded hover:bg-[var(--surface-hover)] text-[var(--text-muted)] hover:text-[var(--brand)] transition-colors cursor-pointer"
                        title="在系统文件管理器中打开此文件夹"
                      >
                        <FolderOpen className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => void handleDeleteArtifact(e, fileName, fullPath)}
                        className="p-1 rounded hover:bg-rose-500/10 text-[var(--text-muted)] hover:text-rose-500 transition-colors cursor-pointer opacity-70 group-hover:opacity-100"
                        title="删除此产物"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
