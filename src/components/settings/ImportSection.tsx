/**
 * ImportSection —— 设置 ▸ 导入（移植自 PI-Desktop import-page.tsx）。
 *
 * 本机其他 AI 工具能交出的所有东西的一个工作台：会话 / 模型配置 / 技能 / MCP。
 * 每类一个 tab，切换不丢扫描结果；激活 tab 拥有自己的工具条（全选 + 双计数、
 * 专属选项、重扫、导入所选）和一个分组列表面板。
 *
 * 每类都保持显式扫描：切 tab 永不触发扫描。
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Download, Loader2 } from "lucide-react";
import { useTranslation } from "../../i18n";
import { toast } from "../lw/ui/toast";
import { Button } from "../lw/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../lw/ui/select";
import { groupImportCandidates, formatImportDate, DEFAULT_IMPORT_GROUP_BY, type ImportGroupBy } from "../../lib/import/importGroups";
import { scanAllSessions, CODEX_SCAN_MAX_FILES } from "../../lib/import/scan";
import { runSessionImport } from "../../lib/import/runSessions";
import { scanModelConfigs, importModelConfigs, type ModelConfigImportCandidate } from "../../lib/import/modelConfigs";
import { scanMcpCandidates, runMcpImport, scanSkillCandidates, runSkillImport, type McpImportCandidate, type SkillImportCandidate } from "../../lib/import/mcpSkills";
import type { ExternalSessionSummary, ExternalSource } from "../../lib/import/types";

type ImportKind = "sessions" | "models" | "skills" | "mcp";

const IMPORT_KINDS: readonly { id: ImportKind; labelKey: string }[] = [
  { id: "sessions", labelKey: "importKindSessions" },
  { id: "models", labelKey: "importKindModels" },
  { id: "skills", labelKey: "navSkills" },
  { id: "mcp", labelKey: "navMcp" },
];

export function ImportSection() {
  const { t } = useTranslation();
  // 动态 i18n 键（tab 标签查表）需要 string 签名
  const tf = t as unknown as (key: string) => string;
  const [kind, setKind] = useState<ImportKind>("sessions");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1 rounded-lg bg-settings-tile p-1" role="tablist">
        {IMPORT_KINDS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={kind === entry.id}
            data-active={kind === entry.id ? "" : undefined}
            onClick={() => setKind(entry.id)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              kind === entry.id
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tf(entry.labelKey)}
          </button>
        ))}
      </div>

      {IMPORT_KINDS.map((entry) => (
        <div
          key={entry.id}
          role="tabpanel"
          aria-label={tf(entry.labelKey)}
          hidden={kind !== entry.id}
        >
          <ImportKindPanel kind={entry.id} />
        </div>
      ))}
    </div>
  );
}

function ImportKindPanel({ kind }: { kind: ImportKind }) {
  if (kind === "sessions") return <SessionImportPanel />;
  if (kind === "models") return <ModelConfigImportPanel />;
  if (kind === "skills") return <SkillsScanImportPanel />;
  return <McpScanImportPanel />;
}

/* ---------------------------------------------------------------------------
 * 共享页面骨架
 * ------------------------------------------------------------------------- */

