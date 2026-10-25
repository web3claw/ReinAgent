import { useState, useEffect, useCallback, useMemo } from "react";
import { Search, Plus, FolderPlus, Trash2 } from "lucide-react";
import { NotesTree } from "./NotesTree";
import { NoteTrashPanel } from "./NoteEnhancePanels";
import { noteMatchesSearch } from "./noteEnhance";
import { NoteEditor } from "./NoteEditor";
import {
  notesService,
  type NotebookFolder,
  type NoteFileItem,
} from "./notesService";
import { useTranslation } from "../../i18n";

export function NotesPage({
  initialSelectedNote,
}: {
  initialSelectedNote?: NoteFileItem | null;
} = {}) {
  const { t } = useTranslation();
  const [notebooks, setNotebooks] = useState<NotebookFolder[]>([]);
  const [notesMap, setNotesMap] = useState<Record<string, NoteFileItem[]>>({});
  const [selectedNotebookPath, setSelectedNotebookPath] = useState<string>("default");
  const [selectedNote, setSelectedNote] = useState<NoteFileItem | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  // 笔记增强包（ROADMAP ④）：全量标签映射（tag: 搜索与编辑条共享）与回收站面板
  const [allTags, setAllTags] = useState<Record<string, string[]>>({});
  const [trashOpen, setTrashOpen] = useState(false);

  useEffect(() => {
    if (initialSelectedNote) {
      setSelectedNotebookPath(initialSelectedNote.notebookRelPath);
      setSelectedNote(initialSelectedNote);
    }
  }, [initialSelectedNote]);

  // 加载单文件夹笔记
  const loadNotesForFolder = useCallback(async (path: string) => {
    try {
      const items = await notesService.listNotes(path);
      setNotesMap((prev) => ({
        ...prev,
        [path]: items,
      }));
      return items;
    } catch (err) {
      console.error(`Failed to load notes for ${path}:`, err);
      return [];
    }
  }, []);

  // 递归加载所有文件夹下的笔记
  const reloadAllNotes = useCallback(async (tree: NotebookFolder[]) => {
    const flattenPaths: string[] = [];
    const traverse = (folders: NotebookFolder[]) => {
      for (const f of folders) {
        flattenPaths.push(f.relativePath);
        if (f.children && f.children.length > 0) {
          traverse(f.children);
        }
      }
    };
    traverse(tree);

    const map: Record<string, NoteFileItem[]> = {};
    for (const p of flattenPaths) {
      try {
        const items = await notesService.listNotes(p);
        map[p] = items;
      } catch (e) {
        map[p] = [];
      }
    }
    setNotesMap(map);
    return map;
  }, []);

  // 初始化加载笔记本树与全部笔记
  const reloadAll = useCallback(async () => {
    try {
      await notesService.ensureRoot();
      const tree = await notesService.listNotebooks();
      setNotebooks(tree);
      const map = await reloadAllNotes(tree);

      // 保持当前选中的笔记或者选中默认笔记本下的第一篇
      setSelectedNote((prev) => {
        if (prev) {
          const list = map[prev.notebookRelPath] || [];
          const exists = list.find((it) => it.id === prev.id);
          if (exists) return exists;
        }
        const defaultList = map["default"] || [];
        return defaultList[0] || null;
      });
    } catch (err) {
      console.error("Failed to reload notes page:", err);
    }
  }, [reloadAllNotes]);

  useEffect(() => {
    reloadAll();
  }, [reloadAll]);

  // 创建新文件夹（笔记本）
  const handleCreateFolder = async (parentPath: string | null = null) => {
    const targetParent = parentPath || (selectedNotebookPath === "default" ? null : selectedNotebookPath);
    const name = window.prompt(t("newNotebookPlaceholder"), "");
    if (!name || !name.trim()) return;
    try {
      await notesService.createNotebook(targetParent, name.trim());
      await reloadAll();
      const newPath = targetParent ? `${targetParent}/${name.trim()}` : name.trim();
      setSelectedNotebookPath(newPath);
    } catch (err) {
      alert(`创建文件夹失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // 创建新笔记
  const handleCreateNote = async (notebookRelPath?: string) => {
    const targetFolder = notebookRelPath || selectedNotebookPath || "default";
    try {
      const created = await notesService.createNote(targetFolder);
      await loadNotesForFolder(targetFolder);
      setSelectedNotebookPath(targetFolder);
      setSelectedNote(created);
    } catch (err) {
      console.error("Failed to create note:", err);
    }
  };

  // 重命名文件夹
  const handleRenameFolder = async (folder: NotebookFolder) => {
    const newName = window.prompt("请输入新的文件夹名称:", folder.name);
    if (!newName || newName.trim() === folder.name) return;
    try {
      await notesService.renameNotebook(folder.relativePath, newName.trim());
      await reloadAll();
    } catch (err) {
      alert(`重命名文件夹失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // 删除文件夹
  const handleDeleteFolder = async (folder: NotebookFolder) => {
    const ok = window.confirm(t("deleteNotebookConfirm").replace("{name}", folder.name));
    if (!ok) return;
    try {
      await notesService.deleteNotebook(folder.relativePath);
      if (selectedNotebookPath === folder.relativePath) {
        setSelectedNotebookPath("default");
      }
      await reloadAll();
    } catch (err) {
      alert(`删除文件夹失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // 重命名笔记
  const handleRenameNote = async (note: NoteFileItem) => {
    const newTitle = window.prompt("请输入新的笔记标题:", note.title);
    if (!newTitle || newTitle.trim() === note.title) return;
    try {
      const updated = await notesService.renameNote(note.notebookRelPath, note.fileName, newTitle.trim());
      await loadNotesForFolder(note.notebookRelPath);
      if (selectedNote?.id === note.id) {
        setSelectedNote(updated);
      }
    } catch (err) {
      alert(`重命名失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const refreshTags = () => {
    void notesService.allTags().then(setAllTags).catch(() => {});
  };
  useEffect(() => {
    refreshTags();
  }, []);

  // 删除笔记 → 回收站（ROADMAP ④：文案与语义改为移入回收站）
  const handleDeleteNote = async (note: NoteFileItem) => {
    const ok = window.confirm(`${t("deleteNoteConfirm").replace("{title}", note.title)}\n${t("notesDeleteToTrashConfirm")}`);
    if (!ok) return;
    try {
      await notesService.deleteNote(note.notebookRelPath, note.fileName);
      await loadNotesForFolder(note.notebookRelPath);
      refreshTags();
      if (selectedNote?.id === note.id) {
        setSelectedNote(null);
      }
    } catch (err) {
      alert(`删除失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // 编辑器正文保存
  const handleSaveContent = async (newContent: string, source?: string) => {
    if (!selectedNote) return;
    await notesService.saveNote(selectedNote.notebookRelPath, selectedNote.fileName, newContent, source);
    // 更新本地内存中的 snippet
    setNotesMap((prev) => {
      const folderList = prev[selectedNote.notebookRelPath] || [];
      return {
        ...prev,
        [selectedNote.notebookRelPath]: folderList.map((n) =>
          n.id === selectedNote.id
            ? {
                ...n,
                snippet: newContent.slice(0, 150).replace(/\n/g, " "),
                updatedAt: Date.now(),
              }
            : n
        ),
      };
    });
  };

  // 编辑器标题失焦修改
  const handleRenameTitleFromEditor = async (newTitle: string) => {
    if (!selectedNote) return;
    const updated = await notesService.renameNote(
      selectedNote.notebookRelPath,
      selectedNote.fileName,
      newTitle
    );
    await loadNotesForFolder(selectedNote.notebookRelPath);
    setSelectedNote(updated);
  };

  return (
    <div className="flex w-full h-full overflow-hidden bg-[var(--bg)]">
      {/* 左栏：文件树与快捷操作栏 */}
      <div className="w-80 shrink-0 border-r border-[var(--border)] flex flex-col h-full p-2.5 bg-[var(--sidebar-bg)]">
        {/* 顶部操作行：搜索框 + 新建笔记 + 新建文件夹 */}
        <div className="flex items-center gap-1.5 mb-2.5">
          <div className="relative flex-1 min-w-0">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-dim)]" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="搜索..."
              className="w-full bg-[var(--bg-elev-2)] border border-[var(--border)] rounded-lg pl-8 pr-2 py-1 text-xs text-[var(--text)] outline-hidden focus:border-blue-500 transition-colors placeholder:text-[var(--text-dim)]"
            />
          </div>
          <button
            type="button"
            onClick={() => handleCreateNote()}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg bg-[var(--bg-elev-2)] hover:bg-[var(--surface-hover)] border border-[var(--border)] text-[var(--text)] transition-all shrink-0 cursor-pointer shadow-xs active:scale-95"
            title="新建笔记"
          >
            <Plus className="w-3.5 h-3.5 text-blue-400" />
            <span>笔记</span>
          </button>
          <button
            type="button"
            onClick={() => handleCreateFolder(null)}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg bg-[var(--bg-elev-2)] hover:bg-[var(--surface-hover)] border border-[var(--border)] text-[var(--text)] transition-all shrink-0 cursor-pointer shadow-xs active:scale-95"
            title="新建文件夹"
          >
            <FolderPlus className="w-3.5 h-3.5 text-blue-400" />
            <span>文件夹</span>
          </button>
          <button
            type="button"
            onClick={() => setTrashOpen(true)}
            className="flex items-center px-2 py-1 text-xs font-medium rounded-lg bg-[var(--bg-elev-2)] hover:bg-[var(--surface-hover)] border border-[var(--border)] text-[var(--text)] transition-all shrink-0 cursor-pointer shadow-xs active:scale-95"
            title={t("notesTrashTitle")}
          >
            <Trash2 className="w-3.5 h-3.5 text-amber-500" />
          </button>
        </div>

        {/* 树形列表视图 */}
        <NotesTree
          notebooks={notebooks}
          notesMap={useMemo(() => {
            if (!searchTerm.trim()) return notesMap;
            const out: Record<string, NoteFileItem[]> = {};
            for (const [rel, list] of Object.entries(notesMap)) {
              const kept = list.filter((n) => noteMatchesSearch(n, allTags[n.id], searchTerm));
              if (kept.length) out[rel] = kept;
            }
            return out;
          }, [notesMap, searchTerm, allTags])}
          selectedNoteId={selectedNote?.id}
          selectedNotebookPath={selectedNotebookPath}
          searchTerm={searchTerm}
          onSelectNote={(note) => {
            setSelectedNote(note);
            setSelectedNotebookPath(note.notebookRelPath);
          }}
          onSelectNotebook={(path) => setSelectedNotebookPath(path)}
          onCreateNote={handleCreateNote}
          onCreateFolder={handleCreateFolder}
          onOpenFolder={(path) => void notesService.openNotebookFolder(path)}
          onRenameNote={handleRenameNote}
          onDeleteNote={handleDeleteNote}
          onRenameFolder={handleRenameFolder}
          onDeleteFolder={handleDeleteFolder}
        />
      </div>

      {/* 右栏：Markdown 所见即所得编辑器 */}
      <div className="flex-1 min-w-0 h-full">
        <NoteEditor
          note={selectedNote}
          onSaveContent={handleSaveContent}
          onRenameTitle={handleRenameTitleFromEditor}
          allTags={allTags}
          onTagsChanged={refreshTags}
        />
      </div>
      {trashOpen ? (
        <NoteTrashPanel
          onRestored={() => {
            void reloadAll();
            refreshTags();
          }}
          onClose={() => setTrashOpen(false)}
        />
      ) : null}
    </div>
  );
}

