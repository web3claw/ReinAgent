/**
 * notesService.ts —— 笔记与笔记本 IPC 通信及 Web Mock 兼容层
 */

import { invoke } from "@tauri-apps/api/core";
import { scheduleKnowledgeIndex } from "../../lib/knowledge/autoIndex";

export interface NotebookFolder {
  id: string;
  name: string;
  relativePath: string;
  fullPath: string;
  children: NotebookFolder[];
}

export interface NoteFileItem {
  id: string;
  title: string;
  fileName: string;
  notebookRelPath: string;
  fullPath: string;
  snippet: string;
  updatedAt: number;
  createdAt: number;
  sizeBytes: number;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Web Mock 本地内存存储（用于浏览器端调试及回归测试）
let mockNotebooks: NotebookFolder[] = [
  {
    id: "default",
    name: "default",
    relativePath: "default",
    fullPath: "/mock/notebooks/default",
    children: [],
  },
];

let mockNotes: Record<string, { item: NoteFileItem; content: string }[]> = {
  default: [
    {
      item: {
        id: "default:welcome.md",
        title: "Welcome to ReinAgent Notes",
        fileName: "welcome.md",
        notebookRelPath: "default",
        fullPath: "/mock/notebooks/default/welcome.md",
        snippet: "这是你的默认笔记本。支持 Markdown 编辑、分栏与实时预览。",
        updatedAt: Date.now(),
        createdAt: Date.now(),
        sizeBytes: 120,
      },
      content:
        "# Welcome to ReinAgent Notes\n\n- 这是你的默认笔记本。\n- 支持 Markdown 编辑、分栏与实时预览。\n- 每个笔记本都是一个文件夹，每篇笔记都是一个 `.md` 文档。\n",
    },
  ],
};

export interface NoteVersionRow {
  id: number;
  noteId: string;
  source: string;
  savedAt: number;
  preview: string;
}

export interface NoteVersionContent {
  id: number;
  noteId: string;
  content: string;
}

export interface NoteTrashRow {
  id: number;
  originalNotebookRel: string;
  originalFileName: string;
  wasNotebook: boolean;
  deletedAt: number;
  preview: string;
}

export const notesService = {
  /** 确保根目录及 default 存在 */
  async ensureRoot(): Promise<NotebookFolder> {
    if (isTauri) {
      return invoke<NotebookFolder>("notes_ensure_root");
    }
    return mockNotebooks[0];
  },

  /** 列出所有笔记本树结构 */
  async listNotebooks(): Promise<NotebookFolder[]> {
    if (isTauri) {
      return invoke<NotebookFolder[]>("notes_list_notebooks");
    }
    return [...mockNotebooks];
  },

  /** 创建新笔记本（文件夹） */
  async createNotebook(parentRelPath: string | null, name: string): Promise<NotebookFolder> {
    if (isTauri) {
      return invoke<NotebookFolder>("notes_create_notebook", {
        parentRelPath: parentRelPath || null,
        name,
      });
    }
    const rel = parentRelPath ? `${parentRelPath}/${name}` : name;
    const newNb: NotebookFolder = {
      id: rel,
      name,
      relativePath: rel,
      fullPath: `/mock/notebooks/${rel}`,
      children: [],
    };
    mockNotebooks.push(newNb);
    mockNotes[rel] = [];
    return newNb;
  },

  /** 列出某个笔记本目录下的笔记 */
  async listNotes(notebookRelPath: string): Promise<NoteFileItem[]> {
    if (isTauri) {
      return invoke<NoteFileItem[]>("notes_list_notes", { notebookRelPath });
    }
    const list = mockNotes[notebookRelPath] || [];
    return list.map((l) => l.item);
  },

  /** 读取某篇笔记的文本内容 */
  async readNote(notebookRelPath: string, fileName: string): Promise<string> {
    if (isTauri) {
      return invoke<string>("notes_read_note", { notebookRelPath, fileName });
    }
    const list = mockNotes[notebookRelPath] || [];
    const found = list.find((l) => l.item.fileName === fileName);
    return found ? found.content : "";
  },

  /** 保存笔记内容（source: autosave/ai/manual/restore——版本历史来源标记） */
  async saveNote(notebookRelPath: string, fileName: string, content: string, source?: string): Promise<number> {
    if (isTauri) {
      const result = await invoke<number>("notes_save_note", { notebookRelPath, fileName, content, source: source ?? null });
      // 知识库自动索引（RAG v1）：保存后防抖重索引该笔记（未配置 embedding 时静默跳过）
      scheduleKnowledgeIndex(`${notebookRelPath}:${fileName}`);
      return result;
    }
    const list = mockNotes[notebookRelPath] || [];
    const found = list.find((l) => l.item.fileName === fileName);
    const now = Date.now();
    if (found) {
      found.content = content;
      found.item.updatedAt = now;
      found.item.snippet = content.slice(0, 150).replace(/\n/g, " ");
    }
    return now;
  },

  /** 创建新笔记 */
  async createNote(notebookRelPath: string, title?: string): Promise<NoteFileItem> {
    if (isTauri) {
      return invoke<NoteFileItem>("notes_create_note", {
        notebookRelPath,
        title: title || null,
      });
    }
    const baseTitle = title || "Untitled";
    const fileName = `${baseTitle}.md`;
    const now = Date.now();
    const item: NoteFileItem = {
      id: `${notebookRelPath}:${fileName}`,
      title: baseTitle,
      fileName,
      notebookRelPath,
      fullPath: `/mock/notebooks/${notebookRelPath}/${fileName}`,
      snippet: "",
      updatedAt: now,
      createdAt: now,
      sizeBytes: 0,
    };
    if (!mockNotes[notebookRelPath]) mockNotes[notebookRelPath] = [];
    mockNotes[notebookRelPath].unshift({ item, content: `# ${baseTitle}\n\n` });
    return item;
  },

  /** 重命名笔记 */
  async renameNote(
    notebookRelPath: string,
    oldFileName: string,
    newTitle: string
  ): Promise<NoteFileItem> {
    if (isTauri) {
      return invoke<NoteFileItem>("notes_rename_note", {
        notebookRelPath,
        oldFileName,
        newTitle,
      });
    }
    const clean = newTitle.trim();
    const newFileName = clean.endsWith(".md") ? clean : `${clean}.md`;
    const list = mockNotes[notebookRelPath] || [];
    const found = list.find((l) => l.item.fileName === oldFileName);
    if (!found) throw new Error("Note not found");
    found.item.fileName = newFileName;
    found.item.title = newFileName.replace(/\.md$/, "");
    found.item.id = `${notebookRelPath}:${newFileName}`;
    return found.item;
  },

  /** 删除笔记 */
  async deleteNote(notebookRelPath: string, fileName: string): Promise<void> {
    if (isTauri) {
      return invoke<void>("notes_delete_note", { notebookRelPath, fileName });
    }
    if (mockNotes[notebookRelPath]) {
      mockNotes[notebookRelPath] = mockNotes[notebookRelPath].filter(
        (l) => l.item.fileName !== fileName
      );
    }
  },

  /** 删除文件夹（笔记本） */
  async deleteNotebook(notebookRelPath: string): Promise<void> {
    if (isTauri) {
      return invoke<void>("notes_delete_notebook", { notebookRelPath });
    }
    mockNotebooks = mockNotebooks.filter((n) => n.relativePath !== notebookRelPath);
    delete mockNotes[notebookRelPath];
  },

  /** 重命名文件夹（笔记本） */
  async renameNotebook(notebookRelPath: string, newName: string): Promise<string> {
    if (isTauri) {
      return invoke<string>("notes_rename_notebook", { notebookRelPath, newName });
    }
    const target = mockNotebooks.find((n) => n.relativePath === notebookRelPath);
    if (!target) throw new Error("Notebook not found");
    target.name = newName;
    return newName;
  },

  /** 使用系统文件管理器打开文件夹（笔记本） */
  async openNotebookFolder(notebookRelPath: string): Promise<void> {
    if (isTauri) {
      return invoke<void>("notes_open_folder", { notebookRelPath });
    }
    console.log(`[Web Mock] Open folder in system file manager: /mock/notebooks/${notebookRelPath}`);
  },

  // ==================== 笔记增强包（ROADMAP ④）====================

  /** 版本历史：列某笔记的最近 20 版（preview ≤200 字符） */
  async versionList(noteId: string): Promise<NoteVersionRow[]> {
    if (!isTauri) return [];
    return invoke<NoteVersionRow[]>("notes_version_list", { noteId });
  },

  /** 版本历史：取某版全文（还原动作 = 取内容 → saveNote(source:'restore')） */
  async versionContent(versionId: number): Promise<NoteVersionContent> {
    if (!isTauri) throw new Error("Web 模式不支持版本历史");
    return invoke<NoteVersionContent>("notes_version_content", { versionId });
  },

  /** 标签：设置某笔记的全部标签（整组替换） */
  async setTags(notebookRelPath: string, fileName: string, tags: string[]): Promise<void> {
    if (!isTauri) return;
    await invoke("notes_set_tags", { notebookRelPath, fileName, tags });
  },

  /** 标签：全量映射 noteId → tags（列表页一次拉取；内部顺带孤儿对账） */
  async allTags(): Promise<Record<string, string[]>> {
    if (!isTauri) return {};
    const rows = await invoke<{ noteId: string; tags: string[] }[]>("notes_all_tags");
    const map: Record<string, string[]> = {};
    for (const row of rows) map[row.noteId] = row.tags;
    return map;
  },

  /** 回收站：列出已删笔记（含 preview） */
  async trashList(): Promise<NoteTrashRow[]> {
    if (!isTauri) return [];
    return invoke<NoteTrashRow[]>("notes_trash_list");
  },

  /** 回收站：恢复到原位（原位被占自动重名）；返回恢复后的完整路径 */
  async trashRestore(id: number): Promise<string> {
    if (!isTauri) throw new Error("Web 模式不支持回收站");
    return invoke<string>("notes_trash_restore", { id });
  },

  /** 回收站：彻底删除单条 */
  async trashPurge(id: number): Promise<void> {
    if (!isTauri) return;
    await invoke("notes_trash_purge", { id });
  }
};
