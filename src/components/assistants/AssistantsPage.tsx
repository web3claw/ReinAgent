/**
 * AssistantsPage —— 助手管理页（侧栏「助手」入口的全页视图）。
 *
 * 卡片列表（内置 + 自定义两组）：名称/描述 + 设为全局默认 + 新建/编辑/删除。
 * 本页只管全局默认助手（kv，对未单独设置的任务生效）；任务作用域唯一入口是
 * 聊天页任务名旁的 AssistantChip 下拉（按任务记忆）。
 * 助手 = 纯人设（名称 slug / 描述 / 人设指令），不携带模型/推理预设——
 * 模型与推理强度一律跟随设置里的默认。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Globe, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useHubSettings } from "../../store/hubSettingsStore";
import * as skillsLib from "../../lib/skills/index";
import { buildAssistantBindingsPlan } from "../../lib/assistants/assistantBindings";
import { useTranslation } from "../../i18n";
import { toast } from "../lw/ui/toast";
import { useAppStore } from "../../store/useAppStore";
import {
  GENERAL_ASSISTANT_ID,
  assistantSlug,
  fallbackAssistantId,
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
  /** 表单里的名字（支持中文）。 */
  name: string;
  /** 稳定 ASCII id（新增时打开编辑器的瞬间固定一次；中文名回退 assistant-xxxxxx）。 */
  draftId: string;
  description: string;
  prompt: string;
  /** 一键预设绑定（2026-10-11 用户定稿）：model = "providerId/modelId"；未绑 = 维持现状。 */
  model: string;
  thinkingLevel: string;
  skills: string[];
  mcpServers: string[];
}

/** 思考等级七档（与 useAppStore ThinkingLevel / composer THINKING_OPTIONS 同值域）。 */
const THINKING_LEVEL_OPTIONS: { value: string; label: string }[] = [
  { value: "off", label: "Off / 关闭" },
  { value: "default", label: "Default / 默认" },
  { value: "low", label: "Low / 低" },
  { value: "medium", label: "Medium / 中" },
  { value: "high", label: "High / 高" },
  { value: "xhigh", label: "XHigh / 极高" },
  { value: "max", label: "Max / 最大" },
];

const emptyDraft = (): Draft => ({
  editingId: null,
  name: "",
  draftId: "",
  description: "",
  prompt: "",
  model: "",
  thinkingLevel: "",
  skills: [],
  mcpServers: [],
});

