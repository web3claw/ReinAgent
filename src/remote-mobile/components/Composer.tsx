/**
 * Composer —— 手机端输入条（ZCode 移动端 V4Composer 同款形态）：
 * 大圆角容器两行式——上行输入区、下行工具行（+ 附件 / 审批盾 / 流式 spinner / 模型名˅ /
 * 思考等级条 / 停止-发送）；流式中占位变「排队」语义、发送键变停止；排队消息列表（× 撤回）。
 */
import { useEffect, useRef, useState } from "react";
import { Activity, Box, Brain, Check, Hand, Lightbulb, LoaderIcon, Plus, Send, Shield, ShieldCheck, Square } from "lucide-react";
import type { RemoteAttachmentRef, RemoteContextUsage, RemoteProviderModels, TaskOptions } from "../api/protocol";
import { formatCompactTokens } from "../../lib/chat/contextUsage";
import { removeQueuedMessage, setApprovalMode, setTaskModel, setThinkingLevel, stopTask, uploadAttachments } from "../api/client";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui";
import { useRemoteIntl, useRemoteT } from "../i18n";
import { cn } from "../lib/cn";

const APPROVAL_MODES = ["plan", "ask", "edit", "full"] as const;
/** 审批模式元数据（ZCode 弹窗同款：图标 + 标题 + 描述副行；触发器橙色 = 完全访问风险提示）。 */
const APPROVAL_META: Record<(typeof APPROVAL_MODES)[number], { icon: typeof Shield; descKey: string }> = {
  plan: { icon: Lightbulb, descKey: "remote.approvalMode.plan.desc" },
  ask: { icon: Hand, descKey: "remote.approvalMode.ask.desc" },
  edit: { icon: ShieldCheck, descKey: "remote.approvalMode.edit.desc" },
  full: { icon: Shield, descKey: "remote.approvalMode.full.desc" },
};
const THINKING_LEVELS = ["off", "default", "low", "medium", "high", "xhigh", "max"] as const;

function contextBadge(contextWindow: number | null): string {
  if (!contextWindow || contextWindow <= 0) return "";
  if (contextWindow >= 1_000_000) return "1M";
  if (contextWindow >= 1000) return `${Math.round(contextWindow / 1000)}K`;
  return String(contextWindow);
}

/** mini 上下文用量环（对齐 ZCode ContextUsageIndicator 移动形态）。 */
function ContextRing({ percent }: { percent: number }) {
  const ratio = Math.max(0, Math.min(1, percent / 100));
  const r = 7;
  const circumference = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 20 20" className="size-[18px] -rotate-90">
      <circle cx="10" cy="10" r={r} fill="none" stroke="var(--zcode-border-hover)" strokeWidth="2.5" />
      {ratio > 0 ? (
        <circle
          cx="10"
          cy="10"
          r={r}
          fill="none"
          stroke="var(--zcode-brand)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={`${(circumference * ratio).toFixed(2)} ${circumference.toFixed(2)}`}
        />
      ) : null}
    </svg>
  );
}