function ImportToolbar({
  found,
  selectedCount,
  allSelected,
  selectAllLabel,
  onToggleAll,
  scanning,
  importing,
  onScan,
  onImport,
  options,
  hint,
}: {
  found: string;
  selectedCount: number;
  allSelected: boolean;
  selectAllLabel: string;
  onToggleAll: (on: boolean) => void;
  scanning: boolean;
  importing: boolean;
  onScan: () => void;
  onImport: () => void;
  options?: ReactNode;
  hint?: string;
}) {
  const { t } = useTranslation();
  const selectAllRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const node = selectAllRef.current;
    if (node) node.indeterminate = selectedCount > 0 && !allSelected;
  }, [selectedCount, allSelected]);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-settings-tile px-4 py-3">
      <label className="flex min-w-0 items-center gap-2 text-xs text-[var(--text)]">
        <input
          ref={selectAllRef}
          type="checkbox"
          checked={allSelected}
          aria-label={selectAllLabel}
          className="size-3.5 accent-[var(--brand)]"
          onChange={(event) => onToggleAll(event.target.checked)}
        />
        <span className="truncate">
          <span>{found}</span>
          {selectedCount > 0 ? (
            <span className="ml-2 text-[var(--text-dim)]">
              {t("importSelectedCount").replace("{count}", String(selectedCount))}
            </span>
          ) : null}
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {options}
        {hint ? (
          <span className="max-w-64 truncate text-[11px] text-[var(--text-dim)]" title={hint}>
            {hint}
          </span>
        ) : null}
        <Button variant="outline" size="sm" disabled={scanning} onClick={onScan}>
          {scanning ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              {t("importScanning")}
            </>
          ) : (
            t("importScan")
          )}
        </Button>
        <Button size="sm" disabled={importing || selectedCount === 0} onClick={onImport}>
          {importing ? t("importing") : t("importSelected").replace("{count}", String(selectedCount))}
        </Button>
      </div>
    </div>
  );
}

function ImportOption({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  onChange: (id: string) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-dim)]">
      <span>{label}</span>
      <Select value={value} onValueChange={(v) => onChange(v)}>
        <SelectTrigger className="h-7 w-28 rounded-lg px-2 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.id} value={opt.id}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

function ImportGroup({
  bodyId,
  name,
  path,
  count,
  expanded,
  onToggle,
  selection,
  children,
}: {
  bodyId: string;
  name: string;
  path?: string | null;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  selection?: {
    checked: boolean;
    indeterminate: boolean;
    onChange: (on: boolean) => void;
  };
  children: ReactNode;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = selection?.indeterminate ?? false;
  }, [selection?.indeterminate]);
  return (
    <section className="overflow-hidden rounded-xl border border-[var(--border)]">
      <div className="flex items-center gap-2 bg-settings-tile px-3 py-2">
        {selection ? (
          <input
            ref={ref}
            type="checkbox"
            checked={selection.checked}
            aria-label={name}
            className="size-3.5 accent-[var(--brand)]"
            onChange={(event) => selection.onChange(event.target.checked)}
          />
        ) : null}
        <button
          type="button"
          aria-controls={bodyId}
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs font-medium text-[var(--text)]"
        >
          <span className={`text-[var(--text-dim)] transition-transform ${expanded ? "rotate-90" : ""}`}>▸</span>
          <span className="truncate">{name}</span>
          {path ? (
            <code className="truncate text-[10px] font-normal text-[var(--text-dim)]" title={path}>
              {path}
            </code>
          ) : null}
          <span className="ml-auto shrink-0 rounded-full bg-muted/70 px-1.5 text-[10px] tabular-nums text-[var(--text-dim)]">
            {count}
          </span>
        </button>
      </div>
      {expanded ? (
        <div id={bodyId} className="divide-y divide-[var(--border)]">
          {children}
        </div>
      ) : null}
    </section>
  );
}

function ImportRow({
  title,
  meta,
  checked,
  onChange,
  badge,
}: {
  title: string;
  meta: ReactNode;
  checked: boolean;
  onChange: (on: boolean) => void;
  badge?: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors hover:bg-settings-tile-hover">
      <input
        type="checkbox"
        checked={checked}
        className="size-3.5 shrink-0 accent-[var(--brand)]"
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-[var(--text)]">{title}</span>
        <span className="block truncate text-[11px] text-[var(--text-dim)]">{meta}</span>
      </span>
      {badge}
    </label>
  );
}

function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "success" | "warning" }) {
  const cls =
    tone === "success"
      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      : tone === "warning"
        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
        : "bg-muted text-muted-foreground";
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}>{children}</span>
  );
}

