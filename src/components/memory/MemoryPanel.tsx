// LiveAgent 移植：crates/agent-ui/src/pages/settings/memory/MemoryPanel.tsx
//         + crates/agent-ui/src/pages/resources/ResourceManagementPage.tsx（Hub 外壳）
// Memory settings panel: entry list/filters, quota display, create/edit/
// accept/delete/wipe, plus mounting the settings drawer (which owns the
// organizer history modal).
//
// 适配：
// - 导出形态：MemoryPanel({ workdir?, modelOptions? })。workdir=当前工作区根
//   （project 作用域数据源，LA settings.system.workdir 对应物）；modelOptions=
//   整理/总结模型选择器选项（App 侧接线，缺省空数组时 ModelPicker 如实显示空）；
//   settings/setSettings 改由 useHubSettings 提供；
// - 外壳组合：HubHeader(title=settings.navMemory, subtitle=
//   settings.memoryBrowseDescription, prominent) + MemoryPanelInner，
//   页面最外层追加 hub-scope（LA ResourceManagementPage 的 memory 分支）；
// - 图标 → lucide-react 同名；LA web:max-820:* 变体 → max-[820px]:*；
//   LA tokens 类（gap-12px / pb-settings-memory-panel-pb /
//   max-h-settings-memory-entry-list-max-h / min-h-auto）改写为等值 arbitrary 类；
// - ConfirmDeletePopover 文案必填 props 注入（lw 适配约定）；
// - 所有 Portal 弹层（新建 Dialog / 设置抽屉 / Select 弹出层）className 追加
//   hub-scope。

