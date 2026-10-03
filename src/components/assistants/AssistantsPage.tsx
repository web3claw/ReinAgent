/**
 * AssistantsPage —— 助手管理页（侧栏「助手」入口的全页视图）。
 *
 * 卡片列表（内置 + 自定义两组）：名称/描述 + 设为全局默认 + 新建/编辑/删除。
 * 本页只管全局默认助手（kv，对未单独设置的任务生效）；任务作用域唯一入口是
 * 聊天页任务名旁的 AssistantChip 下拉（按任务记忆）。
 * 助手 = 纯人设（名称 slug / 描述 / 人设指令），不携带模型/推理预设——
 * 模型与推理强度一律跟随设置里的默认。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Globe, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "../../i18n";
import { toast } from "../lw/ui/toast";
import { useAppStore } from "../../store/useAppStore";
import {
  GENERAL_ASSISTANT_ID,
  assistantSlug,
  deleteAssistantById,
  loadAssistantCatalog,
  saveUserAssistant,
  type AssistantDef,
} from "../../lib/assistants/assistantDefs";
import { Button } from "../lw/ui/button";
import { Input } from "../lw/ui/input";
import { Textarea } from "../lw/ui/textarea";
import { ConfirmActionPopover } from "../lw/ui/confirm-action-popover";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "../lw/ui/dialog";
import { CapabilityBadge, CapabilityGroupHeader, CapabilityRow, matchesCapabilitySearch } from "../settings/AgentCapabilityLayout";

interface Draft {
  editingId: string | null;
  name: string;
  description: string;
  prompt: string;
}

const emptyDraft = (): Draft => ({
  editingId: null,
  name: "",
  description: "",
  prompt: "",
});

export function AssistantsPage() {
  const { t } = useTranslation();
  // 动态 i18n 键（assistant* 查表）需要 string 签名
  const tf = t as unknown as (key: string) => string;
  // 助手页只管全局默认：任务作用域唯一入口是聊天页任务名旁的 AssistantChip
  const globalDefaultAssistantId = useAppStore((s) => s.globalDefaultAssistantId);
  const setGlobalDefaultAssistant = useAppStore((s) => s.setGlobalDefaultAssistant);
  const [catalog, setCatalog] = useState<AssistantDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);

  const reload = useCallback(async () => {
    const cat = await loadAssistantCatalog();
    setCatalog(cat.assistants);
  }, []);

  useEffect(() => {
    void reload().finally(() => setLoading(false));
  }, [reload]);

  const visible = useMemo(
    () => catalog.filter((d) => matchesCapabilitySearch(search, d.name, d.description, d.id)),
    [catalog, search],
  );
  const builtins = visible.filter((d) => d.builtin);
  const customs = visible.filter((d) => !d.builtin);

  const applyGlobal = (def: AssistantDef) => {
    setGlobalDefaultAssistant(def.id);
  };

  const save = async () => {
    if (!draft) return;
    try {
      const slug = assistantSlug(draft.name);
      await saveUserAssistant({
        id: draft.editingId ?? slug,
        name: slug,
        description: draft.description.trim(),
        prompt: draft.prompt,
      });
      await reload();
      setDraft(null);
    } catch (err) {
      console.error("[assistants] save failed:", err);
      toast.error(String(err instanceof Error ? err.message : err).slice(0, 200));
    }
  };

  const remove = async (def: AssistantDef) => {
    try {
      await deleteAssistantById(def.id);
      await reload();
    } catch (err) {
      toast.error(String(err instanceof Error ? err.message : err).slice(0, 200));
    }
  };

  const renderRow = (def: AssistantDef) => {
    const isGeneral = def.id === GENERAL_ASSISTANT_ID;
    const isGlobalDefault = globalDefaultAssistantId === def.id;
    const deletable = !isGeneral && !def.builtin;
    return (
      <CapabilityRow
        key={def.id}
        glyph={<Bot className="size-4" />}
        name={def.name}
        command={isGeneral ? undefined : `#${def.id}`}
        badges={
          <>
            {def.builtin ? <CapabilityBadge label={t("subagentBuiltinBadge")} /> : null}
            {isGlobalDefault ? (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--surface-hover)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-dim)]"
                title={tf("assistantApplyGlobal")}
              >
                <Globe className="size-3" />
                {tf("assistantGlobalBadge")}
              </span>
            ) : null}
          </>
        }
        description={def.description || t("subagentNoDescription")}
        actions={
          <>
            {!def.builtin ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("edit")}
                title={t("edit")}
                onClick={() =>
                  setDraft({
                    editingId: def.id,
                    name: def.id,
                    description: def.description,
                    prompt: def.prompt,
                  })
                }
              >
                <Pencil className="size-3.5" />
              </Button>
            ) : null}
            {deletable ? (
              <ConfirmActionPopover
                title={tf("assistantDelete")}
                description={`“${def.name}” 将被删除`}
                confirmLabel={t("confirm")}
                cancelLabel={t("cancel")}
                onConfirm={() => void remove(def)}
              >
                {(open) => (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={tf("assistantDelete")}
                    title={tf("assistantDelete")}
                    onClick={open}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </ConfirmActionPopover>
            ) : null}
            <Button
              size="sm"
              variant={isGlobalDefault ? "outline" : "default"}
              disabled={isGlobalDefault}
              onClick={() => applyGlobal(def)}
            >
              {isGlobalDefault ? tf("assistantGlobalBadge") : tf("assistantApplyGlobal")}
            </Button>
          </>
        }
      />
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative">
          <input
            type="text"
            value={search}
            placeholder={tf("assistantSearchPlaceholder")}
            onChange={(e) => setSearch(e.currentTarget.value)}
            className="h-8 w-64 rounded-lg border border-[var(--border)] bg-settings-tile px-3 text-xs text-[var(--text)] placeholder-[var(--text-dim)] focus:border-[var(--brand)] focus:outline-none"
          />
        </div>
        <Button
          size="sm"
          onClick={() => setDraft(emptyDraft())}
        >
          <Plus className="size-3.5" />
          {tf("assistantAdd")}
        </Button>
      </div>
      <p className="text-xs text-[var(--text-dim)]">{tf("assistantPageHint")}</p>

      {loading ? (
        <div className="rounded-xl bg-settings-tile px-4 py-8 text-xs text-[var(--text-dim)]">
          {tf("assistantLoading")}
        </div>
      ) : (
        <div className="space-y-2">
          <CapabilityGroupHeader label={tf("assistantGroupBuiltin")} count={builtins.length} />
          {builtins.map(renderRow)}
          <CapabilityGroupHeader
            label={tf("assistantGroupCustom")}
            path="~/.ReinAgent/assistants"
            count={customs.length}
          />
          {customs.length > 0 ? (
            customs.map(renderRow)
          ) : (
            <div className="rounded-xl bg-settings-tile px-4 py-6 text-center text-xs text-[var(--text-dim)]">
              {tf("assistantEmptyCustom")}
            </div>
          )}
        </div>
      )}

      {draft ? (
        <AssistantEditor
          draft={draft}
          setDraft={setDraft}
          onClose={() => setDraft(null)}
          onSave={() => void save()}
        />
      ) : null}
    </div>
  );
}

function AssistantEditor({
  draft,
  setDraft,
  onClose,
  onSave,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const isCreate = draft.editingId === null;
  const slug = assistantSlug(draft.name);
  // 中文名自动转写：slug 生成失败但名字非空 = 回退 id 已可生成 → 不禁用保存
  const saveDisabled =
    !draft.name.trim() || !slug || !draft.description.trim() || !draft.prompt.trim();

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[92vh] max-w-xl flex-col" closeLabel={t("cancel")}>
        <DialogHeader className="gap-1 pb-3">
          <h2 className="text-base font-semibold">
            {isCreate ? t("assistantAdd") : t("assistantEdit")}
          </h2>
        </DialogHeader>

        <DialogHeader className="gap-1 pb-3">
          <h2 className="text-lg font-semibold">
            {isCreate ? t("assistantAdd") : t("assistantEdit")}
          </h2>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-[var(--text-dim)]">{t("subagentName")}</label>
            <Input
              variant="plain"
              value={draft.name}
              placeholder="my-assistant"
              className="text-base"
              onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
            />
            {slug ? (
              <p className="text-[11px] text-[var(--text-dim)]">
                {t("subagentSlugHint").replace("{id}", slug)}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-[var(--text-dim)]">
              {t("assistantDescLabel")}
            </label>
            <Textarea
              variant="plain"
              rows={2}
              value={draft.description}
              placeholder={t("assistantDescPlaceholder")}
              className="text-base"
              onChange={(e) => setDraft({ ...draft, description: e.currentTarget.value })}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-[var(--text-dim)]">
              {t("assistantPromptLabel")}
            </label>
            <Textarea
              variant="plain"
              rows={8}
              value={draft.prompt}
              placeholder={t("assistantPromptPlaceholder")}
              className="text-sm leading-relaxed"
              onChange={(e) => setDraft({ ...draft, prompt: e.currentTarget.value })}
            />
            <p className="text-[11px] text-[var(--text-dim)]">{t("assistantPromptHint")}</p>
          </div>

          <p className="text-[11px] text-[var(--text-dim)]">{t("assistantFollowsDefaultsHint")}</p>

          {error ? <p className="text-xs text-red-500">{error}</p> : null}
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            size="sm"
            disabled={saveDisabled}
            onClick={() => {
              if (!assistantSlug(draft.name)) {
                setError(t("subagentErrorSlug"));
                return;
              }
              if (!draft.description.trim()) {
                setError(t("subagentErrorDescription"));
                return;
              }
              if (!draft.prompt.trim()) {
                setError(t("subagentErrorBody"));
                return;
              }
              onSave();
            }}
          >
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

