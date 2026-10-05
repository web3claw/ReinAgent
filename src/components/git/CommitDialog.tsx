/**
 * CommitDialog —— Git 面板的提交对话框（ZCode GitCommitDialog 移植裁剪版）：
 * 提交信息输入 + ✨AI 生成（复用 promptEnhancement 的 one-shot 模型通道）+
 * 「包含未暂存更改」勾选 + 身份缺失警告 + 提交 / 提交并推送（无 upstream 自动
 * --set-upstream origin <branch>）。失败如实展示 git 原文（No-Fallback）。
 */
import { CircleAlert, GitBranch, Loader2, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "../../i18n";
import {
  gitCommit,
  gitDiffPatch,
  gitIdentity,
  gitNumstat,
  gitPush,
  gitStage,
  gitStatus,
  type GitIdentityResponse,
  type GitNumStatFile,
} from "../../lib/git/api";
import { generateCommitMessage } from "../../lib/git/commitMessage";
import type { ProviderConfig } from "../../lib/providers/modelFactory";
import { loadPromptEnhancementSettings } from "../../lib/promptEnhancement/settings";
import { loadProvidersConfigFromDisk, type ProviderItem } from "../settings/model-provider/types";
import { useSettings } from "../../lib/settings/useSettings";
import type { Settings } from "../../lib/settings/store";
import { useAppStore } from "../../store/useAppStore";
import { Button } from "../lw/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../lw/ui/dialog";
import { Textarea } from "../lw/ui/textarea";
import { toast } from "../lw/ui/toast";

const shortError = (err: unknown): string =>
  String(err instanceof Error ? err.message : err).slice(0, 300);

const fmt = (template: string, params: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? ""));

/**
 * ✨ 模型解析链（对齐 composer 的增强回退语义）：
 * 钉住的增强模型 → 活动任务模型 → 设置默认模型 → 首个已启用供应商。
 */
async function resolveGenerationConfig(settings: Settings): Promise<ProviderConfig | null> {
  const [peSettings, providers] = await Promise.all([
    loadPromptEnhancementSettings().catch(() => null),
    loadProvidersConfigFromDisk(settings).catch(() => [] as ProviderItem[]),
  ]);
  const build = (pid?: string | null, mid?: string | null): ProviderConfig | null => {
    if (!pid || !mid) return null;
    const item = providers.find((p) => p.id === pid);
    if (!item || !item.enabled) return null;
    const model = item.models.find((m) => m.id === mid);
    if (!model) return null;
    return {
      provider: item.id as ProviderConfig["provider"],
      apiKey: item.apiKey,
      modelId: mid,
      baseUrl: item.baseUrl,
      apiFormat: item.apiFormat,
      contextWindow: model.contextWindow ?? null,
      maxOutputTokens: model.maxOutputTokens ?? null,
      supportsImage: model.supportsImage ?? null,
    };
  };
  const store = useAppStore.getState();
  const activeTask = store.tasks.find((task) => task.id === store.activeTaskId);
  const firstEnabled = providers.find((p) => p.enabled && p.models.length > 0);
  return (
    build(peSettings?.providerId, peSettings?.modelId) ??
    build(activeTask?.providerId, activeTask?.modelId) ??
    build(settings.provider, settings.modelId) ??
    (firstEnabled
      ? build(firstEnabled.id, firstEnabled.defaultModelId || firstEnabled.models[0].id)
      : null)
  );
}

interface CommitDialogProps {
  open: boolean;
  workspacePath: string;
  branchName: string;
  onOpenChange: (open: boolean) => void;
  onCommitted: () => void;
}