function ImportIdle({
  description,
  note,
  onScan,
  scanning,
}: {
  description?: string;
  note?: string;
  onScan: () => void;
  scanning: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl bg-settings-tile px-4 py-10">
      <div className="flex flex-col items-center gap-3">
        <Download className="size-5 text-[var(--text-dim)]" />
        {description || note ? (
          <p className="max-w-xl text-center text-[11px] leading-relaxed text-[var(--text-dim)]">
            {[description, note].filter(Boolean).join(" · ")}
          </p>
        ) : null}
        <Button variant="outline" size="sm" disabled={scanning} onClick={onScan}>
          {scanning ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              {t("importScanning")}
            </>
          ) : (
            t("importScan")
          )}
        </Button>
      </div>
    </div>
  );
}

function ImportResults({ message, children }: { message?: string; children?: ReactNode }) {
  if (message) {
    return (
      <div className="rounded-xl bg-settings-tile px-4 py-8 text-center text-xs text-[var(--text-dim)]">
        {message}
      </div>
    );
  }
  return <div className="flex flex-col gap-3">{children}</div>;
}

function toggleKey(previous: Set<string>, key: string, on: boolean): Set<string> {
  const next = new Set(previous);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}

function useGroupDisclosure() {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  return {
    isExpanded: (id: string) => !collapsed.has(id),
    toggle: (id: string) =>
      setCollapsed((previous) =>
        previous.has(id)
          ? new Set([...previous].filter((entry) => entry !== id))
          : new Set([...previous, id]),
      ),
    reset: () => setCollapsed(new Set()),
  };
}

function formatImportResult(
  tRaw: unknown,
  result: { imported: number; skipped: number; failed: number },
): string {
  const t = tRaw as unknown as (key: string) => string;
  return t("importResult")
    .replace("{imported}", String(result.imported))
    .replace("{skipped}", String(result.skipped))
    .replace("{failed}", String(result.failed));
}

/* ---------------------------------------------------------------------------
 * 会话
 * ------------------------------------------------------------------------- */

