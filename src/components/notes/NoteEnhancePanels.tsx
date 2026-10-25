/**
 * 笔记增强包 UI（ROADMAP ④）：版本历史右滑面板 + 回收站面板 + 标签编辑条。
 * 三个独立小组件，NoteEditor（历史/标签）与 NotesPage（回收站）按需挂载。
 * i18n 键：notesVersion 系列 / notesTrash 系列 / notesTags 系列（i18n/index.ts）。
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import { notesService, type NoteTrashRow, type NoteVersionRow } from "./notesService";
import { tagColorIndex } from "./noteEnhance";
import { toast } from "../lw/ui/toast";
import { History, RotateCcw, Trash2, X, Tag as TagIcon } from "lucide-react";

/** 标签色板（与全局主题变量协同的 8 色——由 tagColorIndex 稳定映射）。 */
const TAG_BG = [
  "bg-blue-500/15 text-blue-600 dark:text-blue-300",
  "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
  "bg-amber-500/15 text-amber-600 dark:text-amber-300",
  "bg-rose-500/15 text-rose-600 dark:text-rose-300",
  "bg-violet-500/15 text-violet-600 dark:text-violet-300",
  "bg-cyan-500/15 text-cyan-600 dark:text-cyan-300",
  "bg-orange-500/15 text-orange-600 dark:text-orange-300",
  "bg-teal-500/15 text-teal-600 dark:text-teal-300",
];

function tagClass(tag: string): string {
  return `px-1.5 py-0.5 rounded-md text-[11px] font-medium ${TAG_BG[tagColorIndex(tag) % TAG_BG.length]}`;
}

const SOURCE_LABELS: Record<string, string> = {
  autosave: "自动",
  manual: "手动",
  ai: "AI",
  restore: "还原",
};

// ==================== 版本历史面板 ====================

