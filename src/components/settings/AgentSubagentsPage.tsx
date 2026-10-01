/**
 * AgentSubagentsPage —— 设置「子智能体」页。
 * PI-Desktop 移植：apps/desktop/src/components/settings/AgentSubagentsPage.tsx。
 * 数据：内置 5 定义（编译期常量）+ 用户 `~/.agents/subagents/*.md`（fs 命令发现）；
 * 启停即时落 kv；增删改落 md 文档；API Key 等模型配置经 loadProvidersConfigFromDisk。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Copy, FolderOpen, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "../../i18n";
import { toast } from "../lw/ui/toast";
import {
  SUBAGENTS_DIR_DISPLAY,
  listUserSubagents,
  createUserSubagent,
  updateUserSubagent,
  removeUserSubagent,
  setBuiltinEnabled,
  setUserSubagentEnabled,
  type SubagentDefinition,
  type UserSubagentRecord,
} from "../../lib/subagents/subagentDefinitions";
import type { ModelPickerOption } from "../lw/settings/ModelPicker";
import { Button } from "../lw/ui/button";
import {
  AgentCapabilityPage,
  CapabilityBadge,
  CapabilityEmpty,
  CapabilityGroupHeader,
  CapabilityPanel,
  CapabilityRow,
  CapabilityToolbar,
  CapabilityToggle,
  CapabilityToolChip,
  matchesCapabilitySearch,
  useArmedDelete,
} from "./AgentCapabilityLayout";
import {
  SubagentEditorSheet,
  draftFromDefinition,
  draftFromRecord,
  emptySubagentDraft,
  type SubagentDraft,
} from "./SubagentEditorSheet";

type EditorState = {
  draft: SubagentDraft;
  editing: UserSubagentRecord | null;
};

const PRESET_NAME_KEYS: Record<string, string> = {
  explorer: "subagentPresetExplorerName",
  "code-reviewer": "subagentPresetReviewerName",
  "test-runner": "subagentPresetTestRunnerName",
  fixer: "subagentPresetFixerName",
  "ui-designer": "subagentPresetUiDesignerName",
};

function builtinDisplayName(handle: string, t: (key: string) => string): string {
  return t(PRESET_NAME_KEYS[handle] ?? handle);
}

async function loadModelOptions(): Promise<ModelPickerOption[]> {
  try {
    const { loadProvidersConfigFromDisk } = await import(
      "../../components/settings/model-provider/types"
    );
    const providers = await loadProvidersConfigFromDisk();
    return providers.flatMap((provider) =>
      provider.models.map((model) => ({
        value: `${provider.id}/${model.id}`,
        label: model.id,
        ...(model.name ? { description: model.name } : {}),
        providerName: provider.name || provider.id,
        providerId: provider.id,
      })),
    );
  } catch (err) {
    console.warn("[subagents] provider options load failed:", err);
    return [];
  }
}

export function AgentSubagentsPage() {
  const { t } = useTranslation();
  // 动态 i18n 键查表（PRESET_NAME_KEYS / builtin 展示名）需要 string 签名
  const tf = t as unknown as (key: string) => string;
  const [builtins, setBuiltins] = useState<Array<SubagentDefinition & { enabled: boolean }>>([]);
  const [owned, setOwned] = useState<UserSubagentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [modelOptions, setModelOptions] = useState<ModelPickerOption[]>([]);
  const { armed, setArmed } = useArmedDelete();

  const load = useCallback(async () => {
    const { builtinSubagentDefinitions, getDisabledBuiltins } = await import(
      "../../lib/subagents/subagentDefinitions"
    );
    const disabled = new Set(getDisabledBuiltins());
    setBuiltins(
      builtinSubagentDefinitions().definitions.map((def) => ({
        ...def,
        enabled: !disabled.has(def.name),
      })),
    );
    const { records } = await listUserSubagents();
    setOwned(records);
  }, []);

  useEffect(() => {
    void load().finally(() => setLoading(false));
    void loadModelOptions().then(setModelOptions);
  }, [load]);

  const reload = useCallback(async () => {
    await load();
  }, [load]);

  const toggleBuiltin = (builtin: SubagentDefinition & { enabled: boolean }) => {
    const handle = builtin.name;
    if (busyId === `builtin:${handle}`) return;
    const next = !builtin.enabled;
    setBusyId(`builtin:${handle}`);
    setBuiltins((cur) =>
      cur.map((row) => (row.name === handle ? { ...row, enabled: next } : row)),
    );
    try {
      setBuiltinEnabled(handle, next);
    } catch (err) {
      setBuiltins((cur) =>
        cur.map((row) => (row.name === handle ? { ...row, enabled: builtin.enabled } : row)),
      );
      console.warn("[subagents] builtin toggle persist failed:", err);
    } finally {
      setBusyId(null);
    }
  };

  const toggleUser = (record: UserSubagentRecord) => {
    if (busyId === record.id) return;
    const next = !record.enabled;
    setBusyId(record.id);
    setOwned((cur) =>
      cur.map((row) => (row.id === record.id ? { ...row, enabled: next } : row)),
    );
    try {
      setUserSubagentEnabled(record.id, next);
    } catch (err) {
      setOwned((cur) =>
        cur.map((row) => (row.id === record.id ? { ...row, enabled: record.enabled } : row)),
      );
      console.warn("[subagents] enable persist failed:", err);
    } finally {
      setBusyId(null);
    }
  };

  const openEdit = (record: UserSubagentRecord) => {
    setEditor({ draft: draftFromRecord(record), editing: record });
  };

  const copyBuiltin = (definition: SubagentDefinition) => {
    setEditor({ draft: draftFromDefinition(definition), editing: null });
  };

  const reveal = (record: UserSubagentRecord) => {
    void (async () => {
      try {
        const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
        await revealItemInDir(record.path);
      } catch (err) {
        console.warn("[subagents] reveal failed:", err);
      }
    })();
  };

  const save = async () => {
    if (!editor) return;
    const { draft, editing } = editor;
    const payload = {
      name: subagentSafeName(draft.name),
      description: draft.description.trim(),
      tools: [...draft.tools],
      ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
      ...(draft.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
      prompt: draft.prompt,
    };
    setSaving(true);
    try {
      if (editing) {
        await updateUserSubagent(editing.id, payload);
        if (editing.enabled !== draft.enabled) {
          setUserSubagentEnabled(payload.name, draft.enabled);
        }
      } else {
        await createUserSubagent(payload);
        if (!draft.enabled) setUserSubagentEnabled(payload.name, false);
      }
      await reload();
      setEditor(null);
    } catch (err) {
      console.error("[subagents] save failed:", err);
      toast.error(String(err instanceof Error ? err.message : err).slice(0, 200));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (record: UserSubagentRecord) => {
    setBusyId(record.id);
    try {
      await removeUserSubagent(record.id);
      await reload();
    } catch (err) {
      console.error("[subagents] remove failed:", err);
      toast.error(String(err instanceof Error ? err.message : err).slice(0, 200));
    } finally {
      setBusyId(null);
      setArmed(null);
    }
  };

  const visibleOwned = useMemo(
    () =>
      owned.filter((record) =>
        matchesCapabilitySearch(search, record.name, record.description),
      ),
    [search, owned],
  );

  const visibleBuiltins = useMemo(
    () =>
      builtins.filter((def) =>
        matchesCapabilitySearch(search, builtinDisplayName(def.name, tf), def.description),
      ),
    [builtins, search, t],
  );

  const openCreate = () => setEditor({ draft: emptySubagentDraft(), editing: null });
  const ownedHandles = useMemo(() => new Set(owned.map((row) => row.id)), [owned]);
  const searching = Boolean(search.trim());
  const noMatches = searching && visibleOwned.length === 0 && visibleBuiltins.length === 0;
  const showOwnedGroup = !searching || visibleOwned.length > 0;

  const renderBuiltin = (definition: SubagentDefinition & { enabled: boolean }) => {
    const handle = definition.name;
    const canCopy = !ownedHandles.has(handle);
    const busy = busyId === `builtin:${handle}`;
    return (
      <CapabilityRow
        key={`builtin:${handle}`}
        glyph={<Bot className="size-4" />}
        name={builtinDisplayName(handle, tf)}
        off={!definition.enabled}
        command={`Task(${handle})`}
        badges={<CapabilityBadge label={t("subagentBuiltinBadge")} />}
        description={definition.description || t("subagentNoDescription")}
        meta={definition.tools.map((tool) => <CapabilityToolChip key={tool} tool={tool} />)}
        actions={
          <>
            {canCopy ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("subagentCopy")}
                title={t("subagentCopy")}
                onClick={() => copyBuiltin(definition)}
              >
                <Copy className="size-3.5" />
              </Button>
            ) : null}
            <CapabilityToggle
              checked={definition.enabled}
              busy={busy}
              label={`${t("subagentToggle")} ${builtinDisplayName(handle, tf)}`}
              onChange={() => toggleBuiltin(definition)}
            />
          </>
        }
      />
    );
  };

  const renderRow = (record: UserSubagentRecord) => {
    const busy = busyId === record.id;
    const isArmed = armed === record.id;
    return (
      <CapabilityRow
        key={record.id}
        glyph={<Bot className="size-4" />}
        name={record.name}
        off={!record.enabled}
        command={`Task(${record.name})`}
        badges={<CapabilityBadge label={t("subagentGlobalOnlyBadge")} />}
        description={record.description || t("subagentNoDescription")}
        meta={record.tools.map((tool) => <CapabilityToolChip key={tool} tool={tool} />)}
        actions={
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("subagentEdit")}
              title={t("subagentEdit")}
              disabled={busy}
              onClick={() => openEdit(record)}
            >
              <Pencil className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("subagentReveal")}
              title={t("subagentReveal")}
              disabled={busy}
              onClick={() => reveal(record)}
            >
              <FolderOpen className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={isArmed ? t("subagentRemoveConfirm") : t("subagentDelete")}
              title={isArmed ? t("subagentRemoveConfirm") : t("subagentDelete")}
              disabled={busy}
              className={isArmed ? "text-red-500 hover:bg-red-500/10" : undefined}
              onClick={() => {
                if (isArmed) void remove(record);
                else setArmed(record.id);
              }}
            >
              <Trash2 className="size-3.5" />
            </Button>
            <CapabilityToggle
              checked={record.enabled}
              busy={busy}
              label={`${t("subagentToggle")} ${record.name}`}
              onChange={() => toggleUser(record)}
            />
          </>
        }
      />
    );
  };

  const addButton = (
    <Button size="sm" onClick={openCreate}>
      <Plus className="size-3.5" />
      {t("subagentAdd")}
    </Button>
  );

  return (
    <AgentCapabilityPage
      className="space-y-4"
      toolbar={
        <CapabilityToolbar
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder={t("subagentSearchPlaceholder")}
          actions={addButton}
        />
      }
    >
      <CapabilityPanel loading={loading} loadingLabel={t("subagentLoading")}>
        {noMatches ? (
          <CapabilityEmpty message={t("subagentNoMatches")} />
        ) : (
          <>
            {visibleBuiltins.length > 0 ? (
              <>
                <CapabilityGroupHeader
                  label={t("subagentGroupBuiltin")}
                  count={visibleBuiltins.length}
                />
                {visibleBuiltins.map(renderBuiltin)}
              </>
            ) : null}
            {showOwnedGroup ? (
              <>
                <CapabilityGroupHeader
                  label={t("subagentGroupGlobal")}
                  path={SUBAGENTS_DIR_DISPLAY}
                  count={visibleOwned.length}
                />
                {visibleOwned.length === 0 ? (
                  <CapabilityEmpty message={t("subagentEmptyTitle")} action={addButton} />
                ) : (
                  visibleOwned.map(renderRow)
                )}
              </>
            ) : null}
          </>
        )}
      </CapabilityPanel>

      {editor ? (
        <SubagentEditorSheet
          draft={editor.draft}
          setDraft={(draft) => setEditor((current) => (current ? { ...current, draft } : current))}
          modelOptions={modelOptions}
          isCreate={editor.editing === null}
          saving={saving}
          onClose={() => {
            if (!saving) setEditor(null);
          }}
          onSave={() => void save()}
        />
      ) : null}
    </AgentCapabilityPage>
  );
}

/** 名称转 slug（保存前最后一道规范化；与编辑器提示一致）。 */
function subagentSafeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