function SessionImportPanel() {
  const { t } = useTranslation();
  const [candidates, setCandidates] = useState<ExternalSessionSummary[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useState<ImportGroupBy>(DEFAULT_IMPORT_GROUP_BY);
  const disclosure = useGroupDisclosure();
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [codexCap, setCodexCap] = useState<number | null>(null);

  const keyOf = (candidate: ExternalSessionSummary) => `${candidate.source}:${candidate.externalId}`;

  const scan = async () => {
    setScanning(true);
    try {
      const res = await scanAllSessions();
      setCandidates(res.sessions);
      setCodexCap(typeof res.truncated?.codex === "number" ? res.truncated.codex : null);
      setSelected(new Set());
      disclosure.reset();
    } catch (e) {
      toast.error(String(e instanceof Error ? e.message : e).slice(0, 200));
    } finally {
      setScanning(false);
    }
  };

  const runImport = async () => {
    if (!candidates) return;
    const items = candidates.filter((candidate) => selected.has(keyOf(candidate)));
    if (items.length === 0) return;
    setImporting(true);
    try {
      const res = await runSessionImport(items);
      const text = formatImportResult(t, res); if (res.failed > 0) toast.error(text); else toast.success(text);
    } catch (e) {
      toast.error(String(e instanceof Error ? e.message : e).slice(0, 200));
    } finally {
      setImporting(false);
    }
  };

  const sourceLabels: Record<ExternalSource, string> = {
    "claude-code": t("importSourceClaudeCode"),
    opencode: t("importSourceOpenCode"),
    codex: t("importSourceCodex"),
    pi: t("importSourcePi"),
    omp: t("importSourceOmp"),
    kiro: t("importSourceKiro"),
    qoder: t("importSourceQoder"),
    kimi: t("importSourceKimi"),
    codebuddy: t("importSourceCodebuddy"),
    workbuddy: t("importSourceWorkbuddy"),
    gemini: t("importSourceGemini"),
    grok: t("importSourceGrok"),
    craft: t("importSourceCraft"),
    dsh: t("importSourceDsh"),
    zcode: t("importSourceZcode"),
    cursor: t("importSourceCursor"),
    copilot: t("importSourceCopilot"),
    hermes: t("importSourceHermes"),
    openclaw: t("importSourceOpenclaw"),
    devin: t("importSourceDevin"),
  };

  const groups = useMemo(
    () =>
      groupImportCandidates(candidates ?? [], groupBy, {
        noProject: t("importNoProject"),
        sources: sourceLabels,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [candidates, groupBy, t],
  );

  const allKeys = useMemo(() => (candidates ?? []).map(keyOf), [candidates]);
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));

  const toggleKeys = (keys: string[], on: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {candidates === null ? (
        <ImportIdle
          note={[sourceLabels["claude-code"], sourceLabels.opencode, sourceLabels.codex, sourceLabels.pi].join(" · ")}
          onScan={() => void scan()}
          scanning={scanning}
        />
      ) : (
        <>
          <ImportToolbar
            found={t("importFound").replace("{count}", String(candidates.length))}
            selectedCount={selected.size}
            allSelected={allSelected}
            selectAllLabel={t("importSelectAll")}
            onToggleAll={(on) => toggleKeys(allKeys, on)}
            scanning={scanning}
            importing={importing}
            onScan={() => void scan()}
            onImport={() => void runImport()}
            hint={codexCap != null ? t("importCodexCapped").replace("{limit}", String(CODEX_SCAN_MAX_FILES)) : undefined}
            options={
              <ImportOption
                label={t("importGroupBy")}
                value={groupBy}
                onChange={(id) => {
                  setGroupBy(id as ImportGroupBy);
                  disclosure.reset();
                }}
                options={[
                  { id: "source", label: t("importGroupBySource") },
                  { id: "path", label: t("importGroupByPath") },
                ]}
              />
            }
          />
          <ImportResults message={candidates.length === 0 ? t("importNone") : undefined}>
            <div className="flex flex-col gap-2">
              {groups.map((group, groupIndex) => {
                const groupKeys = group.items.map(keyOf);
                const groupSelected = groupKeys.filter((k) => selected.has(k)).length;
                const bodyId = `import-session-group-${groupIndex}`;
                return (
                  <ImportGroup
                    key={group.id}
                    bodyId={bodyId}
                    name={group.name}
                    path={group.projectPath}
                    count={group.items.length}
                    expanded={disclosure.isExpanded(group.id)}
                    onToggle={() => disclosure.toggle(group.id)}
                    selection={{
                      checked: groupSelected === groupKeys.length,
                      indeterminate: groupSelected > 0 && groupSelected < groupKeys.length,
                      onChange: (on) => toggleKeys(groupKeys, on),
                    }}
                  >
                    {group.items.map((candidate) => {
                      const key = keyOf(candidate);
                      return (
                        <ImportRow
                          key={key}
                          title={candidate.title}
                          meta={`${
                            candidate.messageCount === null
                              ? t("importMessagesUnknown")
                              : t("importMessages").replace("{count}", String(candidate.messageCount))
                          } · ${formatImportDate(candidate.updatedAt)}`}
                          checked={selected.has(key)}
                          onChange={(on) => setSelected((previous) => toggleKey(previous, key, on))}
                          badge={<Badge>{sourceLabels[candidate.source]}</Badge>}
                        />
                      );
                    })}
                  </ImportGroup>
                );
              })}
            </div>
          </ImportResults>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * 模型 / Provider 配置
 * ------------------------------------------------------------------------- */

function hostOf(baseUrl: string | null): string {
  if (!baseUrl) return "";
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl.replace(/^https?:\/\//, "").split("/")[0] || baseUrl;
  }
}

function ModelConfigImportPanel() {
  const { t } = useTranslation();
  const [candidates, setCandidates] = useState<ModelConfigImportCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const disclosure = useGroupDisclosure();
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);

  const keyOf = (candidate: ModelConfigImportCandidate) => `${candidate.source}:${candidate.externalId}`;

  const scan = async () => {
    setScanning(true);
    try {
      const res = await scanModelConfigs();
      setCandidates(res);
      setSelected(new Set());
      disclosure.reset();
    } catch (e) {
      toast.error(String(e instanceof Error ? e.message : e).slice(0, 200));
    } finally {
      setScanning(false);
    }
  };

  const runImport = async () => {
    if (!candidates) return;
    const items = candidates.filter((candidate) => selected.has(keyOf(candidate)));
    if (items.length === 0) return;
    setImporting(true);
    try {
      const res = await importModelConfigs(items);
      const text = formatImportResult(t, res); if (res.failed > 0) toast.error(text); else toast.success(text);
    } catch (e) {
      toast.error(String(e instanceof Error ? e.message : e).slice(0, 200));
    } finally {
      setImporting(false);
    }
  };

  const sourceLabels: Record<string, string> = {
    "claude-code": t("importSourceClaudeCode"),
    opencode: t("importSourceOpenCode"),
    codex: t("importSourceCodex"),
    pi: t("importSourcePi"),
    "cc-switch": t("importSourceCcSwitch"),
  };

  const groups = useMemo(() => {
    if (!candidates) return [];
    const grouped = new Map<string, ModelConfigImportCandidate[]>();
    for (const candidate of candidates) {
      const items = grouped.get(candidate.source) ?? [];
      items.push(candidate);
      grouped.set(candidate.source, items);
    }
    return [...grouped.entries()].map(([source, items]) => ({
      id: source,
      name: sourceLabels[source] ?? source,
      items,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates, t]);

  const allKeys = useMemo(() => (candidates ?? []).map(keyOf), [candidates]);
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));

  const toggleKeys = (keys: string[], on: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {candidates === null ? (
        <ImportIdle description={t("importModelsScanDesc")} onScan={() => void scan()} scanning={scanning} />
      ) : (
        <>
          <ImportToolbar
            found={t("importModelsFound").replace("{count}", String(candidates.length))}
            selectedCount={selected.size}
            allSelected={allSelected}
            selectAllLabel={t("importSelectAll")}
            onToggleAll={(on) => toggleKeys(allKeys, on)}
            scanning={scanning}
            importing={importing}
            onScan={() => void scan()}
            onImport={() => void runImport()}
          />
          <ImportResults message={candidates.length === 0 ? t("importModelsNone") : undefined}>
            <div className="flex flex-col gap-2">
              {groups.map((group, groupIndex) => {
                const groupKeys = group.items.map(keyOf);
                const groupSelected = groupKeys.filter((k) => selected.has(k)).length;
                const bodyId = `import-model-group-${groupIndex}`;
                return (
                  <ImportGroup
                    key={group.id}
                    bodyId={bodyId}
                    name={group.name}
                    count={group.items.length}
                    expanded={disclosure.isExpanded(group.id)}
                    onToggle={() => disclosure.toggle(group.id)}
                    selection={{
                      checked: groupSelected === groupKeys.length,
                      indeterminate: groupSelected > 0 && groupSelected < groupKeys.length,
                      onChange: (on) => toggleKeys(groupKeys, on),
                    }}
                  >
                    {group.items.map((candidate) => {
                      const key = keyOf(candidate);
                      const host = hostOf(candidate.baseUrl);
                      return (
                        <ImportRow
                          key={key}
                          title={candidate.name}
                          meta={`${t("importModelsCount").replace("{count}", String(candidate.modelIds.length))}${host ? ` · ${host}` : ""}`}
                          checked={selected.has(key)}
                          onChange={(on) => setSelected((previous) => toggleKey(previous, key, on))}
                          badge={
                            <Badge tone={candidate.hasSecret ? "success" : "warning"}>
                              {candidate.hasSecret ? t("importModelsHasKey") : t("importModelsNoKey")}
                            </Badge>
                          }
                        />
                      );
                    })}
                  </ImportGroup>
                );
              })}
            </div>
          </ImportResults>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * 技能与 MCP（复用本方既有扫描/写入通道）
 * ------------------------------------------------------------------------- */

function groupBySource<C extends { source: string }>(candidates: C[]): Array<{ id: string; items: C[] }> {
  const map = new Map<string, C[]>();
  for (const candidate of candidates) {
    const bucket = map.get(candidate.source);
    if (bucket) bucket.push(candidate);
    else map.set(candidate.source, [candidate]);
  }
  return Array.from(map.entries()).map(([id, items]) => ({ id, items }));
}

function SkillsScanImportPanel() {
  const { t } = useTranslation();
  const [candidates, setCandidates] = useState<SkillImportCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const disclosure = useGroupDisclosure();
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);

  const keyOf = (candidate: SkillImportCandidate) => `${candidate.tool}:${candidate.entry.baseDir}`;

  const scan = async () => {
    setScanning(true);
    try {
      setCandidates(await scanSkillCandidates());
      setSelected(new Set());
      disclosure.reset();
    } catch (e) {
      toast.error(String(e instanceof Error ? e.message : e).slice(0, 200));
    } finally {
      setScanning(false);
    }
  };

  const runImport = async () => {
    if (!candidates) return;
    const items = candidates.filter((candidate) => selected.has(keyOf(candidate)));
    if (items.length === 0) return;
    setImporting(true);
    try {
      const result = await runSkillImport(items);
      const text = formatImportResult(t, {
        imported: result.imported.length,
        skipped: result.skipped.length,
        failed: result.failed.length,
      });
      if (result.failed.length > 0) toast.error(text);
      else toast.success(text);
      await scan();
    } catch (e) {
      toast.error(String(e instanceof Error ? e.message : e).slice(0, 200));
    } finally {
      setImporting(false);
    }
  };

  const toggleKeys = (keys: string[], on: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };
  const groups = useMemo(() => groupBySource((candidates ?? []).map((c) => ({ ...c, source: c.tool }))), [candidates]);
  const allKeys = useMemo(() => (candidates ?? []).map(keyOf), [candidates]);
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));

  return (
    <div className="flex flex-col gap-3">
      {candidates === null ? (
        <ImportIdle description={t("importSkillsDesc")} onScan={() => void scan()} scanning={scanning} />
      ) : (
        <>
          <ImportToolbar
            found={t("importSkillsFound").replace("{count}", String(candidates.length))}
            selectedCount={selected.size}
            allSelected={allSelected}
            selectAllLabel={t("importSelectAll")}
            onToggleAll={(on) => setSelected(on ? new Set(allKeys) : new Set())}
            scanning={scanning}
            importing={importing}
            onScan={() => void scan()}
            onImport={() => void runImport()}
          />
          <ImportResults message={candidates.length === 0 ? t("importAgentScanNone") : undefined}>
            <div className="flex flex-col gap-2">
              {groups.map((group, groupIndex) => {
                const groupKeys = group.items.map(keyOf);
                const groupSelected = groupKeys.filter((k) => selected.has(k)).length;
                const bodyId = `import-skill-group-${groupIndex}`;
                return (
                  <ImportGroup
                    key={group.id}
                    bodyId={bodyId}
                    name={group.items[0]?.tool ?? group.id}
                    count={group.items.length}
                    expanded={disclosure.isExpanded(group.id)}
                    onToggle={() => disclosure.toggle(group.id)}
                    selection={{
                      checked: groupSelected === groupKeys.length,
                      indeterminate: groupSelected > 0 && groupSelected < groupKeys.length,
                      onChange: (on) => toggleKeys(groupKeys, on),
                    }}
                  >
                    {group.items.map((candidate) => {
                      const key = keyOf(candidate);
                      return (
                        <ImportRow
                          key={key}
                          title={candidate.entry.name}
                          meta={candidate.entry.description || candidate.entry.baseDir}
                          checked={selected.has(key)}
                          onChange={(on) => setSelected((previous) => toggleKey(previous, key, on))}
                        />
                      );
                    })}
                  </ImportGroup>
                );
              })}
            </div>
          </ImportResults>
        </>
      )}
    </div>
  );
}

function McpScanImportPanel() {
  const { t } = useTranslation();
  const [candidates, setCandidates] = useState<McpImportCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const disclosure = useGroupDisclosure();
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);

  const keyOf = (candidate: McpImportCandidate) => `${candidate.tool}:${candidate.entry.id}:${candidate.origin}`;

  const scan = async () => {
    setScanning(true);
    try {
      setCandidates(await scanMcpCandidates());
      setSelected(new Set());
      disclosure.reset();
    } catch (e) {
      toast.error(String(e instanceof Error ? e.message : e).slice(0, 200));
    } finally {
      setScanning(false);
    }
  };

  const runImport = async () => {
    if (!candidates) return;
    const items = candidates.filter((candidate) => selected.has(keyOf(candidate)));
    if (items.length === 0) return;
    setImporting(true);
    try {
      const res = await runMcpImport(items);
      const text = formatImportResult(t, {
        imported: res.imported.length,
        skipped: res.skipped.length,
        failed: res.failed.length,
      });
      if (res.failed.length > 0) toast.error(text);
      else toast.success(text);
      await scan();
    } catch (e) {
      toast.error(String(e instanceof Error ? e.message : e).slice(0, 200));
    } finally {
      setImporting(false);
    }
  };

  const toggleKeys = (keys: string[], on: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };
  const groups = useMemo(() => groupBySource((candidates ?? []).map((c) => ({ ...c, source: c.tool }))), [candidates]);
  const allKeys = useMemo(() => (candidates ?? []).map(keyOf), [candidates]);
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));

  return (
    <div className="flex flex-col gap-3">
      {candidates === null ? (
        <ImportIdle description={t("importMcpDesc")} onScan={() => void scan()} scanning={scanning} />
      ) : (
        <>
          <ImportToolbar
            found={t("importMcpFound").replace("{count}", String(candidates.length))}
            selectedCount={selected.size}
            allSelected={allSelected}
            selectAllLabel={t("importSelectAll")}
            onToggleAll={(on) => setSelected(on ? new Set(allKeys) : new Set())}
            scanning={scanning}
            importing={importing}
            onScan={() => void scan()}
            onImport={() => void runImport()}
          />
          <ImportResults message={candidates.length === 0 ? t("importAgentScanNone") : undefined}>
            <div className="flex flex-col gap-2">
              {groups.map((group, groupIndex) => {
                const groupKeys = group.items.map(keyOf);
                const groupSelected = groupKeys.filter((k) => selected.has(k)).length;
                const bodyId = `import-mcp-group-${groupIndex}`;
                return (
                  <ImportGroup
                    key={group.id}
                    bodyId={bodyId}
                    name={group.items[0]?.tool ?? group.id}
                    count={group.items.length}
                    expanded={disclosure.isExpanded(group.id)}
                    onToggle={() => disclosure.toggle(group.id)}
                    selection={{
                      checked: groupSelected === groupKeys.length,
                      indeterminate: groupSelected > 0 && groupSelected < groupKeys.length,
                      onChange: (on) => toggleKeys(groupKeys, on),
                    }}
                  >
                    {group.items.map((candidate) => {
                      const key = keyOf(candidate);
                      return (
                        <ImportRow
                          key={key}
                          title={candidate.entry.id}
                          meta={candidate.entry.command || candidate.entry.url || candidate.origin}
                          checked={selected.has(key)}
                          onChange={(on) => setSelected((previous) => toggleKey(previous, key, on))}
                          badge={
                            <Badge>
                              {candidate.entry.transport === "http" || candidate.entry.transport === "sse"
                                ? t("importTransportHttp")
                                : t("importTransportStdio")}
                            </Badge>
                          }
                        />
                      );
                    })}
                  </ImportGroup>
                );
              })}
            </div>
          </ImportResults>
        </>
      )}
    </div>
  );
}