export function NoteVersionPanel({
  noteId,
  currentContent,
  onRestore,
  onClose,
}: {
  noteId: string;
  currentContent: string;
  onRestore: (content: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [versions, setVersions] = useState<NoteVersionRow[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [selectedContent, setSelectedContent] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    notesService
      .versionList(noteId)
      .then((rows) => {
        if (!cancelled) setVersions(rows);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  async function handlePick(id: number) {
    setSelected(id);
    setSelectedContent("");
    try {
      const full = await notesService.versionContent(id);
      setSelectedContent(full.content);
    } catch (err) {
      setSelectedContent(`[读取失败：${err instanceof Error ? err.message : err}]`);
    }
  }

  function handleRestore() {
    if (selected === null) return;
    // 还原 = 版本内容写回编辑器 → 走正常保存链（source=restore 产生新快照，回滚不丢当前版）
    onRestore(selectedContent);
    toast.success(t("notesVersionRestored", "已还原到所选版本（还原前的内容已自动存入历史）"));
    onClose();
  }

  const currentPreview = currentContent.slice(0, 1000);

  return (
    <div className="absolute inset-y-0 right-0 z-30 w-[420px] max-w-[85%] border-l border-[var(--border)] bg-[var(--surface)] shadow-2xl flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <div className="flex items-center gap-2 text-sm font-medium">
          <History className="w-4 h-4" />
          {t("notesVersionTitle", "版本历史")}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-lg hover:bg-[var(--surface-hover)] cursor-pointer"
          aria-label="close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 min-h-0 flex">
        {/* 版本列表 */}
        <div className="w-36 shrink-0 border-r border-[var(--border)] overflow-y-auto p-2 space-y-1">
          {loading ? (
            <div className="text-xs text-[var(--text-dim)] p-2">…</div>
          ) : error ? (
            <div className="text-xs text-[var(--status-err,red)] p-2 break-all">{error}</div>
          ) : versions.length === 0 ? (
            <div className="text-xs text-[var(--text-dim)] p-2">{t("notesVersionEmpty", "暂无历史版本")}</div>
          ) : (
            versions.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => void handlePick(v.id)}
                className={`w-full text-left px-2 py-1.5 rounded-lg text-xs cursor-pointer ${
                  selected === v.id ? "bg-[var(--accent)] text-white" : "hover:bg-[var(--surface-hover)]"
                }`}
              >
                <div className="font-mono">{new Date(v.savedAt).toLocaleString()}</div>
                <div className={selected === v.id ? "text-white/70" : "text-[var(--text-dim)]"}>
                  {SOURCE_LABELS[v.source] ?? v.source}
                </div>
              </button>
            ))
          )}
        </div>
        {/* 并排对照 */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 min-h-0 grid grid-cols-2 divide-x divide-[var(--border)]">
            <div className="min-h-0 overflow-y-auto p-2">
              <div className="text-[11px] text-[var(--text-dim)] mb-1">{t("notesVersionCurrent", "当前")}</div>
              <pre className="text-[11px] whitespace-pre-wrap break-all font-mono">{currentPreview}</pre>
            </div>
            <div className="min-h-0 overflow-y-auto p-2">
              <div className="text-[11px] text-[var(--text-dim)] mb-1">
                {selected === null ? t("notesVersionPickHint", "← 点击版本对照") : t("notesVersionSelected", "所选版本")}
              </div>
              <pre className="text-[11px] whitespace-pre-wrap break-all font-mono">{selectedContent}</pre>
            </div>
          </div>
          <div className="p-2 border-t border-[var(--border)]">
            <button
              type="button"
              disabled={selected === null || !selectedContent}
              onClick={handleRestore}
              className="w-full h-8 rounded-lg bg-[var(--accent)] text-white text-sm disabled:opacity-40 cursor-pointer flex items-center justify-center gap-1.5"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              {t("notesVersionRestore", "还原到此版本")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ==================== 回收站面板 ====================

export function NoteTrashPanel({
  onRestored,
  onClose,
}: {
  onRestored: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<NoteTrashRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const refresh = () => {
    setLoading(true);
    notesService
      .trashList()
      .then(setRows)
      .catch((err) => toast.error(`回收站读取失败：${err instanceof Error ? err.message : err}`))
      .finally(() => setLoading(false));
  };
  useEffect(refresh, []);

  async function handleRestore(id: number) {
    setBusyId(id);
    try {
      const path = await notesService.trashRestore(id);
      toast.success(t("notesTrashRestored", "已恢复：") + path);
      onRestored();
      refresh();
    } catch (err) {
      toast.error(`恢复失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setBusyId(null);
    }
  }

  async function handlePurge(id: number) {
    setBusyId(id);
    try {
      await notesService.trashPurge(id);
      refresh();
    } catch (err) {
      toast.error(`删除失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setBusyId(null);
    }
  }

  async function handleClearAll() {
    if (!confirmClear) {
      setConfirmClear(true);
      window.setTimeout(() => setConfirmClear(false), 3200);
      return;
    }
    for (const row of rows) {
      await notesService.trashPurge(row.id).catch(() => {});
    }
    setConfirmClear(false);
    refresh();
  }

  return (
    <div className="absolute inset-0 z-40 bg-black/30 flex items-center justify-center" onClick={onClose}>
      <div
        className="w-[520px] max-w-[90%] max-h-[70%] rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Trash2 className="w-4 h-4" />
            {t("notesTrashTitle", "回收站")}
            <span className="text-xs text-[var(--text-dim)]">{t("notesTrashRetention", "30 天后自动清除")}</span>
          </div>
          <div className="flex items-center gap-2">
            {rows.length > 0 ? (
              <button
                type="button"
                onClick={() => void handleClearAll()}
                className={`h-7 px-2 rounded-lg border text-xs cursor-pointer ${
                  confirmClear
                    ? "border-[var(--status-err,red)] text-[var(--status-err,red)]"
                    : "border-[var(--border)] hover:bg-[var(--surface-hover)]"
                }`}
              >
                {confirmClear ? t("notesTrashClearConfirm", "确认清空？") : t("notesTrashClear", "清空")}
              </button>
            ) : null}
            <button type="button" onClick={onClose} className="p-1 rounded-lg hover:bg-[var(--surface-hover)] cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
          {loading ? (
            <div className="text-xs text-[var(--text-dim)] p-3">…</div>
          ) : rows.length === 0 ? (
            <div className="text-xs text-[var(--text-dim)] p-3">{t("notesTrashEmpty", "回收站为空")}</div>
          ) : (
            rows.map((row) => (
              <div key={row.id} className="rounded-lg border border-[var(--border)] p-2.5 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate flex-1" title={`${row.originalNotebookRel}/${row.originalFileName}`}>
                    {row.wasNotebook ? "🗂 " : ""}
                    {row.originalNotebookRel}/{row.originalFileName}
                  </span>
                  <span className="text-[var(--text-dim)] shrink-0">{new Date(row.deletedAt).toLocaleString()}</span>
                </div>
                {row.preview ? (
                  <div className="mt-1 text-[var(--text-dim)] line-clamp-2 break-all">{row.preview}</div>
                ) : null}
                <div className="mt-1.5 flex gap-2">
                  <button
                    type="button"
                    disabled={busyId === row.id}
                    onClick={() => void handleRestore(row.id)}
                    className="h-6 px-2 rounded-md bg-[var(--accent)] text-white disabled:opacity-40 cursor-pointer"
                  >
                    {t("notesTrashRestore", "恢复")}
                  </button>
                  <button
                    type="button"
                    disabled={busyId === row.id}
                    onClick={() => void handlePurge(row.id)}
                    className="h-6 px-2 rounded-md border border-[var(--border)] hover:bg-[var(--surface-hover)] disabled:opacity-40 cursor-pointer"
                  >
                    {t("notesTrashPurge", "彻底删除")}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ==================== 标签编辑条 ====================

export function NoteTagEditor({
  noteId,
  notebookRelPath,
  fileName,
  allTags,
  onTagsChanged,
}: {
  noteId: string;
  notebookRelPath: string;
  fileName: string;
  allTags: Record<string, string[]>;
  onTagsChanged?: () => void;
}) {
  const { t } = useTranslation();
  const tags = useMemo(() => allTags[noteId] ?? [], [allTags, noteId]);
  const [input, setInput] = useState("");
  const existingTagNames = useMemo(() => {
    const set = new Set<string>();
    for (const list of Object.values(allTags)) for (const tag of list) set.add(tag);
    return [...set].sort();
  }, [allTags]);

  async function persist(next: string[]) {
    try {
      await notesService.setTags(notebookRelPath, fileName, next);
      onTagsChanged?.();
    } catch (err) {
      toast.error(`保存标签失败：${err instanceof Error ? err.message : err}`);
    }
  }

  function addTag(raw: string) {
    const tag = raw.trim();
    if (!tag || tags.includes(tag)) {
      setInput("");
      return;
    }
    void persist([...tags, tag]);
    setInput("");
  }

  function removeTag(tag: string) {
    void persist(tags.filter((x) => x !== tag));
  }

  const suggestions = existingTagNames
    .filter((name) => !tags.includes(name) && (input ? name.toLowerCase().includes(input.toLowerCase()) : true))
    .slice(0, 6);

  return (
    <div className="flex items-center gap-1.5 flex-wrap px-4 pb-1.5 relative">
      <TagIcon className="w-3.5 h-3.5 text-[var(--text-dim)] shrink-0" />
      {tags.map((tag) => (
        <span key={tag} className={`${tagClass(tag)} inline-flex items-center gap-1`}>
          {tag}
          <button
            type="button"
            onClick={() => removeTag(tag)}
            className="opacity-60 hover:opacity-100 cursor-pointer"
            aria-label={`remove ${tag}`}
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            addTag(input);
          } else if (e.key === "Backspace" && !input && tags.length > 0) {
            removeTag(tags[tags.length - 1]);
          }
        }}
        placeholder={t("notesTagsPlaceholder", "添加标签…")}
        className="h-6 min-w-24 flex-1 max-w-40 bg-transparent text-xs outline-none placeholder:text-[var(--text-dim)]"
      />
      {input && suggestions.length > 0 ? (
        <div className="absolute left-4 top-full z-30 mt-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-xl p-1 flex flex-col gap-0.5">
          {suggestions.map((name) => (
            <button
              key={name}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                addTag(name);
              }}
              className="text-left px-2 py-1 rounded-md text-xs hover:bg-[var(--surface-hover)] cursor-pointer"
            >
              {name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 树/列表行内的小标签色点（NotesTree 笔记行尾部用）。 */
export function NoteTagDots({ tags }: { tags: string[] | undefined }) {
  const shown = (tags ?? []).slice(0, 3);
  if (shown.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-0.5 shrink-0" title={shown.join(", ")}>
      {shown.map((tag) => (
        <span key={tag} className={`inline-block size-1.5 rounded-full ${TAG_BG[tagColorIndex(tag) % TAG_BG.length].split(" ")[0]}`} />
      ))}
    </span>
  );
}

export { tagClass };
