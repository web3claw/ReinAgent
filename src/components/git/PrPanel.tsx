/**
 * PrPanel —— PR / MR 面板（ROADMAP ⑦，Hetu WorkPrPanel 移植）：
 * 当前分支 PR 详情（状态/变更量/门禁/审查/CI checks）+ 动作（ready/draft/
 * merge(方式+删分支)/close/reopen）+ 创建表单 +「交给 Agent 修」（反馈聚合
 * 预填输入框不发送，经 window 事件 reinagent-prefill-prompt 由 App 接管）。
 * gh（GitHub）/ glab（GitLab）由 Rust 按 remote URL 自动选择；CLI 未安装/
 * 无 remote/非支持平台如实展示引导（no-fallback）。
 * 轮询：checks pending 或 mergeable UNKNOWN 时 5s 收敛轮询，否则 10s。
 */

import { GitPullRequest, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../../i18n";
import {
  buildPrHandoffPrompt,
  gitPrAction,
  gitPrCreate,
  gitPrFeedback,
  gitPrStatus,
  mergeBlocked,
  mergeStateKey,
  reviewKey,
  type GitPrStatus,
} from "../../lib/git/prApi";
import { toast } from "../lw/ui/toast";
import type { TranslationKey } from "../../i18n";

/** i18n 值插值（对齐 BranchSwitcher 的 fmt 惯例） */
const fmt = (template: string, params: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? ""));

const PR_FAST_REFRESH_MS = 5_000;
const PR_SLOW_REFRESH_MS = 10_000;

type CreateForm = { title: string; body: string; base: string; draft: boolean };

