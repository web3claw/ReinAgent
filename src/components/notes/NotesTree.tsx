import React, { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Trash2,
  Edit2,
  FilePlus,
  FolderPlus,
  FolderSearch,
} from "lucide-react";
import { useTranslation } from "../../i18n";
import type { NotebookFolder, NoteFileItem } from "./notesService";

interface NotesTreeProps {
  notebooks: NotebookFolder[];
  notesMap: Record<string, NoteFileItem[]>;
  selectedNoteId?: string;
  selectedNotebookPath: string;
  searchTerm: string;
  onSelectNote: (note: NoteFileItem) => void;
  onSelectNotebook: (path: string) => void;
  onOpenFolder?: (path: string) => void;
  onCreateNote: (notebookRelPath: string) => void;
  onCreateFolder: (parentRelPath: string | null) => void;
  onRenameNote: (note: NoteFileItem) => void;
  onDeleteNote: (note: NoteFileItem) => void;
  onRenameFolder: (folder: NotebookFolder) => void;
  onDeleteFolder: (folder: NotebookFolder) => void;
}

export function NotesTree({
  notebooks,
  notesMap,
  selectedNoteId,
  selectedNotebookPath,
  searchTerm,
  onSelectNote,
  onSelectNotebook,
  onOpenFolder,
  onCreateNote,
  onCreateFolder,
  onRenameNote,
  onDeleteNote,
  onRenameFolder,
  onDeleteFolder,
}: NotesTreeProps) {
  const { t } = useTranslation();
  // 记录各文件夹的展开/折叠状态（默认展开）
  const [collapsedPaths, setCollapsedPaths] = useState<Record<string, boolean>>({});

  const toggleExpand = (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setCollapsedPaths((prev) => ({
      ...prev,
      [path]: !prev[path],
    }));
  };

  const isCollapsed = (path: string) => !!collapsedPaths[path];

  // 递归渲染文件夹节点及其包含的笔记与子文件夹
  const renderFolderNode = (folder: NotebookFolder, depth = 0): React.ReactNode => {
    const collapsed = isCollapsed(folder.relativePath);
    const folderNotes = notesMap[folder.relativePath] || [];
    const isSelected = selectedNotebookPath === folder.relativePath;

    // 搜索过滤逻辑
    const q = searchTerm.trim().toLowerCase();
    const filteredNotes = q
      ? folderNotes.filter(
          (n) =>
            n.title.toLowerCase().includes(q) ||
            n.fileName.toLowerCase().includes(q) ||
            n.snippet.toLowerCase().includes(q)
        )
      : folderNotes;

    const folderMatches = q ? folder.name.toLowerCase().includes(q) : false;

    // 若有搜索词且当前文件夹名和内部笔记均无匹配，且子文件夹也无匹配，则跳过
    if (q && !folderMatches && filteredNotes.length === 0 && (!folder.children || folder.children.length === 0)) {
      return null;
    }

    const displayName =
      folder.name === "default" ? t("defaultNotebookName") : folder.name;

    return (
      <div key={folder.relativePath} className="select-none">
        {/* 文件夹行 */}
        <div
          onClick={() => onSelectNotebook(folder.relativePath)}
          className={`group flex items-center justify-between py-1 px-1.5 rounded-lg cursor-pointer transition-colors text-xs font-medium ${
            isSelected
              ? "bg-[var(--surface-hover)] text-[var(--text)]"
              : "text-[var(--text)] hover:bg-[var(--surface-hover)]"
          }`}
          style={{ paddingLeft: `${4 + depth * 14}px` }}
        >
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            {/* 折叠/展开箭头 */}
            <button
              type="button"
              onClick={(e) => toggleExpand(folder.relativePath, e)}
              className="p-0.5 rounded hover:bg-white/10 text-[var(--text-dim)] hover:text-[var(--text)] transition-colors"
            >
              {collapsed ? (
                <ChevronRight className="w-3.5 h-3.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
            </button>

            {/* 蓝色线框文件夹图标 */}
            {collapsed ? (
              <Folder className="w-4 h-4 text-blue-500 shrink-0 stroke-[1.8]" />
            ) : (
              <FolderOpen className="w-4 h-4 text-blue-500 shrink-0 stroke-[1.8]" />
            )}

            {/* 文件夹名称 */}
            <span className="truncate text-[13px]">{displayName}</span>
          </div>

          {/* 悬停快捷操作：在系统文件管理器中打开 / 新建笔记 / 新建子文件夹 / 重命名 / 删除 */}
          <div className="hidden group-hover:flex items-center gap-0.5 shrink-0 opacity-80 hover:opacity-100">
            {onOpenFolder && (
              <button
                type="button"
                title="在系统文件管理器中打开"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenFolder(folder.relativePath);
                }}
                className="p-1 rounded text-[var(--text-dim)] hover:text-blue-400 hover:bg-white/10"
              >
                <FolderSearch className="w-3 h-3" />
              </button>
            )}
            <button
              type="button"
              title="在此文件夹新建笔记"
              onClick={(e) => {
                e.stopPropagation();
                onCreateNote(folder.relativePath);
              }}
              className="p-1 rounded text-[var(--text-dim)] hover:text-blue-400 hover:bg-white/10"
            >
              <FilePlus className="w-3 h-3" />
            </button>
            <button
              type="button"
              title="新建子文件夹"
              onClick={(e) => {
                e.stopPropagation();
                onCreateFolder(folder.relativePath);
              }}
              className="p-1 rounded text-[var(--text-dim)] hover:text-blue-400 hover:bg-white/10"
            >
              <FolderPlus className="w-3 h-3" />
            </button>
            {folder.name !== "default" && (
              <>
                <button
                  type="button"
                  title="重命名文件夹"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRenameFolder(folder);
                  }}
                  className="p-1 rounded text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-white/10"
                >
                  <Edit2 className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  title="删除文件夹"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteFolder(folder);
                  }}
                  className="p-1 rounded text-[var(--text-dim)] hover:text-red-400 hover:bg-red-500/10"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </>
            )}
          </div>
        </div>

        {/* 展开内容：笔记列表与子文件夹 */}
        {!collapsed && (
          <div className="relative">
            {/* 子笔记列表 */}
            {filteredNotes.map((note) => {
              const isNoteSelected = selectedNoteId === note.id;
              return (
                <div
                  key={note.id}
                  onClick={() => onSelectNote(note)}
                  className={`group relative flex items-center justify-between py-1 px-1.5 my-0.5 rounded-lg cursor-pointer transition-colors text-xs ${
                    isNoteSelected
                      ? "bg-blue-600/15 text-blue-400 font-medium"
                      : "text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)]"
                  }`}
                  style={{ paddingLeft: `${50 + depth * 16}px` }}
                >
                  {/* 左侧垂直层级指引对齐线（正对父级文件夹图标中心下方） */}
                  <div
                    className="absolute top-0 bottom-0 w-[1px] bg-white/15"
                    style={{ left: `${36 + depth * 16}px` }}
                  />

                  {/* 笔记标题（与上方文件夹文字完美垂直对齐） */}
                  <span className="truncate flex-1 text-[13px]">
                    {note.title || t("untitledNote")}
                  </span>

                  {/* 悬停操作：重命名 / 删除 */}
                  <div className="hidden group-hover:flex items-center gap-0.5 shrink-0 ml-1">
                    <button
                      type="button"
                      title="重命名笔记"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRenameNote(note);
                      }}
                      className="p-1 rounded text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-white/10"
                    >
                      <Edit2 className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      title="删除笔记"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteNote(note);
                      }}
                      className="p-1 rounded text-[var(--text-dim)] hover:text-red-400 hover:bg-red-500/10"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              );
            })}

            {/* 递归渲染子文件夹 */}
            {folder.children &&
              folder.children.map((child) => renderFolderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex-1 overflow-y-auto space-y-0.5 pr-1">
      {notebooks.length === 0 ? (
        <div className="text-center py-8 text-xs text-[var(--text-dim)]">
          {t("emptyNotes")}
        </div>
      ) : (
        notebooks.map((nb) => renderFolderNode(nb, 0))
      )}
    </div>
  );
}