export function RemoteComposer({
  taskId,
  running,
  queuedMessages,
  options,
  models,
  contextUsage,
  onSend,
  onOptionsChanged,
}: {
  taskId: string | null;
  running: boolean;
  queuedMessages: string[];
  options: TaskOptions | null;
  models: RemoteProviderModels[] | null;
  contextUsage: RemoteContextUsage | null;
  onSend: (text: string, attachments: RemoteAttachmentRef[]) => void;
  onOptionsChanged: () => void;
}) {
  const t = useRemoteT();
  const { locale } = useRemoteIntl();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<RemoteAttachmentRef[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [text]);

  const currentModelId = options?.modelId ?? null;
  const currentProviderId = options?.providerId ?? null;
  const submit = () => {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || busy) return;
    setBusy(true);
    onSend(trimmed, attachments);
    setText("");
    setAttachments([]);
    setBusy(false);
  };

  const handlePickFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploadError(null);
    setUploading(true);
    try {
      const uploaded = await uploadAttachments({ taskId, files: Array.from(files) });
      setAttachments((prev) => [...prev, ...uploaded].slice(0, 9));
    } catch (err) {
      setUploadError(t("remote.chat.uploadFailed", {
        error: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const approvalMode = options?.approvalMode ?? "full";

  return (
    <div className="shrink-0 px-2 pt-1 pb-[max(8px,env(safe-area-inset-bottom))]">
      {/* 排队消息（流式中 send 入队的引导消息） */}
      {queuedMessages.length > 0 ? (
        <div className="mx-1 mb-1.5 rounded-lg border border-border bg-card px-2 py-1.5">
          <div className="text-ui-xs font-medium text-foreground-subtle">
            {t("remote.chat.queuedHeader")} · {queuedMessages.length}
          </div>
          <ul className="mt-1 space-y-1">
            {queuedMessages.map((queued, index) => (
              <li key={`${index}-${queued.slice(0, 16)}`} className="flex items-start gap-1.5">
                <span className="min-w-0 flex-1 text-ui-sm break-all text-foreground-subtle">
                  {queued.length > 120 ? `${queued.slice(0, 120)}…` : queued}
                </span>
                <button
                  type="button"
                  aria-label="remove queued"
                  className="mt-0.5 shrink-0 text-foreground-subtlest"
                  onClick={() => {
                    if (!taskId) return;
                    void removeQueuedMessage(taskId, index);
                  }}
                >
                  <XIcon />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* 附件条 */}
      {attachments.length > 0 || uploadError || uploading ? (
        <div className="mx-1 mb-1.5 flex flex-wrap gap-1.5">
          {attachments.map((a) => (
            <span
              key={a.path}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-ui-xs text-foreground-subtle"
            >
              <span className="max-w-40 truncate">{a.name}</span>
              <button
                type="button"
                aria-label="remove"
                onClick={() => setAttachments((prev) => prev.filter((x) => x.path !== a.path))}
              >
                <XIcon />
              </button>
            </span>
          ))}
          {uploading ? (
            <span className="inline-flex items-center gap-1 text-ui-xs text-foreground-subtle">
              <LoaderIcon className="size-3 animate-spin" />
              {t("remote.chat.uploading")}
            </span>
          ) : null}
          {uploadError ? <span className="text-ui-xs text-destructive">{uploadError}</span> : null}
        </div>
      ) : null}

      {/* 大圆角容器两行式（ZCode V4Composer 移动形态） */}
      <div className="rounded-[24px] border border-border bg-card px-1.5 pt-1 pb-1">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => void handlePickFiles(e.target.files)}
        />
        <textarea
          ref={textareaRef}
          className="composer-input min-h-[40px] px-2.5 pt-2 text-ui-base"
          rows={1}
          value={text}
          placeholder={running ? t("remote.chat.followUpQueue") : t("remote.chat.inputPlaceholder")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="mt-0.5 flex items-center gap-0.5">
          {/* + 附件 */}
          <Button
            size="icon-sm"
            aria-label={t("remote.chat.attach")}
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <Plus className="size-[18px]" />
          </Button>

          {/* 审批模式盾 */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                aria-label={t("remote.chat.approvalMode")}
                className={cn(approvalMode === "full" && "text-warning!")}  // ghost 变体的 text-foreground 同特异性，需 ! 压过
              >
                {(() => {
                  const Meta = APPROVAL_META[approvalMode as keyof typeof APPROVAL_META] ?? APPROVAL_META.full;
                  const MetaIcon = Meta.icon;
                  return <MetaIcon className="size-[18px]" />;
                })()}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuLabel>{t("remote.chat.approvalMode")}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {APPROVAL_MODES.map((mode) => {
                const meta = APPROVAL_META[mode];
                const MetaIcon = meta.icon;
                const active = mode === approvalMode;
                return (
                  <DropdownMenuItem
                    key={mode}
                    className={cn(active && "bg-selected")}
                    onSelect={() => {
                      void setApprovalMode({ taskId, mode }).then(onOptionsChanged).catch(() => undefined);
                    }}
                  >
                    <MetaIcon className="size-4 shrink-0 text-foreground-subtle" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={cn("text-ui-sm leading-tight", active && "font-medium")}>
                        {t(`remote.approvalMode.${mode}`)}
                      </span>
                      <span className="text-ui-xs leading-tight text-foreground-subtle">
                        {t(meta.descKey)}
                      </span>
                    </span>
                    {active ? <Check className="size-4 shrink-0 text-foreground-subtle" /> : null}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* 排队指示器（Activity 图标 + 数量；仅真实排队时显示，无排队不放假按钮） */}
          {queuedMessages.length > 0 ? (
            <span
              className="relative inline-flex size-7 shrink-0 items-center justify-center text-foreground-subtle"
              aria-label={t("remote.chat.queuedHeader")}
              title={t("remote.chat.queuedHeader")}
            >
              <Activity className="size-[18px]" />
              <span className="absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full bg-brand px-1 text-center text-[9px] leading-3.5 text-white">
                {queuedMessages.length}
              </span>
            </span>
          ) : null}

          <span className="flex-1" />

          {/* 上下文容量（mini 环 + 点开面板；数据取真实 usage，无数据如实提示） */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" aria-label={t("remote.chat.contextTitle")}>
                {contextUsage ? (
                  <ContextRing percent={contextUsage.percent} />
                ) : (
                  <ContextRing percent={0} />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel>{t("remote.chat.contextTitle")}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {contextUsage ? (
                <div className="px-2 py-2">
                  <div className="flex items-baseline justify-between">
                    <span className="text-ui-sm font-medium text-foreground">{t("remote.chat.contextTitle")}</span>
                    <span className="text-ui-xs text-foreground-subtle">
                      {formatCompactTokens(contextUsage.used, locale)}/{formatCompactTokens(contextUsage.total, locale)}{" "}
                      ({contextUsage.percent.toFixed(1)}%)
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface">
                    <div
                      className="h-full rounded-full bg-brand"
                      style={{ width: `${Math.min(100, contextUsage.percent).toFixed(1)}%` }}
                    />
                  </div>
                  <ul className="mt-2 space-y-1">
                    {contextUsage.categories.map((cat, index) => (
                      <li key={cat.key} className="flex items-center gap-2">
                        <span
                          className={cn(
                            "rounded-full",
                            cat.percent <= 0
                              ? "size-2 border border-border"
                              : index === 0
                                ? "size-2.5 bg-brand"
                                : "size-2 bg-brand",
                            cat.percent > 0 && index > 0 && (index === 1 ? "opacity-70" : index === 2 ? "opacity-55" : "opacity-40"),
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate text-ui-xs text-foreground-subtle">
                          {t(cat.labelKey)}
                        </span>
                        <span className="shrink-0 text-ui-xs text-foreground-subtle">
                          {cat.percent <= 0 ? "0%" : `${cat.percent.toFixed(1)}%`}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {contextUsage.hitRate !== undefined ? (
                    <div className="mt-2 flex items-center justify-between border-t border-border pt-1.5 text-ui-xs">
                      <span className="text-foreground-subtle">{t("remote.chat.contextHitRate")}</span>
                      <span className="text-foreground-subtle">{(contextUsage.hitRate * 100).toFixed(1)}%</span>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="px-2 py-1.5 text-ui-xs text-foreground-subtle">
                  {t("remote.chat.contextNone")}
                </div>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* 模型选择器（方块图标，ZCode 同款） */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" aria-label={t("remote.chat.modelSelect")}>
                <Box className="size-[18px]" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-[60vh] w-64 overflow-y-auto">
              {models === null ? (
                <div className="px-2 py-2 text-ui-sm text-foreground-subtle">
                  <LoaderIcon className="mr-1.5 inline size-3 animate-spin" />
                  {t("common.loading")}
                </div>
              ) : models.length === 0 ? (
                <div className="px-2 py-2 text-ui-sm text-foreground-subtle">{t("remote.chat.noModels")}</div>
              ) : (
                models.map((provider) => (
                  <div key={provider.id}>
                    <DropdownMenuLabel>{provider.name}</DropdownMenuLabel>
                    {provider.models.map((model) => {
                      const active = provider.id === currentProviderId && model.id === currentModelId;
                      return (
                        <DropdownMenuItem
                          key={`${provider.id}/${model.id}`}
                          className={cn(active && "bg-selected")}
                          onSelect={() => {
                            void setTaskModel({ taskId, providerId: provider.id, modelId: model.id })
                              .then(onOptionsChanged)
                              .catch(() => undefined);
                          }}
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {model.name || model.id}
                            {active ? " ✓" : ""}
                          </span>
                          {contextBadge(model.contextWindow) ? (
                            <span className="shrink-0 rounded border border-border px-1 font-mono text-[10px] text-foreground-subtlest">
                              {contextBadge(model.contextWindow)}
                            </span>
                          ) : null}
                        </DropdownMenuItem>
                      );
                    })}
                    <DropdownMenuSeparator />
                  </div>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* 推理强度（brain + 等级条） */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" aria-label={t("remote.chat.thinkingLevel")}>
                <Brain className="size-[18px]" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuLabel>{t("remote.chat.thinkingLevel")}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {THINKING_LEVELS.map((level) => {
                const active = (options?.thinkingLevel ?? "default") === level;
                return (
                  <DropdownMenuItem
                    key={level}
                    className={cn(active && "bg-selected")}
                    onSelect={() => {
                      void setThinkingLevel({ taskId, level }).then(onOptionsChanged).catch(() => undefined);
                    }}
                  >
                    <span className={cn(active && "font-medium")}>{t(`remote.thinking.${level}`)}</span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* 停止（运行中，中性方框对齐 ZCode）/ 发送 */}
          {running ? (
            <Button
              size="icon-sm"
              aria-label={t("remote.chat.stop")}
              className="border border-border bg-surface"
              onClick={() => {
                if (taskId) void stopTask(taskId);
              }}
            >
              <Square className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="icon-sm"
              aria-label={t("remote.chat.send")}
              className="rounded-full bg-brand"
              disabled={busy || (!text.trim() && attachments.length === 0)}
              onClick={submit}
            >
              <Send className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