export function PrPanel({ cwd }: { cwd: string }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<GitPrStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<CreateForm | null>(null);
  const [mergeMethod, setMergeMethod] = useState<"merge" | "squash" | "rebase">("squash");
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const refreshingRef = useRef(false);
  const statusRef = useRef<GitPrStatus | null>(null);
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  const refresh = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!cwd || refreshingRef.current) return;
      refreshingRef.current = true;
      if (!opts?.silent) setLoading(true);
      try {
        const next = await gitPrStatus(cwd);
        statusRef.current = next;
        setStatus(next);
        setError(null);
      } catch (err) {
        // 自动刷新失败静默（保留上次好数据），手动链路失败大字报错——对齐 GitPanel
        if (!opts?.silent) setError(String(err));
      } finally {
        setLoading(false);
        refreshingRef.current = false;
      }
    },
    [cwd],
  );

  useEffect(() => {
    if (!cwd || !isTauri) return;
    void refresh();
  }, [cwd, isTauri, refresh]);

  // 轮询：有进行中检查或门禁未知时 5s，否则 10s；页面不可见暂停
  useEffect(() => {
    if (!cwd || !isTauri) return;
    const interval = window.setInterval(
      () => {
        if (document.visibilityState !== "visible" || busy) return;
        void refresh({ silent: true });
      },
      needsFastPoll(status) ? PR_FAST_REFRESH_MS : PR_SLOW_REFRESH_MS,
    );
    return () => window.clearInterval(interval);
  }, [cwd, isTauri, status, busy, refresh]);

  const runCommand = async (
    key: string,
    run: () => Promise<{ success: boolean; output: string; status: GitPrStatus }>,
    successToast?: string,
  ) => {
    if (busy) return;
    setBusy(key);
    setActionError(null);
    try {
      const res = await run();
      statusRef.current = res.status;
      setStatus(res.status);
      if (res.success) {
        if (successToast) toast.success(successToast);
      } else {
        setActionError(res.output || t("pr.actionFailed"));
      }
    } catch (err) {
      setActionError(String(err));
    } finally {
      setBusy(null);
    }
  };

  const openCreateForm = () => {
    setActionError(null);
    setForm({ title: "", body: "", base: status?.baseBranch ?? "", draft: false });
  };

  const submitCreate = () => {
    if (!form || !form.title.trim()) return;
    void runCommand(
      "create",
      () => gitPrCreate({ cwd, title: form.title.trim(), body: form.body, baseBranch: form.base.trim() || null, draft: form.draft }),
      t("pr.createSuccess"),
    ).then(() => setForm(null));
  };

  const handoffToAgent = async () => {
    if (busy) return;
    setBusy("handoff");
    setActionError(null);
    try {
      const fb = await gitPrFeedback(cwd);
      if (!fb.hasPr) {
        setActionError(t("pr.noPr"));
        return;
      }
      const prompt = buildPrHandoffPrompt(fb);
      // 预填输入框不自动发送（对齐 EmptyState 快捷动作语义）；App 监听该事件写入 composerPrefill
      window.dispatchEvent(new CustomEvent("reinagent-prefill-prompt", { detail: prompt }));
      toast.success(t("pr.handoffFilled"));
    } catch (err) {
      setActionError(String(err));
    } finally {
      setBusy(null);
    }
  };

  // ===== 渲染 =====

  if (!isTauri) {
    return (
      <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] p-3">
        <p className="text-xs text-[var(--text-dim)]">{t("pr.desktopOnly")}</p>
      </section>
    );
  }

  const header = (
    <div className="mb-1.5 flex items-center justify-between gap-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-dim)]">
        <GitPullRequest className="h-3.5 w-3.5" />
        <span>{t("pr.title")}</span>
      </div>
      <button
        type="button"
        onClick={() => void refresh()}
        aria-label={t("gitRefresh")}
        className="rounded p-1 text-[var(--text-dim)] hover:text-[var(--text)]"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
      </button>
    </div>
  );

  if (error) {
    return (
      <section>
        {header}
        <p className="rounded-lg border border-[var(--danger)] bg-[var(--bg-elev)] p-2.5 text-xs text-[var(--danger)]">{error}</p>
      </section>
    );
  }

  if (!status) {
    return (
      <section>
        {header}
        <p className="text-xs text-[var(--text-dim)]">{t("pr.loading")}</p>
      </section>
    );
  }

  if (!status.isRepo) return null; // 外层 GitPanel 已显示非仓库空态

  if (status.message === "no-remote") {
    return (
      <section>
        {header}
        <p className="text-xs text-[var(--text-dim)]">{t("pr.noRemote")}</p>
      </section>
    );
  }

  if (status.message === "unsupported-host") {
    return (
      <section>
        {header}
        <p className="text-xs text-[var(--text-dim)]">{t("pr.unsupportedHost")}</p>
      </section>
    );
  }

  if (!status.toolInstalled) {
    return (
      <section>
        {header}
        <p className="mb-1.5 text-xs text-[var(--text-dim)]">{fmt(t("pr.toolMissing"), { tool: status.tool })}</p>
        <code className="block overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-2.5 py-1.5 text-xs text-[var(--text)]">
          {status.installHint}
        </code>
      </section>
    );
  }

  // CLI 已装但查询报错（未登录等）——如实展示 CLI 原文
  if (status.message && !status.pr) {
    return (
      <section>
        {header}
        <p className="text-xs text-[var(--text-dim)]">{status.message}</p>
      </section>
    );
  }

  const pr = status.pr;
  const gateKey = mergeStateKey(pr?.mergeStateStatus, pr?.mergeable);
  const blocked = pr ? mergeBlocked(pr.mergeStateStatus, pr.mergeable, pr.reviewDecision) : false;

  return (
    <section>
      {header}
      {actionError ? (
        <p className="mb-2 whitespace-pre-wrap rounded-lg border border-[var(--danger)] bg-[var(--bg-elev)] p-2.5 text-xs text-[var(--danger)]">
          {actionError}
        </p>
      ) : null}

      {pr ? (
        <div className="space-y-2">
          {/* 标题行：#n + 标题 + 状态/草稿徽标 */}
          <div className="flex items-start justify-between gap-2">
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 flex-1 truncate text-sm text-[var(--text)] hover:underline"
              title={pr.title}
            >
              <span className="text-[var(--text-dim)]">#{pr.number}</span> {pr.title}
            </a>
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${prStateClass(pr.state, pr.isDraft)}`}>
              {pr.isDraft ? t("pr.draft") : pr.state.toUpperCase()}
            </span>
          </div>

          {/* 分支 + 变更量 */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-dim)]">
            <span>
              {pr.headBranch} → {pr.baseBranch}
            </span>
            <span className="text-[var(--diff-added)]">+{pr.additions}</span>
            <span className="text-[var(--diff-removed)]">−{pr.deletions}</span>
            <span>
              {fmt(t("pr.changedFiles"), { n: pr.changedFiles })}
            </span>
          </div>

          {/* 门禁 + 审查徽标 */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${gateClass(gateKey)}`}>
              {t(`pr.mergeState.${gateKey}` as TranslationKey)}
            </span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${reviewClass(pr.reviewDecision)}`}>
              {t(`pr.review.${reviewKey(pr.reviewDecision)}` as TranslationKey)}
            </span>
          </div>

          {/* CI checks */}
          {pr.checks.length > 0 ? (
            <ul className="space-y-0.5">
              {pr.checks.slice(0, 12).map((c) => (
                <li key={`${c.name}-${c.link ?? ""}`} className="flex items-center gap-1.5 text-xs">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${checkDotClass(c.bucket)}`} />
                  <span className="truncate text-[var(--text)]" title={c.name}>
                    {c.name}
                  </span>
                  {c.link ? (
                    <a href={c.link} target="_blank" rel="noreferrer" className="shrink-0 text-[10px] text-[var(--text-dim)] hover:underline">
                      {c.state || c.bucket}
                    </a>
                  ) : (
                    <span className="shrink-0 text-[10px] text-[var(--text-dim)]">{c.state || c.bucket}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}

          {/* 动作区 */}
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {pr.isDraft ? (
              <button type="button" disabled={!!busy} onClick={() => void runCommand("ready", () => gitPrAction({ cwd, action: "ready" }), t("pr.readySuccess"))} className={actionBtnClass}>
                {busy === "ready" ? "…" : t("pr.markReady")}
              </button>
            ) : (
              <button type="button" disabled={!!busy} onClick={() => void runCommand("draft", () => gitPrAction({ cwd, action: "draft" }), t("pr.draftSuccess"))} className={actionBtnClass}>
                {busy === "draft" ? "…" : t("pr.markDraft")}
              </button>
            )}
            <select
              value={mergeMethod}
              disabled={!!busy}
              onChange={(e) => setMergeMethod(e.target.value as typeof mergeMethod)}
              className="rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-1.5 py-1 text-xs text-[var(--text)] focus:outline-none"
              aria-label={t("pr.mergeMethod")}
            >
              <option value="merge">{t("pr.mergeMerge")}</option>
              <option value="squash">{t("pr.mergeSquash")}</option>
              <option value="rebase">{t("pr.mergeRebase")}</option>
            </select>
            <label className="flex items-center gap-1 text-xs text-[var(--text-dim)]">
              <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} className="accent-[var(--brand)]" />
              {t("pr.deleteBranch")}
            </label>
            <button
              type="button"
              disabled={!!busy || blocked || pr.state.toUpperCase() !== "OPEN"}
              onClick={() => void runCommand("merge", () => gitPrAction({ cwd, action: "merge", mergeMethod, deleteBranch }), t("pr.mergeSuccess"))}
              title={blocked ? t("pr.mergeBlockedHint") : undefined}
              className={`${actionBtnClass} ${!blocked && pr.state.toUpperCase() === "OPEN" ? "font-medium text-[var(--brand)]" : ""}`}
            >
              {busy === "merge" ? "…" : t("pr.merge")}
            </button>
            {pr.state.toUpperCase() === "OPEN" ? (
              <button type="button" disabled={!!busy} onClick={() => void runCommand("close", () => gitPrAction({ cwd, action: "close" }), t("pr.closeSuccess"))} className={actionBtnClass}>
                {busy === "close" ? "…" : t("pr.close")}
              </button>
            ) : (
              <button type="button" disabled={!!busy} onClick={() => void runCommand("reopen", () => gitPrAction({ cwd, action: "reopen" }), t("pr.reopenSuccess"))} className={actionBtnClass}>
                {busy === "reopen" ? "…" : t("pr.reopen")}
              </button>
            )}
          </div>

          {/* 交给 Agent 修 */}
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void handoffToAgent()}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-2.5 py-1.5 text-xs text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50"
          >
            {busy === "handoff" ? t("pr.handoffLoading") : t("pr.handoffToAgent")}
          </button>

          {/* 其他开放 PR（只读对照） */}
          {status.openPrs.filter((p) => p.number !== pr.number).length > 0 ? (
            <details className="text-xs text-[var(--text-dim)]">
              <summary className="cursor-pointer select-none">{fmt(t("pr.openPrs"), { n: status.openPrs.length })}</summary>
              <ul className="mt-1 space-y-0.5">
                {status.openPrs
                  .filter((p) => p.number !== pr.number)
                  .map((p) => (
                    <li key={p.number} className="flex items-center gap-1.5">
                      <span className="text-[var(--text-dim)]">#{p.number}</span>
                      <a href={p.url} target="_blank" rel="noreferrer" className="truncate hover:underline" title={p.title}>
                        {p.title}
                      </a>
                      <span className="shrink-0 text-[10px]">{p.headBranch}</span>
                    </li>
                  ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : form ? (
        /* 创建表单 */
        <div className="space-y-2">
          <input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder={t("pr.formTitle")}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-2.5 py-1.5 text-sm text-[var(--text)] focus:outline-none"
          />
          <textarea
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
            placeholder={t("pr.formBody")}
            rows={4}
            className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-2.5 py-1.5 text-xs text-[var(--text)] focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <input
              value={form.base}
              onChange={(e) => setForm({ ...form, base: e.target.value })}
              placeholder={t("pr.formBase")}
              className="w-32 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-2 py-1 text-xs text-[var(--text)] focus:outline-none"
            />
            <label className="flex items-center gap-1 text-xs text-[var(--text-dim)]">
              <input type="checkbox" checked={form.draft} onChange={(e) => setForm({ ...form, draft: e.target.checked })} className="accent-[var(--brand)]" />
              {t("pr.draft")}
            </label>
            <span className="flex-1" />
            <button type="button" onClick={() => setForm(null)} className={actionBtnClass}>
              {t("pr.cancel")}
            </button>
            <button
              type="button"
              disabled={!!busy || !form.title.trim()}
              onClick={() => submitCreate()}
              className="rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-2.5 py-1 text-xs font-medium text-[var(--brand)] transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50"
            >
              {busy === "create" ? "…" : t("pr.create")}
            </button>
          </div>
        </div>
      ) : status.branchPushed ? (
        <button
          type="button"
          onClick={openCreateForm}
          disabled={!!busy}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-2.5 py-1.5 text-xs text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50"
        >
          <GitPullRequest className="h-3.5 w-3.5 text-[var(--text-dim)]" />
          {fmt(t("pr.createForBranch"), { branch: status.branch })}
        </button>
      ) : (
        <p className="text-xs text-[var(--text-dim)]">{fmt(t("pr.branchNotPushed"), { branch: status.branch })}</p>
      )}
    </section>
  );
}

const actionBtnClass =
  "rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-2.5 py-1 text-xs text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-50";

function needsFastPoll(status: GitPrStatus | null): boolean {
  const pr = status?.pr;
  if (!pr) return false;
  if (pr.mergeable.toUpperCase() === "UNKNOWN") return true;
  return pr.checks.some((c) => c.bucket === "pending");
}

function prStateClass(state: string, isDraft: boolean): string {
  if (isDraft) return "bg-[var(--surface-hover)] text-[var(--text-dim)]";
  switch (state.toUpperCase()) {
    case "OPEN": return "bg-[var(--diff-added-bg)] text-[var(--diff-added)]";
    case "MERGED": return "bg-[var(--surface-hover)] text-[var(--brand)]";
    case "CLOSED": return "bg-[var(--diff-removed-bg)] text-[var(--diff-removed)]";
    default: return "bg-[var(--surface-hover)] text-[var(--text-dim)]";
  }
}

function gateClass(key: string): string {
  switch (key) {
    case "clean": return "bg-[var(--diff-added-bg)] text-[var(--diff-added)]";
    case "conflicting": return "bg-[var(--diff-removed-bg)] text-[var(--diff-removed)]";
    case "unstable": return "bg-[var(--warn-bg)] text-[var(--warn-text)]";
    default: return "bg-[var(--surface-hover)] text-[var(--text-dim)]"; // blocked/behind/unknown
  }
}

function reviewClass(decision: string | null | undefined): string {
  switch ((decision ?? "").toUpperCase()) {
    case "APPROVED": return "bg-[var(--diff-added-bg)] text-[var(--diff-added)]";
    case "CHANGES_REQUESTED": return "bg-[var(--diff-removed-bg)] text-[var(--diff-removed)]";
    default: return "bg-[var(--surface-hover)] text-[var(--text-dim)]"; // pending / review_required
  }
}

function checkDotClass(bucket: string): string {
  switch (bucket) {
    case "pass": return "bg-[var(--diff-added)]";
    case "fail": return "bg-[var(--diff-removed)]";
    case "pending": return "bg-[var(--warn-text)]";
    default: return "bg-[var(--text-dim)]";
  }
}
