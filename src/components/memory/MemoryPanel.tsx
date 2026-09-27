/**
 * MemoryPanel —— 记忆管理页（照抄 LiveAgent MemoryPanel 一期子集：
 * 记忆条目列表（类型徽标 + 标题 + 摘要）+ 新建/编辑弹窗 + 删除；
 * 数据存 `~/.ReinAgent/memory/global/<type>/` markdown 文件（Rust `memory_*` 命令）。
 * Agent 集成：系统提示词 `# Memory Index` 段由 runAgentTurn 注入 memory_index_overview。
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Brain, ChevronLeft, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "../../i18n";

interface MemoryEntry {
  id: string;
  memoryType: "user" | "feedback" | "project" | "reference";
  scope: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

const TYPE_LABELS: Record<string, string> = {
  user: "user",
  feedback: "feedback",
  project: "project",
  reference: "reference",
};

export function MemoryPanel({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [editing, setEditing] = useState<MemoryEntry | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const reload = () => {
    void invoke<MemoryEntry[]>("memory_list")
      .then(setEntries)
      .catch((err) => console.error("[memory] list failed:", err));
  };

  useEffect(reload, []);

  const handleSave = async (entry: MemoryEntry) => {
    try {
      if (entries.some((e) => e.id === entry.id)) {
        await invoke("memory_update", {
          id: entry.id,
          title: entry.title,
          body: entry.body,
          memoryType: entry.memoryType,
        });
      } else {
        await invoke("memory_write", { entry });
      }
      setEditing(null);
      reload();
    } catch (err) {
      console.error("[memory] save failed:", err);
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (id: string) => {
    await invoke("memory_delete", { id }).catch(console.error);
    setConfirmDeleteId(null);
    reload();
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden text-[var(--text)]">
      <div className="flex flex-shrink-0 items-center justify-between border-b border-[var(--border)] px-6 pb-4 pt-5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-ui-sm text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] cursor-pointer"
          >
            <ChevronLeft className="h-4 w-4" />
            <span>{t("automationsBack")}</span>
          </button>
          <h1 className="text-ui-lg font-semibold text-[var(--text)]">{t("navMemory")}</h1>
        </div>
        <button
          type="button"
          onClick={() =>
            setEditing({
              id: `mem-${Date.now()}`,
              memoryType: "reference",
              scope: "global",
              title: "",
              body: "",
              createdAt: 0,
              updatedAt: 0,
            })
          }
          className="flex items-center gap-1.5 rounded-full bg-[var(--brand)] px-4 py-1.5 text-ui-sm font-medium text-white transition-colors hover:bg-[var(--accent)] cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          <span>{t("memoryAdd")}</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {entries.length === 0 ? (
          <div className="flex h-[226px] w-full flex-col items-center justify-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] px-4">
            <Brain className="h-8 w-8 text-[var(--text-dim)]" />
            <p className="text-ui-sm font-medium text-[var(--text)]">{t("memoryEmptyTitle")}</p>
            <p className="text-ui-xs text-[var(--text-dim)]">{t("memoryEmptyDesc")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-ui-sm font-medium text-[var(--text)]">
                    {entry.title}
                  </span>
                  <div className="flex flex-shrink-0 items-center gap-1">
                    <button
                      type="button"
                      title={t("turnFileSummaryReview")}
                      onClick={() => setEditing(entry)}
                      className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] cursor-pointer"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    {confirmDeleteId === entry.id ? (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => void handleDelete(entry.id)}
                          className="rounded-md border border-[var(--danger)] px-2 py-0.5 text-xs text-[var(--danger)] hover:bg-[var(--danger)]/10 cursor-pointer"
                        >
                          {t("automationsDeleteConfirm")}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="rounded-md px-1.5 py-0.5 text-xs text-[var(--text-dim)] hover:bg-[var(--surface-hover)] cursor-pointer"
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        title={t("automationsDelete")}
                        onClick={() => setConfirmDeleteId(entry.id)}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--danger)] cursor-pointer"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
                <p className="line-clamp-3 text-ui-xs leading-5 text-[var(--text-dim)]">
                  {entry.body}
                </p>
                <div className="mt-auto flex items-center gap-2">
                  <span className="rounded-md bg-[var(--brand-dim)] px-1.5 py-0.5 text-xs text-[var(--brand)]">
                    {TYPE_LABELS[entry.memoryType] ?? entry.memoryType}
                  </span>
                  <span className="text-xs text-[var(--text-dim)]">
                    {new Date(entry.updatedAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing ? (
        <MemoryEditModal entry={editing} onCancel={() => setEditing(null)} onSave={(e) => void handleSave(e)} />
      ) : null}
    </div>
  );
}

function MemoryEditModal({
  entry,
  onCancel,
  onSave,
}: {
  entry: MemoryEntry;
  onCancel: () => void;
  onSave: (entry: MemoryEntry) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(entry);
  const isNew = !entry.title && !entry.body;
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50">
      <div className="w-[520px] max-w-[92vw] rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-5 shadow-2xl">
        <h2 className="text-ui-base font-semibold text-[var(--text)]">
          {isNew ? t("memoryAdd") : t("memoryEdit")}
        </h2>
        <div className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-ui-xs text-[var(--text-dim)]">
            {t("mcpFieldName")}
            <input
              type="text"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              className="h-9 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-3 text-ui-sm text-[var(--text)] focus:border-[var(--brand)] focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1 text-ui-xs text-[var(--text-dim)]">
            {t("memoryType")}
            <select
              value={draft.memoryType}
              onChange={(e) => setDraft({ ...draft, memoryType: e.target.value as MemoryEntry["memoryType"] })}
              className="h-9 appearance-none rounded-lg border-0 bg-[var(--bg-hover)] px-3 text-ui-sm text-[var(--text)] focus:outline-none"
            >
              <option value="user">user</option>
              <option value="feedback">feedback</option>
              <option value="project">project</option>
              <option value="reference">reference</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-ui-xs text-[var(--text-dim)]">
            {t("memoryBody")}
            <textarea
              value={draft.body}
              rows={6}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              className="resize-y rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-2 text-ui-sm leading-relaxed text-[var(--text)] focus:border-[var(--brand)] focus:outline-none"
            />
          </label>
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-[var(--border)] px-5 py-1.5 text-ui-sm text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] cursor-pointer"
          >
            {t("automationsCancel")}
          </button>
          <button
            type="button"
            onClick={() => onSave(draft)}
            className="rounded-full bg-[var(--brand)] px-6 py-1.5 text-ui-sm font-medium text-white transition-colors hover:bg-[var(--accent)] cursor-pointer"
          >
            {t("automationsSave")}
          </button>
        </div>
      </div>
    </div>
  );
}
