import { Search, Plus, FileText, Trash2, Edit2 } from "lucide-react";
import { useTranslation } from "../../i18n";
import type { NoteFileItem } from "./notesService";

interface NoteListProps {
  notes: NoteFileItem[];
  selectedNoteId?: string;
  searchTerm: string;
  onSearchChange: (value: string) => void;
  onSelectNote: (note: NoteFileItem) => void;
  onCreateNote: () => void;
  onDeleteNote: (note: NoteFileItem) => void;
  onRenameNote: (note: NoteFileItem) => void;
}

export function NoteList({
  notes,
  selectedNoteId,
  searchTerm,
  onSearchChange,
  onSelectNote,
  onCreateNote,
  onDeleteNote,
  onRenameNote,
}: NoteListProps) {
  const { t } = useTranslation();

  const filteredNotes = notes.filter((n) => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return true;
    return (
      n.title.toLowerCase().includes(q) ||
      n.fileName.toLowerCase().includes(q) ||
      n.snippet.toLowerCase().includes(q)
    );
  });

  const formatTime = (ms: number) => {
    if (!ms) return "";
    const date = new Date(ms);
    const now = new Date();
    const diff = (now.getTime() - date.getTime()) / 1000;
    if (diff < 60) return "刚刚";
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    return date.toLocaleDateString();
  };

  return (
    <div className="flex flex-col h-full w-full">
      {/* 顶部操作行：新建笔记 + 搜索框 */}
      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-dim)]" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t("searchNotesPlaceholder")}
            className="w-full bg-[var(--bg-elev-2)] border border-[var(--border)] rounded-xl pl-8 pr-3 py-1.5 text-xs text-[var(--text)] outline-hidden focus:border-[var(--accent)] transition-colors placeholder:text-[var(--text-dim)]"
          />
        </div>
        <button
          type="button"
          onClick={onCreateNote}
          className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-xs hover:brightness-110 active:scale-95 transition-all shrink-0 cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>{t("newNote")}</span>
        </button>
      </div>

      {/* 笔记卡片流 */}
      <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
        {filteredNotes.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-center text-[var(--text-dim)]">
            <FileText className="w-8 h-8 opacity-30 mb-2" />
            <p className="text-xs font-medium">{t("emptyNotes")}</p>
            <p className="text-[11px] opacity-70 mt-1">{t("emptyNotesHint")}</p>
          </div>
        ) : (
          filteredNotes.map((note) => {
            const isSelected = selectedNoteId === note.id;
            return (
              <div
                key={note.id}
                onClick={() => onSelectNote(note)}
                className={`group relative flex flex-col p-3 rounded-xl border transition-all cursor-pointer ${
                  isSelected
                    ? "border-[var(--accent)] bg-[var(--accent)]/10 shadow-xs"
                    : "border-transparent bg-[var(--bg-elev-2)] hover:border-[var(--border)] hover:bg-[var(--surface-hover)]"
                }`}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <h4 className="text-xs font-semibold text-[var(--text)] truncate flex-1">
                    {note.title || t("untitledNote")}
                  </h4>
                  <span className="text-[10px] text-[var(--text-dim)] shrink-0">
                    {formatTime(note.updatedAt)}
                  </span>
                </div>

                <p className="text-[11px] text-[var(--text-dim)] line-clamp-2 leading-relaxed break-all">
                  {note.snippet || "……"}
                </p>

                {/* 悬停操作按键：重命名 / 删除 */}
                <div className="absolute right-2 bottom-2 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 bg-[var(--bg-elev)] border border-[var(--border)] rounded-md px-1 py-0.5 shadow-xs">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRenameNote(note);
                    }}
                    title="重命名"
                    className="p-1 hover:text-[var(--accent)] text-[var(--text-dim)] transition-colors rounded-sm"
                  >
                    <Edit2 className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteNote(note);
                    }}
                    title="删除"
                    className="p-1 hover:text-red-500 text-[var(--text-dim)] transition-colors rounded-sm"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