export function AssistantsPage() {
  const { t } = useTranslation();
  // 动态 i18n 键（assistant* 查表）需要 string 签名
  const tf = t as unknown as (key: string) => string;
  // 助手页只管全局默认：任务作用域唯一入口是聊天页任务名旁的 AssistantChip
  const globalDefaultAssistantId = useAppStore((s) => s.globalDefaultAssistantId);
  const setGlobalDefaultAssistant = useAppStore((s) => s.setGlobalDefaultAssistant);
  const hubMcpServers = useHubSettings((s) => s.settings.mcp.servers);
  const hubSetSettings = useHubSettings((s) => s.setSettings);
  // 编辑器模型选项数据源（loadProvidersConfigFromDisk 与 ModelPicker 同源）；挂载时拉一次
  const providersRef = useRef<{ id: string; name: string; enabled: boolean; models: { id: string; name: string; enabled: boolean }[] }[]>([]);
  useEffect(() => {
    void (async () => {
      try {
        const { loadProvidersConfigFromDisk } = await import("../settings/model-provider/types");
        providersRef.current = await loadProvidersConfigFromDisk();
        setProvidersVersion((v) => v + 1);
      } catch (err) {
        console.warn("[assistants] provider load failed:", err);
      }
    })();
  }, []);
  const [providersVersion, setProvidersVersion] = useState(0);
  const [catalog, setCatalog] = useState<AssistantDef[]>([]);
  const [userPaths, setUserPaths] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);

  const reload = useCallback(async () => {
    const cat = await loadAssistantCatalog();
    setCatalog(cat.assistants);
    setUserPaths(cat.userPaths);
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

  // 编辑器选项：技能 = 发现清单（与发送注入同源 discoverSkills）；模型/MCP 见下方 memo。
  const [skillOptions, setSkillOptions] = useState<{ id: string; name: string; description?: string }[]>([]);
  useEffect(() => {
    void (async () => {
      try {
        const discovery = await skillsLib.discoverSkills();
        setSkillOptions(
          discovery.skills.map((sk: { name: string; description?: string }) => ({
            id: sk.name,
            name: sk.name,
            description: sk.description,
          })),
        );
      } catch (err) {
        console.warn("[assistants] skill discovery failed:", err);
      }
    })();
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- providersRef 变化经 providersVersion 显式触发
  const modelOptions = useMemo(() => {
    const providers = providersRef.current;
    return providers
      .filter((prov) => prov.enabled !== false)
      .flatMap((prov) =>
        prov.models
          .filter((m) => m.enabled !== false)
          .map((m) => ({ value: `${prov.id}/${m.id}`, label: `${prov.name || prov.id}/${m.name || m.id}` })),
      );
    // providersVersion 参与以触发重算
  }, [providersVersion]);

  const mcpOptions = useMemo(
    () =>
      hubMcpServers.map((srv: { id: string; description?: string }) => ({
        id: srv.id,
        label: srv.id,
        description: srv.description,
      })),
    [hubMcpServers],
  );

  const applyGlobal = (def: AssistantDef) => {
    setGlobalDefaultAssistant(def.id);
    // 一键预设包：全局默认切换同样套用绑定（对后续新任务生效；当前任务经 chip 选择时套用）
    applyBindings(def, null);
  };

  /** 套用助手绑定（任务字段 + hubSettings 启用集）；taskId=null = 不写任务字段（全局默认路径）。 */
  const applyBindings = (def: AssistantDef | null, taskId: string | null) => {
    const plan = buildAssistantBindingsPlan(
      def,
      hubMcpServers.map((srv) => srv.id),
    );
    const store = useAppStore.getState();
    if (plan.taskModel && taskId) {
      store.updateTaskModel(taskId, plan.taskModel.providerId, plan.taskModel.modelId);
    }
    if (plan.taskThinkingLevel && taskId) {
      store.updateTaskThinkingLevel(taskId, plan.taskThinkingLevel);
    }
    if (plan.skillSelection) {
      hubSetSettings((prev) => ({
        ...prev,
        skills: { ...prev.skills, selected: plan.skillSelection! },
      }));
    }
    if (plan.mcpEnabledIds) {
      const enabledSet = new Set(plan.mcpEnabledIds);
      hubSetSettings((prev) => ({
        ...prev,
        mcp: {
          ...prev.mcp,
          servers: prev.mcp.servers.map((srv) => ({ ...srv, enabled: enabledSet.has(srv.id) })),
        },
      }));
    }
    if (plan.summary) {
      toast.success(`已应用助手绑定：${plan.summary}`);
    }
  };

  const save = async () => {
    if (!draft) return;
    try {
      const slug = assistantSlug(draft.name);
      const savedId = draft.editingId ?? (slug || draft.draftId);
      await saveUserAssistant({
        id: savedId,
        name: draft.name.trim(),
        description: draft.description.trim(),
        prompt: draft.prompt,
        model: draft.model.trim() || undefined,
        thinkingLevel: draft.thinkingLevel.trim() || undefined,
        skills: draft.skills.length > 0 ? draft.skills : undefined,
        mcpServers: draft.mcpServers.length > 0 ? draft.mcpServers : undefined,
      });
      await reload();
      // 保存后立即重新套用绑定（2026-10-12 用户实测「勾了技能面板仍 0%」）：
      // 编辑 ≠ 生效的断层在这里闭合——该助手若是当前全局默认，技能/MCP 启用集
      // 与全局默认的新任务模型即时跟上；任务作用域的重新套用走聊天页 chip。
      if (globalDefaultAssistantId === savedId) {
        const def = catalog.find((d) => d.id === savedId) ?? null;
        applyBindings(def, null);
      }
      setDraft(null);
    } catch (err) {
      console.error("[assistants] save failed:", err);
      toast.error(String(err instanceof Error ? err.message : err).slice(0, 200));
    }
  };

  /** 被编辑遮蔽的内置助手「重置」：删遮蔽文件恢复出厂预设（内置常量仍在）。 */
  const resetBuiltin = async (def: AssistantDef) => {
    try {
      await deleteAssistantById(def.id);
      await reload();
    } catch (err) {
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
        command={isGeneral ? undefined : `#${def.name}`}
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
            {/* 内置助手同样可编辑（2026-10-12 用户定稿）：保存为同名用户文件遮蔽内置
                （catalog 加载时用户同名覆盖内置，机制现成）；删除按钮仍按原保护语义 */}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("edit")}
              title={t("edit")}
              onClick={() =>
                setDraft({
                  editingId: def.id,
                  name: def.name,
                  draftId: def.id,
                  description: def.description,
                  prompt: def.prompt,
                  model: def.model ?? "",
                  thinkingLevel: def.thinkingLevel ?? "",
                  skills: def.skills ?? [],
                  mcpServers: def.mcpServers ?? [],
                })
              }
            >
              <Pencil className="size-3.5" />
            </Button>
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
            {def.builtin && userPaths[def.id] ? (
              // 被编辑遮蔽的内置：删除不可用，改提供「重置」（删遮蔽文件恢复出厂预设）
              <ConfirmActionPopover
                title={tf("assistantResetTitle")}
                description={tf("assistantResetDesc").replace("{name}", def.name)}
                confirmLabel={t("confirm")}
                cancelLabel={t("cancel")}
                onConfirm={() => void resetBuiltin(def)}
              >
                {(open) => (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={tf("assistantResetTitle")}
                    title={tf("assistantResetTitle")}
                    onClick={open}
                  >
                    <RotateCcw className="size-3.5" />
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
          onClick={() => setDraft({ ...emptyDraft(), draftId: fallbackAssistantId() })}
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
          modelOptions={modelOptions}
          skillOptions={skillOptions}
          mcpOptions={mcpOptions}
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
  modelOptions,
  skillOptions,
  mcpOptions,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  onClose: () => void;
  onSave: () => void;
  modelOptions: { value: string; label: string }[];
  skillOptions: { id: string; name: string; description?: string }[];
  mcpOptions: { id: string; label: string; description?: string }[];
}) {
  const { t } = useTranslation();
  // 动态键（assistantBindings*）查表签名
  const tf = t as unknown as (key: string) => string;
  const [error, setError] = useState<string | null>(null);
  const isCreate = draft.editingId === null;
  // 保存用的稳定 id：ASCII 名转 slug；中文名用打开编辑器时固定的 draftId
  const slug = assistantSlug(draft.name);
  const effectiveId = draft.editingId ?? (slug || draft.draftId);
  const saveDisabled =
    !draft.name.trim() || !effectiveId || !draft.description.trim() || !draft.prompt.trim();

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[92vh] max-w-xl flex-col" closeLabel={t("cancel")}>
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
            {draft.name.trim() && effectiveId ? (
              <p className="text-[11px] text-[var(--text-dim)]">
                {t("subagentSlugHint").replace("{id}", effectiveId)}
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

          {/* 一键预设绑定（2026-10-11 用户定稿）：应用助手时一次性套用；未绑定维度维持现状 */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-[var(--text-dim)]">{tf("assistantBindingsTitle")}</label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-xs text-[var(--text-dim)]">{tf("assistantBindingsModel")}</label>
                <select
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1.5 text-sm text-[var(--text-primary)]"
                  value={draft.model}
                  onChange={(e) => setDraft({ ...draft, model: e.currentTarget.value })}
                >
                  <option value="">（不绑定 — 维持现状）</option>
                  {modelOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-[var(--text-dim)]">{tf("assistantBindingsThinking")}</label>
                <select
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1.5 text-sm text-[var(--text-primary)]"
                  value={draft.thinkingLevel}
                  onChange={(e) => setDraft({ ...draft, thinkingLevel: e.currentTarget.value })}
                >
                  <option value="">（不绑定 — 维持现状）</option>
                  {THINKING_LEVEL_OPTIONS.map((level) => (
                    <option key={level.value} value={level.value}>
                      {level.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-xs text-[var(--text-dim)]">{tf("assistantBindingsSkills")}</label>
                <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border border-[var(--border)] p-2">
                  {skillOptions.length === 0 ? (
                    <p className="text-xs text-[var(--text-dim)]">（无可用技能）</p>
                  ) : (
                    skillOptions.map((skill) => (
                      <label key={skill.id} className="flex cursor-pointer items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="accent-[var(--brand)]"
                          checked={draft.skills.includes(skill.id)}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              skills: e.currentTarget.checked
                                ? [...draft.skills, skill.id]
                                : draft.skills.filter((id) => id !== skill.id),
                            })
                          }
                        />
                        <span className="min-w-0 truncate" title={skill.description || skill.id}>
                          {skill.name || skill.id}
                        </span>
                      </label>
                    ))
                  )}
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-[var(--text-dim)]">{tf("assistantBindingsMcp")}</label>
                <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border border-[var(--border)] p-2">
                  {mcpOptions.length === 0 ? (
                    <p className="text-xs text-[var(--text-dim)]">（无已配置 MCP 服务器）</p>
                  ) : (
                    mcpOptions.map((srv) => (
                      <label key={srv.id} className="flex cursor-pointer items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="accent-[var(--brand)]"
                          checked={draft.mcpServers.includes(srv.id)}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              mcpServers: e.currentTarget.checked
                                ? [...draft.mcpServers, srv.id]
                                : draft.mcpServers.filter((id) => id !== srv.id),
                            })
                          }
                        />
                        <span className="min-w-0 truncate font-mono" title={srv.description}>
                          {srv.label}
                        </span>
                      </label>
                    ))
                  )}
                </div>
              </div>
            </div>
            <p className="text-[11px] text-[var(--text-dim)]">{tf("assistantBindingsHint")}</p>
          </div>

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
              // 校验与 saveDisabled 同口径：中文名用 draftId 兜底，不再要求 slug
              if (!draft.name.trim() || !effectiveId) {
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

