/**
 * SkillsHubPage —— 技能管理页（照抄 LiveAgent SkillsHubPage 一期子集：
 * 技能卡片列表（名称 + 描述 + 启停开关）+ 创建/编辑弹窗 + 删除；
 * 存储为 `~/.ReinAgent/skills/<id>/SKILL.md`（Rust `skills_*` 命令）。
 * Agent 集成：启用技能由 runAgentTurn 注入系统提示词 `# Skills` 段。
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Blend, ChevronLeft, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "../../i18n";

interface SkillEntry {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  body: string;
}

export function SkillsHubPage({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [editing, setEditing] = useState<SkillEntry | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const reload = () => {
    void invoke<SkillEntry[]>("skills_list")
      .then(setSkills)
      .catch((err) => console.error("[skills] list failed:", err));
  };

  useEffect(reload, []);

  const persist = (next: SkillEntry[]) => setSkills(next);

  const handleToggle = async (skill: SkillEntry) => {
    persist(skills.map((s) => (s.id === skill.id ? { ...s, enabled: !s.enabled } : s)));
    await invoke("skills_set_enabled", { id: skill.id, enabled: !skill.enabled }).catch(console.error);
  };

  const handleSave = async (entry: SkillEntry) => {
    try {
      await invoke("skills_save", { entry });
      setEditing(null);
      reload();
    } catch (err) {
      console.error("[skills] save failed:", err);
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (id: string) => {
    await invoke("skills_delete", { id }).catch(console.error);
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
          <h1 className="text-ui-lg font-semibold text-[var(--text)]">{t("navSkills")}</h1>
        </div>
        <button
          type="button"
          onClick={() =>
            setEditing({ id: "", name: "", description: "", enabled: true, body: "" })
          }
          className="flex items-center gap-1.5 rounded-full bg-[var(--brand)] px-4 py-1.5 text-ui-sm font-medium text-white transition-colors hover:bg-[var(--accent)] cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          <span>{t("skillsAdd")}</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {skills.length === 0 ? (
          <div className="flex h-[226px] w-full flex-col items-center justify-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] px-4">
            <Blend className="h-8 w-8 text-[var(--text-dim)]" />
            <p className="text-ui-sm font-medium text-[var(--text)]">{t("skillsEmptyTitle")}</p>
            <p className="text-ui-xs text-[var(--text-dim)]">{t("skillsEmptyDesc")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {skills.map((s) => (
              <div
                key={s.id}
                className={`flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3 ${
                  s.enabled ? "" : "opacity-60"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-ui-sm font-medium text-[var(--text)]">
                    {s.name}
                  </span>
                  <div className="flex flex-shrink-0 items-center gap-1">
                    <button
                      type="button"
                      title={t("turnFileSummaryReview")}
                      onClick={() => setEditing(s)}
                      className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] cursor-pointer"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    {confirmDeleteId === s.id ? (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => void handleDelete(s.id)}
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
                        onClick={() => setConfirmDeleteId(s.id)}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--danger)] cursor-pointer"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      role="switch"
                      aria-checked={s.enabled}
                      onClick={() => void handleToggle(s)}
                      className={`relative h-4 w-8 flex-shrink-0 rounded-full transition-colors cursor-pointer ${
                        s.enabled ? "bg-[var(--brand)]" : "bg-[var(--border)]"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all ${
                          s.enabled ? "left-[18px]" : "left-0.5"
                        }`}
                      />
                    </button>
                  </div>
                </div>
                <p className="line-clamp-2 text-ui-xs leading-5 text-[var(--text-dim)]">
                  {s.description}
                </p>
                <div className="mt-auto flex items-center gap-2">
                  <span className="rounded-md bg-[var(--surface)] px-1.5 py-0.5 font-mono text-xs text-[var(--text-dim)]">
                    {s.id}
                  </span>
                  <span className="text-xs text-[var(--text-dim)]">
                    {s.enabled ? t("automationsFilterActive") : t("automationsPausedLabel")}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing ? (
        <SkillEditModal entry={editing} onCancel={() => setEditing(null)} onSave={(s) => void handleSave(s)} />
      ) : null}
    </div>
  );
}

function SkillEditModal({
  entry,
  onCancel,
  onSave,
}: {
  entry: SkillEntry;
  onCancel: () => void;
  onSave: (entry: SkillEntry) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(entry);
  const isNew = entry.id === "";
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50">
      <div className="w-[560px] max-w-[92vw] rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-5 shadow-2xl">
        <h2 className="text-ui-base font-semibold text-[var(--text)]">
          {isNew ? t("skillsAdd") : t("skillsEdit")}
        </h2>
        <div className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-ui-xs text-[var(--text-dim)]">
            {t("skillsId")}
            <input
              type="text"
              value={draft.id}
              disabled={!isNew}
              placeholder="my-skill"
              onChange={(e) => setDraft({ ...draft, id: e.target.value })}
              className="h-9 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-3 font-mono text-ui-xs text-[var(--text)] focus:border-[var(--brand)] focus:outline-none disabled:opacity-50"
            />
          </label>
          <label className="flex flex-col gap-1 text-ui-xs text-[var(--text-dim)]">
            {t("mcpFieldName")}
            <input
              type="text"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className="h-9 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-3 text-ui-sm text-[var(--text)] focus:border-[var(--brand)] focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1 text-ui-xs text-[var(--text-dim)]">
            {t("skillsDescription")}
            <input
              type="text"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              className="h-9 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-3 text-ui-sm text-[var(--text)] focus:border-[var(--brand)] focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1 text-ui-xs text-[var(--text-dim)]">
            {t("skillsBody")}
            <textarea
              value={draft.body}
              rows={8}
              placeholder={t("skillsBodyPlaceholder")}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              className="resize-y rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-2 font-mono text-ui-xs leading-relaxed text-[var(--text)] focus:border-[var(--brand)] focus:outline-none"
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