export function CommitDialog({ open, workspacePath, branchName, onOpenChange, onCommitted }: CommitDialogProps) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const [loading, setLoading] = useState(false);
  const [staged, setStaged] = useState<GitNumStatFile[]>([]);
  const [unstaged, setUnstaged] = useState<GitNumStatFile[]>([]);
  const [identity, setIdentity] = useState<GitIdentityResponse | null>(null);
  const [includeUnstaged, setIncludeUnstaged] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [generating, setGenerating] = useState(false);

  // 打开时拉取：分组行数 + 身份 + diff 原文（✨ 用）
  useEffect(() => {
    if (!open || !workspacePath) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMessage("");
    void (async () => {
      try {
        // 路径清单以 git_status 为准（untracked 不进 numstat），行数从 numstat 合并（untracked 记 0/0）
        const [stats, status, ident] = await Promise.all([
          gitNumstat(workspacePath),
          gitStatus(workspacePath),
          gitIdentity(workspacePath).catch(() => null),
        ]);
        if (cancelled) return;
        const counts = new Map(
          [...stats.unstaged, ...stats.staged].map((f) => [f.path, f] as const),
        );
        const toFile = (path: string): GitNumStatFile => ({
          path,
          added: counts.get(path)?.added ?? 0,
          removed: counts.get(path)?.removed ?? 0,
        });
        const stagedList = status.entries
          .filter((e) => e.code !== "??" && e.indexCode !== " ")
          .map((e) => toFile(e.path));
        const unstagedList = status.entries
          .filter((e) => e.code === "??" || e.worktreeCode !== " ")
          .map((e) => toFile(e.path));
        setStaged(stagedList);
        setUnstaged(unstagedList);
        setIdentity(ident);
        // 默认勾选语义：无已暂存文件时勾上（避免空选死路），否则只提交已暂存
        setIncludeUnstaged(stagedList.length === 0 && unstagedList.length > 0);
      } catch (err) {
        if (!cancelled) setError(shortError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, workspacePath]);

  const hasIdentity = identity === null || (Boolean(identity.userName) && Boolean(identity.userEmail));
  const selected: GitNumStatFile[] = includeUnstaged ? [...unstaged, ...staged] : staged;
  const stagePaths = Array.from(new Set(selected.map((f) => f.path)));
  const totalAdded = selected.reduce((s, f) => s + f.added, 0);
  const totalRemoved = selected.reduce((s, f) => s + f.removed, 0);
  const hasChanges = stagePaths.length > 0;
  const canSubmit = !pending && !loading && hasChanges && message.trim().length > 0 && hasIdentity;

  const handleGenerate = useCallback(async () => {
    if (generating || pending || !hasChanges) return;
    setGenerating(true);
    setError(null);
    try {
      const config = await resolveGenerationConfig(settings);
      if (!config) {
        toast.error(t("gitCommitNoModel"));
        return;
      }
      const [unstagedPatch, stagedPatch] = await Promise.all([
        unstaged.length > 0 ? gitDiffPatch(workspacePath, false) : Promise.resolve(""),
        gitDiffPatch(workspacePath, true),
      ]);
      const diffText =
        (includeUnstaged ? `${unstagedPatch}\n${stagedPatch}` : stagedPatch || unstagedPatch).trim() ||
        `${unstagedPatch}\n${stagedPatch}`.trim();
      const msg = await generateCommitMessage({
        config,
        branchName: branchName || null,
        diffText,
      });
      setMessage(msg);
    } catch (err) {
      setError(shortError(err));
    } finally {
      setGenerating(false);
    }
  }, [branchName, generating, hasChanges, includeUnstaged, pending, settings, t, unstaged.length, workspacePath]);

  const runCommit = useCallback(
    async (push: boolean) => {
      if (!canSubmit) return;
      setPending(true);
      setError(null);
      try {
        if (includeUnstaged && unstaged.length > 0) {
          const stageRes = await gitStage(
            workspacePath,
            Array.from(new Set(unstaged.map((f) => f.path))),
          );
          if (stageRes.skipped.length > 0) {
            // 快照竞态：status 之后文件被其它工具删掉——如实告知，不阻塞提交
            toast.warning(
              `${fmt(t("gitCommitSkippedFiles"), { count: stageRes.skipped.length })} ${stageRes.skipped.slice(0, 3).join(", ")}${stageRes.skipped.length > 3 ? "…" : ""}`,
            );
          }
        }
        await gitCommit(workspacePath, message.trim());
        if (push) {
          const res = await gitPush(workspacePath);
          if (res.ok) {
            toast.success(t("gitCommitPushSuccess"));
          } else {
            // 提交已成功、推送失败：如实分开说（推送错误保留 git 原文）
            toast.warning(`${t("gitCommitPushFailed")}：${(res.detail ?? "").slice(0, 260)}`);
          }
        } else {
          toast.success(t("gitCommitSuccess"));
        }
        onOpenChange(false);
        onCommitted();
      } catch (err) {
        setError(shortError(err));
      } finally {
        setPending(false);
      }
    },
    [canSubmit, includeUnstaged, message, onCommitted, onOpenChange, t, unstaged, workspacePath],
  );

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("gitCommitTitle")}</DialogTitle>
          <DialogDescription>{t("gitCommitDesc")}</DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex h-40 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-[var(--text-dim)]" />
          </div>
        ) : (
          <form
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              void runCommit(false);
            }}
          >
            <DialogBody>
              {/* 分支 + 行数汇总（ZCode 对话框头部同款） */}
              <div className="flex items-center justify-between gap-2 rounded-lg bg-[var(--bg-elev-2)] px-3 py-2 text-xs">
                <span className="flex min-w-0 items-center gap-1.5 text-[var(--text)]">
                  <GitBranch className="h-3.5 w-3.5 shrink-0 text-[var(--text-dim)]" />
                  <span className="truncate">{branchName || t("gitBranchSwitcherLabel")}</span>
                </span>
                <span className="flex shrink-0 gap-1.5 font-mono">
                  <span className="text-emerald-500">+{totalAdded}</span>
                  <span className="text-red-500">-{totalRemoved}</span>
                </span>
              </div>

              {/* 提交信息 + ✨AI 生成 */}
              <div className="relative mt-3">
                <Textarea
                  value={message}
                  disabled={pending || generating}
                  placeholder={t("gitCommitMsgPlaceholder")}
                  onChange={(e) => setMessage(e.target.value)}
                  className="min-h-24 pr-9"
                />
                <button
                  type="button"
                  onClick={() => void handleGenerate()}
                  disabled={pending || generating || !hasChanges}
                  className="absolute right-2 top-2 rounded p-1 text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-40"
                  title={message.trim() ? t("gitCommitRegenerate") : t("gitCommitGenerate")}
                >
                  {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                </button>
              </div>

              {/* 包含未暂存更改（ZCode includeUnstaged 勾选同款） */}
              <button
                type="button"
                role="checkbox"
                aria-checked={includeUnstaged}
                disabled={pending || unstaged.length === 0}
                onClick={() => setIncludeUnstaged((v) => !v)}
                className={`mt-2 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                  pending || unstaged.length === 0
                    ? "cursor-default text-[var(--text-dim)]"
                    : "cursor-pointer text-[var(--text)] hover:bg-[var(--surface-hover)]"
                }`}
              >
                <span
                  className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${
                    includeUnstaged ? "border-[var(--brand)] bg-[var(--brand)] text-white" : "border-[var(--border)]"
                  }`}
                >
                  {includeUnstaged ? "✓" : ""}
                </span>
                <span className="min-w-0 flex-1 truncate">{t("gitCommitIncludeUnstaged")}</span>
                <span className="shrink-0 text-[var(--text-dim)]">
                  {fmt(t("gitCommitFilesCount"), { count: selected.length })}
                </span>
              </button>

              {/* 身份缺失警告 */}
              {!hasIdentity ? (
                <div
                  className="mt-2 flex items-start gap-2 rounded-lg border p-2.5 text-xs"
                  style={{ background: "var(--warn-bg)", borderColor: "var(--warn-border)", color: "var(--warn-text)" }}
                >
                  <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <p>{t("gitBranchCommitIdentityMissing")}</p>
                </div>
              ) : null}

              {error ? (
                <p className="mt-2 break-all text-xs" style={{ color: "var(--danger)" }}>
                  {error}
                </p>
              ) : null}
            </DialogBody>
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!canSubmit}
                onClick={() => void runCommit(true)}
              >
                {t("gitCommitAndPush")}
              </Button>
              <Button type="submit" size="sm" disabled={!canSubmit}>
                {pending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                {t("gitCommitSubmit")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