import {
  AlertTriangle,
  Check,
  ChevronDown,
  Folder,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { MemoryMeta } from "../../lib/memory/api";
import { MEMORY_TYPES, type MemoryType } from "../../lib/memory/schema";
import { useHubSettings, type HubAppSettings } from "../../store/hubSettingsStore";
import { useTranslation } from "../../i18n";
import { HubHeader } from "../lw/hub/HubChrome";
import { SettingsNotice } from "../lw/settings/SettingsNotice";
import { ConfirmDeletePopover } from "../lw/ui/confirm-action-popover";
import { Button, RefreshButton } from "../lw/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../lw/ui/dialog";
import { Input } from "../lw/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../lw/ui/select";
import { Tabs, TabsList, TabsTrigger } from "../lw/ui/tabs";
import { Textarea } from "../lw/ui/textarea";
import { toast } from "../lw/ui/toast";
import { cn } from "../lw/lib/utils";
import { MemorySettingsDrawer } from "./MemorySettingsDrawer";
import {
  createMemoryTranslate,
  entryKey,
  entryTitle,
  fallbackScopeQuotas,
  formatTime,
  type MemoryModelOption,
  type MemoryTab,
  type MemoryTranslate,
  matchesFilter,
  memoryScopeLabel,
  memoryTypeLabel,
  projectLabel,
  selectedTitle,
  strongestQuotaLevel,
} from "./panelModel";
import { type MemoryCreateDraft, useMemoryPanelData } from "./useMemoryPanelData";

const EMPTY_CREATE_DRAFT: MemoryCreateDraft = {
  slug: "",
  scope: "global",
  memoryType: "user",
  description: "",
  body: "",
};

/** Hub 页外壳：LA ResourceManagementPage 的 memory 分支（prominent 大标题）。 */
export function MemoryPanel(props: {
  workdir?: string;
  modelOptions?: MemoryModelOption[];
}) {
  const { t: translate, locale } = useTranslation();
  const settings = useHubSettings((state) => state.settings);
  const setSettings = useHubSettings((state) => state.setSettings);
  const t = useMemo(() => createMemoryTranslate(translate, locale), [translate, locale]);
  const workdir = props.workdir?.trim() || undefined;
  const modelOptions = useMemo(() => props.modelOptions ?? [], [props.modelOptions]);
  return (
    <div
      className={cn(
        "hub-page hub-scope relative flex h-full min-h-0 flex-1 flex-col overflow-hidden",
        "bg-background",
      )}
    >
      <HubHeader title={t("settings.navMemory")} prominent />
      <div className="hub-scroll flex min-h-0 flex-1 flex-col overflow-hidden px-5 pb-6 sm:px-6 lg:px-8 xl:px-10">
        <div className="mx-auto flex min-h-0 w-full max-w-1320px flex-1 flex-col">
          <MemoryPanelInner
            workdir={workdir}
            modelOptions={modelOptions}
            settings={settings}
            setSettings={setSettings}
            t={t}
          />
        </div>
      </div>
    </div>
  );
}

function MemoryPanelInner(props: {
  workdir?: string;
  modelOptions: MemoryModelOption[];
  settings: HubAppSettings;
  setSettings: (updater: (prev: HubAppSettings) => HubAppSettings) => void;
  t: MemoryTranslate;
}) {
  const workdir = props.workdir?.trim() || undefined;
  const t = props.t;
  const [tab, setTab] = useState<MemoryTab>("global");
  const [filter, setFilter] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [settingsDrawerOpen, setSettingsDrawerOpen] = useState(false);
  const [refreshState, setRefreshState] = useState<"idle" | "refreshing">("idle");
  const [draft, setDraft] = useState<MemoryCreateDraft>(EMPTY_CREATE_DRAFT);
  const {
    entries,
    quota,
    selected,
    selectedEntry,
    pathsInfo,
    loading,
    error,
    saving,
    editDraft,
    setEditDraft,
    reload,
    openEntry,
    createEntry,
    saveSelected,
    acceptSelected,
    deleteSelected,
    wipeAll,
  } = useMemoryPanelData({ workdir, t });

  async function handleRefresh() {
    if (refreshState !== "idle") return;
    setRefreshState("refreshing");
    try {
      const refreshed = await reload();
      if (refreshed) toast.success(t("settings.memoryRefreshComplete"));
      else toast.error(t("settings.memoryRefreshFailed"));
    } finally {
      setRefreshState("idle");
    }
  }

  const globalEntries = useMemo(() => {
    return entries
      .filter((entry) => entry.scope === "global" && entry.memoryType !== "daily")
      .filter((entry) => matchesFilter(entry, filter));
  }, [entries, filter]);

  const dailyEntries = useMemo(() => {
    return entries
      .filter((entry) => entry.memoryType === "daily")
      .filter((entry) => matchesFilter(entry, filter));
  }, [entries, filter]);

  const projectGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        key: string;
        label: string;
        latestUpdatedAt: number;
        entries: MemoryMeta[];
      }
    >();
    for (const entry of entries) {
      if (entry.scope !== "project" || entry.memoryType === "daily") continue;
      if (!matchesFilter(entry, filter)) continue;
      const key = entry.workdirHash || entry.workdirPath || "unknown";
      const label = projectLabel(entry, t);
      const group = groups.get(key) ?? {
        key,
        label,
        latestUpdatedAt: 0,
        entries: [],
      };
      group.latestUpdatedAt = Math.max(group.latestUpdatedAt, entry.updatedAt);
      group.entries.push(entry);
      groups.set(key, group);
    }
    return Array.from(groups.values())
      .map((group) => ({
        ...group,
        entries: group.entries.sort((a, b) =>
          b.updatedAt === a.updatedAt ? a.slug.localeCompare(b.slug) : b.updatedAt - a.updatedAt,
        ),
      }))
      .sort((a, b) =>
        b.latestUpdatedAt === a.latestUpdatedAt
          ? a.label.localeCompare(b.label)
          : b.latestUpdatedAt - a.latestUpdatedAt,
      );
  }, [entries, filter, t]);

  const projectEntryCount = entries.filter(
    (entry) => entry.scope === "project" && entry.memoryType !== "daily",
  ).length;
  const globalEntryCount = entries.filter(
    (entry) => entry.scope === "global" && entry.memoryType !== "daily",
  ).length;
  const dailyEntryCount = entries.filter((entry) => entry.memoryType === "daily").length;
  const unreviewedCount = entries.filter((entry) => entry.unreviewed).length;
  const quotaItems = useMemo(
    () => fallbackScopeQuotas(entries, quota, Boolean(workdir)),
    [entries, quota, workdir],
  );
  const quotaStatus = strongestQuotaLevel(quotaItems);

  async function handleCreateEntry() {
    const created = await createEntry(draft);
    if (created) {
      setTab(draft.scope);
      setShowCreate(false);
      setDraft(EMPTY_CREATE_DRAFT);
    }
  }

  const activeEntryKey = selectedEntry ? entryKey(selectedEntry) : null;

  function renderEntryButton(entry: MemoryMeta) {
    const active = activeEntryKey === entryKey(entry);
    return (
      <Button
        key={entryKey(entry)}
        variant="ghost"
        aria-pressed={active}
        onClick={() => openEntry(entry)}
        className={cn(
          "h-auto w-full flex-col items-stretch justify-start whitespace-normal rounded-lg",
          "px-3 py-2.5 text-left font-normal",

          active
            ? "bg-settings-active text-foreground"
            : entry.unreviewed
              ? "bg-settings-tile-hover hover:bg-settings-active"
              : "bg-transparent hover:bg-settings-tile-hover",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 truncate text-xs font-semibold">{entryTitle(entry)}</div>
          <div className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-tiny text-muted-foreground">
            {memoryTypeLabel(entry.memoryType, t)}
          </div>
        </div>
        <div className="mt-1 truncate font-mono text-xs text-muted-foreground/70">
          id: {entry.slug}
        </div>
      </Button>
    );
  }

  function renderFlatEntries(items: MemoryMeta[], emptyKey: string) {
    if (items.length === 0) {
      return (
        <div
          className={cn(
            "rounded-lg bg-settings-tile px-4 py-8",
            "text-center text-xs text-muted-foreground",
          )}
        >
          {t(emptyKey)}
        </div>
      );
    }
    return <div className="space-y-1.5">{items.map((entry) => renderEntryButton(entry))}</div>;
  }

  return (
    <>
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-4",
          "max-[820px]:min-h-[auto] max-[820px]:flex-none max-[820px]:gap-3 max-[820px]:pb-[max(14px,env(safe-area-inset-bottom))]",
        )}
      >
        <div className="shrink-0 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="text-sm text-muted-foreground">
                {t("settings.memoryBrowseDescription")}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 max-[820px]:w-full max-[820px]:items-stretch">
              {quotaItems.map((item) => {
                const label =
                  item.scope === "global"
                    ? t("settings.memoryQuotaGlobal")
                    : t("settings.memoryQuotaProject");
                return (
                  <div
                    key={`${item.scope}:${item.workdirHash}`}
                    className="text-xs text-muted-foreground"
                  >
                    {label} {item.used} / {item.limit}
                  </div>
                );
              })}

              <RefreshButton
                aria-busy={loading || refreshState === "refreshing"}
                variant="outline"
                size="sm"
                onClick={() => void handleRefresh()}
                disabled={loading || refreshState !== "idle"}
              >
                <RefreshCw
                  className={cn(
                    "size-3.5",
                    loading || refreshState === "refreshing" ? "animate-spin" : "",
                  )}
                />
                {t("settings.memoryRefresh")}
              </RefreshButton>
              <Button
                size="sm"
                onClick={() => {
                  setDraft({
                    ...EMPTY_CREATE_DRAFT,
                    scope: tab === "project" ? "project" : "global",
                    memoryType: "user",
                  });
                  setShowCreate(true);
                }}
              >
                <Plus className="size-3.5" />
                {t("settings.memoryNew")}
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                title={t("settings.memoryOpenSettings")}
                aria-label={t("settings.memoryOpenSettings")}
                onClick={() => setSettingsDrawerOpen(true)}
              >
                <Settings2 className="size-3.5" />
              </Button>
            </div>
          </div>

          {unreviewedCount > 0 ? (
            <div
              className={cn(
                "mt-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2",
                "text-xs text-amber-700 dark:text-amber-300",
              )}
            >
              {unreviewedCount} {t("settings.memoryAwaitingReview")}
            </div>
          ) : null}
          {pathsInfo?.isInCloud ? (
            <div
              className={cn(
                "mt-3 flex items-start gap-2",
                "rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-700",
                "dark:text-amber-300",
              )}
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {t("settings.memoryCloudWarningPrefix")}{" "}
              {pathsInfo.cloudProvider ?? t("settings.memoryCloudSyncFolder")}
            </div>
          ) : null}
          {quotaStatus === "full" || quotaStatus === "danger" ? (
            <div
              className={cn(
                "mt-3 flex items-start gap-2",
                "rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-xs text-red-700",
                "dark:text-red-300",
              )}
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {t(
                quotaStatus === "full"
                  ? "settings.memoryQuotaFullMessage"
                  : "settings.memoryQuotaNearLimitMessage",
              )}
            </div>
          ) : quotaStatus === "warning" ? (
            <div
              className={cn(
                "mt-3 flex items-start gap-2",
                "rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-700",
                "dark:text-amber-300",
              )}
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {t("settings.memoryQuotaWarningMessage")}
            </div>
          ) : null}
          {error ? (
            <SettingsNotice variant="multiline-error" className="mt-3">
              {error}
            </SettingsNotice>
          ) : null}
        </div>

        <div
          className={cn(
            "grid min-h-0 flex-1 gap-4",
            "lg:grid-cols-[20rem_minmax(0,1fr)] max-[820px]:flex max-[820px]:min-h-[auto] max-[820px]:flex-none max-[820px]:flex-col max-[820px]:gap-3",
          )}
        >
          <section
            className={cn(
              "flex min-h-0 flex-col",
              "rounded-xl bg-settings-tile",
              "max-[820px]:min-h-[auto] max-[820px]:overflow-visible max-[820px]:rounded-12px",
            )}
          >
            <div className="shrink-0 space-y-3 border-b border-border/40 p-3">
              <Tabs
                value={tab}
                onValueChange={(value) => {
                  if (value === "global" || value === "project" || value === "journal") {
                    setTab(value);
                  }
                }}
              >
                <TabsList
                  aria-label={t("settings.memoryTitle")}
                  variant="segmented"
                  className="grid w-full grid-cols-3"
                >
                  <TabsTrigger variant="segmented" value="global" className="min-w-0 gap-1.5 px-2">
                    <span className="truncate">{t("settings.memoryCategoryGlobal")}</span>
                    <span className="shrink-0 text-tiny text-muted-foreground">
                      {globalEntryCount}
                    </span>
                  </TabsTrigger>
                  <TabsTrigger variant="segmented" value="project" className="min-w-0 gap-1.5 px-2">
                    <span className="truncate">{t("settings.memoryCategoryProject")}</span>
                    <span className="shrink-0 text-tiny text-muted-foreground">
                      {projectEntryCount}
                    </span>
                  </TabsTrigger>
                  <TabsTrigger variant="segmented" value="journal" className="min-w-0 gap-1.5 px-2">
                    <span className="truncate">{t("settings.memoryCategoryJournal")}</span>
                    <span className="shrink-0 text-tiny text-muted-foreground">
                      {dailyEntryCount}
                    </span>
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
                  <Input
                    variant="plain"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    className="pl-8 text-xs"
                    placeholder={t("settings.memorySearchPlaceholder")}
                  />
                </div>
              </div>
            </div>

            <div
              className={cn(
                "min-h-0 flex-1 overflow-auto p-2",
                "max-[820px]:max-h-[min(42svh,320px)] max-[820px]:flex-initial max-[820px]:overflow-y-auto max-[820px]:overscroll-y-contain max-[820px]:[-webkit-overflow-scrolling:touch]",
              )}
            >
              {tab === "global" ? (
                renderFlatEntries(globalEntries, "settings.memoryNoGlobalEntries")
              ) : tab === "journal" ? (
                renderFlatEntries(dailyEntries, "settings.memoryNoJournalEntries")
              ) : projectGroups.length === 0 ? (
                <div
                  className={cn(
                    "rounded-lg bg-settings-tile px-4 py-8",
                    "text-center text-xs text-muted-foreground",
                  )}
                >
                  {t("settings.memoryNoProjectEntries")}
                </div>
              ) : (
                <div className="space-y-2">
                  {projectGroups.map((group) => (
                    <details key={group.key} className="group rounded-lg" open>
                      <summary
                        className={cn(
                          "flex cursor-pointer list-none",
                          "items-center gap-2 px-3 py-2.5 text-left text-xs [&::-webkit-details-marker]:hidden",
                        )}
                      >
                        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-0 -rotate-90" />
                        <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate font-medium" title={group.label}>
                          {group.label}
                        </span>
                        <span className="shrink-0 rounded bg-background px-1.5 py-0.5 text-tiny text-muted-foreground">
                          {group.entries.length}
                        </span>
                      </summary>
                      <div className="space-y-1.5 border-t border-border/40 p-2">
                        {group.entries.map((entry) => renderEntryButton(entry))}
                      </div>
                    </details>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section
            className={cn(
              "flex min-h-0 flex-col",
              "rounded-xl bg-settings-tile",
              "max-[820px]:min-h-[auto] max-[820px]:overflow-visible max-[820px]:rounded-12px",
            )}
          >
            {selected ? (
              <>
                <div className="shrink-0 border-b border-border/40 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="truncate text-sm font-semibold">
                          {selectedTitle(selected)}
                        </div>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-tiny text-muted-foreground">
                          {memoryScopeLabel(selected.scope, t)}
                        </span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-tiny text-muted-foreground">
                          {memoryTypeLabel(selected.memoryType, t)}
                        </span>
                        {selected.meta.unreviewed ? (
                          <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-tiny text-amber-700 dark:text-amber-300">
                            {t("settings.memoryUnreviewed")}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {t("settings.memoryUpdated")} {formatTime(selected.meta.updatedAt)}
                      </div>
                      <div className="mt-1 truncate font-mono text-xs text-muted-foreground/70">
                        id: {selected.slug}
                      </div>
                      {selectedEntry?.scope === "project" ? (
                        <div className="mt-1 truncate font-mono text-xs text-muted-foreground/70">
                          {selectedEntry.workdirPath || selectedEntry.workdirHash}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      {selected.meta.unreviewed && selected.memoryType !== "daily" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={acceptSelected}
                          disabled={saving}
                        >
                          <Check className="size-3.5" />
                          {t("settings.memoryAccept")}
                        </Button>
                      ) : null}
                      <ConfirmDeletePopover
                        name={selectedTitle(selected)}
                        title={t("settings.deleteConfirm")}
                        confirmLabel={t("settings.delete")}
                        cancelLabel={t("settings.cancel")}
                        description={(name) => (
                          <>
                            {t("settings.deleteConfirmYes")}{" "}
                            <span className="font-medium text-foreground">{name}</span>？
                            {t("settings.deleteConfirmDesc")}
                          </>
                        )}
                        onConfirm={() => {
                          if (!saving) void deleteSelected();
                        }}
                      >
                        {(open) => (
                          <Button
                            onClick={open}
                            variant="ghost"
                            size="icon-sm"
                            disabled={saving}
                            aria-label={t("settings.memoryDelete")}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        )}
                      </ConfirmDeletePopover>
                    </div>
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-auto p-4 max-[820px]:min-h-[auto] max-[820px]:flex-none max-[820px]:overflow-visible">
                  {selected.memoryType === "daily" ? (
                    <div className="space-y-3">
                      <Textarea
                        variant="plain"
                        value={editDraft.appendBody}
                        onChange={(event) =>
                          setEditDraft((prev) => ({
                            ...prev,
                            appendBody: event.target.value,
                          }))
                        }
                        className="min-h-24 resize-y"
                        placeholder={t("settings.memoryAppendBlockPlaceholder")}
                      />
                      <div className="rounded-lg border border-border/50 bg-muted/20 p-3">
                        <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">
                          {selected.body || t("settings.memoryEmptyBody")}
                        </pre>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <Input
                        variant="plain"
                        value={editDraft.description}
                        onChange={(event) =>
                          setEditDraft((prev) => ({
                            ...prev,
                            description: event.target.value,
                          }))
                        }
                        placeholder={t("settings.memoryDescriptionPlaceholder")}
                      />
                      <Textarea
                        variant="plain"
                        aria-label={t("settings.memoryBodyPlaceholder")}
                        value={editDraft.body}
                        onChange={(event) =>
                          setEditDraft((prev) => ({
                            ...prev,
                            body: event.target.value,
                          }))
                        }
                        className="min-h-360px resize-y font-mono text-xs leading-relaxed"
                      />
                    </div>
                  )}
                </div>

                <div className="shrink-0 border-t border-border/40 p-4">
                  <div className="flex justify-end gap-3">
                    <Button size="sm" onClick={saveSelected} disabled={saving}>
                      {t("settings.memorySave")}
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <div
                className={cn(
                  "flex min-h-0 flex-1 items-center justify-center p-8",
                  "text-center text-sm text-muted-foreground",
                )}
              >
                {t("settings.memorySelectEntry")}
              </div>
            )}
          </section>
        </div>
      </div>

      {showCreate ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!saving) setShowCreate(open);
          }}
        >
          <DialogContent
            className="hub-scope max-w-xl"
            showCloseButton
            closeDisabled={saving}
            closeLabel={t("settings.memoryCancel")}
          >
            <DialogHeader>
              <DialogTitle>{t("settings.memoryNew")}</DialogTitle>
            </DialogHeader>
            <DialogBody>
              {error ? <SettingsNotice variant="multiline-error">{error}</SettingsNotice> : null}
              <div className="grid gap-4">
                <label
                  htmlFor="memory-create-slug"
                  className="grid gap-2 text-xs text-muted-foreground"
                >
                  <span>{t("settings.memorySlugPlaceholder")}</span>{" "}
                  <Input
                    variant="plain"
                    id="memory-create-slug"
                    value={draft.slug}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        slug: event.target.value,
                      }))
                    }
                    placeholder={t("settings.memorySlugPlaceholder")}
                  />
                </label>
                <div className="space-y-2">
                  <div className="text-xs text-muted-foreground">{t("settings.memoryType")}</div>{" "}
                  <Select
                    value={draft.memoryType}
                    onValueChange={(value) =>
                      setDraft((prev) => ({
                        ...prev,
                        memoryType: value as MemoryType,
                      }))
                    }
                  >
                    <SelectTrigger variant="plain" aria-label={t("settings.memoryType")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="hub-scope">
                      {MEMORY_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {memoryTypeLabel(type, t)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <div className="text-xs text-muted-foreground">{t("settings.memoryScope")}</div>{" "}
                  <Select
                    value={draft.scope}
                    onValueChange={(value) =>
                      setDraft((prev) => ({
                        ...prev,
                        scope: value as "global" | "project",
                      }))
                    }
                  >
                    <SelectTrigger variant="plain" aria-label={t("settings.memoryScope")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="hub-scope">
                      <SelectItem value="global">{t("settings.memoryScopeGlobal")}</SelectItem>
                      <SelectItem value="project">{t("settings.memoryScopeProject")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <label
                  htmlFor="memory-create-description"
                  className="grid gap-2 text-xs text-muted-foreground"
                >
                  <span>{t("settings.memoryDescriptionPlaceholder")}</span>{" "}
                  <Input
                    variant="plain"
                    id="memory-create-description"
                    value={draft.description}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        description: event.target.value,
                      }))
                    }
                    placeholder={t("settings.memoryDescriptionPlaceholder")}
                  />
                </label>
              </div>
              <Textarea
                variant="plain"
                aria-label={t("settings.memoryBodyPlaceholder")}
                value={draft.body}
                onChange={(event) => setDraft((prev) => ({ ...prev, body: event.target.value }))}
                className="mt-3 min-h-28 resize-y"
                placeholder={t("settings.memoryBodyPlaceholder")}
              />
            </DialogBody>
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowCreate(false)}
                disabled={saving}
              >
                {t("settings.memoryCancel")}
              </Button>
              <Button
                size="sm"
                onClick={handleCreateEntry}
                disabled={saving || !draft.slug.trim() || !draft.body.trim()}
              >
                {t("settings.memorySave")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {settingsDrawerOpen ? (
        <MemorySettingsDrawer
          storagePath={pathsInfo?.root ?? "~/.ReinAgent/memory"}
          modelOptions={props.modelOptions}
          settings={props.settings}
          setSettings={props.setSettings}
          workdir={workdir}
          saving={saving}
          t={t}
          onClose={() => setSettingsDrawerOpen(false)}
          onRequestWipe={wipeAll}
          onMemoryChanged={() => {
            void reload();
          }}
        />
      ) : null}
    </>
  );
}
