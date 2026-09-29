/**
 * HooksSection —— 工作区 Hooks 管理（P2-G2 尾巴）。
 *
 * 编辑的是活动工作区 `.ReinAgent/config.json` 的 hooks 数组（saveWorkspaceHooks
 * 保留其它顶层键）；支持增删改、启停、单条试运行（runSingleHookForTest，
 * 显式用户动作不看信任态）、信任状态展示与重新批准。
 * 保存后发现缓存自然过期（5s TTL），横幅/运行器读到新配置。
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useTranslation } from "../../i18n";
import {
  discoverWorkspaceHooks,
  runSingleHookForTest,
  saveWorkspaceHooks,
  trustWorkspaceHooks,
  untrustWorkspaceHooks,
  type HookConfigEntry,
} from "../../lib/hooks/hooksRuntime";

const EVENTS = ["PreToolUse", "UserPromptSubmit", "Stop"] as const;

interface DraftEntry {
  event: string;
  matcher: string;
  command: string;
  timeoutMs: string;
  enabled: boolean;
}

const toDraft = (e: HookConfigEntry): DraftEntry => ({
  event: e.event,
  matcher: e.matcher ?? "",
  command: e.command,
  timeoutMs: e.timeoutMs != null ? String(e.timeoutMs) : "",
  enabled: e.enabled !== false,
});

const toEntry = (d: DraftEntry): HookConfigEntry => ({
  event: d.event,
  ...(d.matcher.trim() ? { matcher: d.matcher.trim() } : {}),
  command: d.command.trim(),
  ...(d.timeoutMs.trim() ? { timeoutMs: Number(d.timeoutMs) } : {}),
  enabled: d.enabled,
});

interface TestResult {
  blocked: boolean;
  reason?: string;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
}

export function HooksSection({ workspaceRoot }: { workspaceRoot?: string }) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<DraftEntry[] | null>(null);
  const [trusted, setTrusted] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<number, TestResult | "running">>({});

  const discover = useCallback(async () => {
    if (!workspaceRoot) {
      setDrafts([]);
      setTrusted(null);
      return;
    }
    try {
      const discovered = await discoverWorkspaceHooks(workspaceRoot);
      setDrafts((discovered?.entries ?? []).map(toDraft));
      setTrusted(discovered ? discovered.trusted : null);
    } catch (err) {
      setDrafts([]);
      setFeedback(String(err).slice(0, 200));
    }
  }, [workspaceRoot]);

  useEffect(() => {
    setDrafts(null);
    void discover();
  }, [discover]);

  if (!workspaceRoot) {
    return <p className="text-xs text-[var(--text-dim)]">{t("hooksNoWorkspace")}</p>;
  }
  if (drafts === null) {
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--text-dim)]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("hooksLoading")}
      </div>
    );
  }

  const update = (index: number, patch: Partial<DraftEntry>) => {
    setDrafts((cur) => (cur ?? []).map((d, i) => (i === index ? { ...d, ...patch } : d)));
  };

  const save = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const entries = (drafts ?? []).map(toEntry).filter((e) => e.command);
      await saveWorkspaceHooks(workspaceRoot, entries);
      setFeedback(t("hooksSaved"));
      await discover();
    } catch (err) {
      setFeedback(String(err).slice(0, 220));
    } finally {
      setSaving(false);
    }
  };

  const test = async (index: number) => {
    const entry = toEntry((drafts ?? [])[index]);
    if (!entry.command) return;
    setTestResults((cur) => ({ ...cur, [index]: "running" }));
    try {
      const outcome = await runSingleHookForTest(entry, workspaceRoot);
      const run = outcome.runs[0];
      setTestResults((cur) => ({
        ...cur,
        [index]: {
          blocked: outcome.blocked,
          reason: outcome.reason,
          exitCode: run?.exitCode ?? null,
          timedOut: run?.timedOut ?? false,
          error: run?.error,
        },
      }));
    } catch (err) {
      setTestResults((cur) => ({ ...cur, [index]: { blocked: false, exitCode: null, timedOut: false, error: String(err) } }));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">{t("hooksTitle")}</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void discover()}
            aria-label={t("hooksReload")}
            className="rounded p-1.5 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setDrafts((cur) => [...(cur ?? []), { event: "PreToolUse", matcher: "", command: "", timeoutMs: "", enabled: true }])}
            className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text)] hover:border-[var(--brand)]"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("hooksAdd")}
          </button>
        </div>
      </div>
      <p className="text-xs text-[var(--text-dim)]">
        {t("hooksHint").replace("{path}", `${workspaceRoot}/.ReinAgent/config.json`)}
      </p>

      {trusted === false ? (
        <div className="flex items-center justify-between rounded-lg border border-[var(--warn-border)] bg-[var(--warn-bg)] px-3 py-2 text-xs text-[var(--warn-text)]">
          <span>{t("hooksUntrusted")}</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                void (async () => {
                  const d = await discoverWorkspaceHooks(workspaceRoot);
                  if (d) {
                    trustWorkspaceHooks(workspaceRoot, d.raw);
                    setTrusted(true);
                  }
                })();
              }}
              className="rounded border border-[var(--warn-border)] px-2 py-0.5 font-medium"
            >
              {t("hooksTrustNow")}
            </button>
            <button
              type="button"
              onClick={() => {
                untrustWorkspaceHooks(workspaceRoot);
                setTrusted(false);
              }}
              className="text-[var(--warn-text)]/70 hover:text-[var(--warn-text)]"
            >
              {t("hooksDismiss")}
            </button>
          </div>
        </div>
      ) : null}

      {feedback ? <p className="text-xs text-[var(--text-dim)]">{feedback}</p> : null}

      {drafts.length === 0 ? (
        <p className="text-xs text-[var(--text-dim)]">{t("hooksEmpty")}</p>
      ) : (
        <div className="space-y-3">
          {drafts.map((draft, index) => {
            const result = testResults[index];
            return (
              <div key={index} className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={draft.event}
                    onChange={(e) => update(index, { event: e.target.value })}
                    className="rounded-lg border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--text)] focus:outline-none"
                  >
                    {EVENTS.map((ev) => (
                      <option key={ev} value={ev}>
                        {ev}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={draft.matcher}
                    onChange={(e) => update(index, { matcher: e.target.value })}
                    placeholder={t("hooksMatcherPlaceholder")}
                    className="w-40 rounded-lg border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--text)] placeholder-[var(--text-dim)] focus:outline-none"
                  />
                  <input
                    type="text"
                    value={draft.timeoutMs}
                    onChange={(e) => update(index, { timeoutMs: e.target.value.replace(/\D/g, "") })}
                    placeholder="timeout ms"
                    className="w-24 rounded-lg border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--text)] placeholder-[var(--text-dim)] focus:outline-none"
                  />
                  <label className="flex items-center gap-1.5 text-xs text-[var(--text-dim)]">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(e) => update(index, { enabled: e.target.checked })}
                    />
                    {t("hooksEnabledLabel")}
                  </label>
                  <div className="ml-auto flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => void test(index)}
                      aria-label={t("hooksTest")}
                      className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                    >
                      <Play className="h-3 w-3" />
                      {t("hooksTest")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDrafts((cur) => (cur ?? []).filter((_, i) => i !== index))}
                      aria-label={t("hooksDelete")}
                      className="rounded p-1 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--danger)]"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <textarea
                  value={draft.command}
                  onChange={(e) => update(index, { command: e.target.value })}
                  rows={2}
                  placeholder={t("hooksCommandPlaceholder")}
                  className="mt-2 w-full resize-none rounded-lg border border-[var(--border)] bg-transparent px-2 py-1.5 font-mono text-xs text-[var(--text)] placeholder-[var(--text-dim)] focus:outline-none"
                />
                {result === "running" ? (
                  <p className="mt-1.5 flex items-center gap-1.5 text-xs text-[var(--text-dim)]">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t("hooksTestRunning")}
                  </p>
                ) : result ? (
                  <p
                    className={`mt-1.5 break-all text-xs ${
                      result.error ? "text-[var(--danger)]" : result.blocked ? "text-[var(--warn-text)]" : "text-[var(--text-dim)]"
                    }`}
                  >
                    {result.error
                      ? `${t("hooksTestError")}${result.error}`
                      : result.timedOut
                        ? t("hooksTestTimeout")
                        : result.blocked
                          ? `${t("hooksTestBlocked")}${result.reason ?? ""}`
                          : `${t("hooksTestPassed")} (exit ${result.exitCode ?? "?"})`}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <button
        type="button"
        onClick={() => void save()}
        disabled={saving || drafts.length === 0}
        className="rounded-lg bg-[var(--brand)] px-4 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        {saving ? t("hooksSaving") : t("hooksSave")}
      </button>
    </div>
  );
}
