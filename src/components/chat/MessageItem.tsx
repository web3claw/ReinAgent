import { memo, useState, useCallback, useEffect } from "react";
import * as Popover from "@radix-ui/react-popover";
import type { TimelineEntry, ToolTimelineEntry } from "../../lib/chat/conversationModel";
import { MarkdownText } from "./MarkdownText";
import { ToolCallCard } from "./ToolCallCard";
import { Copy, Check, Pencil, Play, RotateCw, Undo2, Loader2, GitBranch } from "lucide-react";
import { useTranslation } from "../../i18n";
import { errorCategory } from "../../lib/chat/errors.js";
import { ImageLightbox } from "./ImageLightbox";
import { EditableUserMessageBubble } from "./EditableUserMessageBubble";
import { ChatLoading } from "./ChatLoading";
import { useCheckpointRewindAction } from "../../lib/chat/checkpointRewind";
import { wasRecentlyCreated } from "../../lib/chat/entranceOnce.js";
import type { UserAttachmentRef } from "../../lib/chat/attachments";

/**
 * 类型收窄守卫：把工具条目从联合类型里挑出来。
 *
 * 为什么需要它（而不是直接写 `message.role === "tool"`）：
 *   `ChatMessage.role` 的类型被 S7 放宽为 `TimelineRole`（含 "tool"），
 *   所以仅凭 `message.role === "tool"` **无法**把 `ChatMessage | ToolTimelineEntry`
 *   收窄到 `ToolTimelineEntry` —— TS 会保留 `ChatMessage` 这一支，于是传给
 *   `ToolCallCard` 时会报「缺少 toolCallId / resultText 等必填字段」。
 *   用 `is` 谓词显式收窄即可。
 */
function isToolEntry(message: TimelineEntry): message is ToolTimelineEntry {
  return message.role === "tool";
}

export interface MessageItemProps {
  message: TimelineEntry;
  /** 发送/流式中禁用全部行内动作（对齐 LiveAgent isSending）。 */
  actionsDisabled?: boolean;
  /** 本行是否处于编辑态（由 MessageList 的单值 editingMessageKey 下发）。 */
  isEditing?: boolean;
  onStartEdit?: (messageId: string) => void;
  onCancelEdit?: () => void;
  /** 编辑重发：提交（新文本 + 保留附件）。异步执行；调用方先退出编辑态（对齐 LiveAgent）。 */
  onEditResend?: (messageId: string, text: string, attachments: UserAttachmentRef[]) => void;
  /** 以原始提问重发该条所在轮（对齐 LiveAgent retry：截断该回复及其后内容后重跑）。 */
  onRetryFrom?: (messageId: string) => void;
  /** 从某条回复创建分支（复制前缀进新任务并切换）。 */
  onBranchFrom?: (messageId: string) => void;
  /** 追加发送新消息（「已达最大步数 → 继续」按钮沿用普通发送路径）。 */
  onAppendSend?: (text: string) => void;
  /** 搜索跳转定位高亮（外部下发；短暂亮边框后由父级清除）。 */
  highlight?: boolean;
}

/**
 * 单条消息渲染组件：
 * - 仿 ZCode 对话流与气泡外观：
 *   - 用户消息：靠右对齐、不对称圆角气泡、独立 hover 动作栏（复制、编辑、回退本轮代码改动）
 *   - 编辑状态：整行替换为 EditableUserMessageBubble（对齐 LiveAgent，Esc 取消/按钮发送）
 *   - 助手消息：居左、Markdown 渲染、流式光标、快捷复制动作栏 + 确认弹层重试按钮
 */
function MessageItemImpl({
  message,
  actionsDisabled = false,
  isEditing = false,
  onStartEdit,
  onCancelEdit,
  onEditResend,
  onRetryFrom,
  onBranchFrom,
  onAppendSend,
  highlight = false,
}: MessageItemProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [retryConfirmOpen, setRetryConfirmOpen] = useState(false);
  const [branchConfirmOpen, setBranchConfirmOpen] = useState(false);
  // 动作栏右侧时间戳（YYYY-MM-DD HH:mm，对齐 LiveAgent；无打点不显示）
  const messageTime = (() => {
    const ms = message.endedAt ?? message.startedAt;
    if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  })();
  // 回退本轮代码改动（检查点行内按钮，对齐 LiveAgent Undo2 + Loader2）。
  // ★ Hook 必须在顶部无条件调用（组件有 tool/user/assistant 三个提前 return 分支）。
  const rewind = useCheckpointRewindAction(message.role === "user" ? message.id : undefined);

  // 用户消息图片附件：缩略图预览（会话内已有 previewUrl 直接用；历史消息懒加载）
  const userImages = (message.attachments ?? []).filter((a) => a.kind === "image");
  const [previewMap, setPreviewMap] = useState<Record<string, string>>({});
  const [lightbox, setLightbox] = useState<{ src: string; name: string } | null>(null);

  useEffect(() => {
    const missing = userImages.filter(
      (a) => !a.previewUrl && !previewMap[a.path] && !(previewMap[a.path] === ""),
    );
    if (missing.length === 0) return;
    let active = true;
    void (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      for (const a of missing) {
        try {
          const res = await invoke<{ mime: string; base64: string }>("fs_read_image_preview", {
            path: a.path,
          });
          if (!active) return;
          setPreviewMap((prev) => ({
            ...prev,
            [a.path]: `data:${res.mime};base64,${res.base64}`,
          }));
        } catch (err) {
          console.warn("[attachment] message preview failed:", err);
          if (active) setPreviewMap((prev) => ({ ...prev, [a.path]: "" }));
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [userImages, previewMap]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 忽略复制异常
    }
  }, [message.text]);

  if (isToolEntry(message)) {
    return <ToolCallCard entry={message} />;
  }

  // ===================== 用户消息分支 =====================
  if (message.role === "user") {
    // 编辑态附件快照：会话内直接用 previewUrl，历史消息用已懒加载的预览。
    const editAttachments: UserAttachmentRef[] = (message.attachments ?? []).map((a) => ({
      path: a.path,
      name: a.name,
      kind: a.kind,
      previewUrl: a.previewUrl ?? (a.kind === "image" ? previewMap[a.path] || undefined : undefined),
    }));

    if (isEditing) {
      return (
        <div className="group/user-row flex w-full flex-col items-end" data-msg-id={message.id}>
          <EditableUserMessageBubble
            initialText={message.text}
            attachments={editAttachments}
            preserveViewportScrollOnFocus
            onCancel={onCancelEdit ?? (() => {})}
            onSubmit={(text, kept) => {
              // 对齐 LiveAgent：先退出编辑态，再异步触发重发（失败时原历史保持不变）。
              onCancelEdit?.();
              onEditResend?.(message.id, text, kept);
            }}
          />
        </div>
      );
    }

    // 编辑重发替换出的新气泡：诞生窗口内播放入场动画（对齐 LiveAgent chat-bubble-enter）。
    const entrance = wasRecentlyCreated(message.id);

    return (
      <div
        className={`group/user-row flex w-full flex-col items-end ${highlight ? "msg-search-hit" : ""}`}
        data-msg-id={message.id}
      >
        <div
          className={`flex max-w-2xl flex-col gap-2 rounded-2xl rounded-tr-sm border border-[#2563eb] dark:border-[#3a5db0] bg-[#2563eb] dark:bg-[#3a5db0] px-4 py-3 text-sm text-white shadow-xs ${
            entrance ? "chat-bubble-enter" : ""
          }`}
        >
          {message.attachments && message.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {message.attachments.map((a) =>
                a.kind === "image" ? (
                  <button
                    key={a.path}
                    type="button"
                    title={`${a.name}（点击放大）`}
                    ref={(el) => {
                      // 原生 onclick 绑定：绕过 React 合成事件委托（同 Composer 缩略图）
                      if (el) {
                        el.onclick = (ev) => {
                          ev.stopPropagation();
                          const src = previewMap[a.path] ?? a.previewUrl;
                          if (src) setLightbox({ src, name: a.name });
                        };
                      }
                    }}
                    className="block h-28 rounded-lg overflow-hidden border border-white/30 cursor-zoom-in"
                  >
                    {previewMap[a.path] || a.previewUrl ? (
                      <img
                        src={previewMap[a.path] ?? a.previewUrl}
                        alt={a.name}
                        className="h-full w-auto max-w-56 object-cover"
                      />
                    ) : (
                      <span className="flex items-center justify-center w-28 h-full text-white/70 text-xs">
                        图片加载中…
                      </span>
                    )}
                  </button>
                ) : (
                  <div
                    key={a.path}
                    className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-white/15 text-xs"
                    title={a.path}
                  >
                    📄 {a.name}
                  </div>
                ),
              )}
            </div>
          )}
          <span className="whitespace-pre-wrap break-words leading-relaxed select-text">{message.text}</span>
        </div>

        {/* 底部动作栏：悬停时淡入显示（复制 + 编辑 + 回退本轮代码改动） */}
        <div className="flex items-center gap-1 mt-1 opacity-0 transition-opacity group-hover/user-row:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            onClick={handleCopy}
            title={copied ? t("copied") : t("copy")}
            className="p-1.5 rounded-md hover:bg-[var(--surface-hover)] text-[var(--text-dim)] hover:text-[var(--text)] transition-colors flex items-center gap-1 text-xs cursor-pointer"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
            {copied && <span className="text-[11px] text-green-500">{t("copied")}</span>}
          </button>

          {rewind && (
            <button
              type="button"
              title={rewind.available ? t("rewindCode") : t("rewindUnavailable")}
              aria-label={rewind.available ? t("rewindCode") : t("rewindUnavailable")}
              disabled={rewind.disabled || !rewind.available}
              onClick={rewind.onRewind}
              className="p-1.5 rounded-md hover:bg-[var(--surface-hover)] text-[var(--text-dim)] hover:text-[var(--text)] transition-colors flex items-center text-xs cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
            >
              {rewind.pending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Undo2 className="w-3.5 h-3.5" />
              )}
            </button>
          )}

          {onEditResend && (
            <button
              type="button"
              onClick={() => onStartEdit?.(message.id)}
              disabled={actionsDisabled}
              title={t("edit")}
              aria-label={t("edit")}
              className="p-1.5 rounded-md hover:bg-[var(--surface-hover)] text-[var(--text-dim)] hover:text-[var(--text)] transition-colors flex items-center gap-1 text-xs cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {lightbox && (
          <ImageLightbox src={lightbox.src} name={lightbox.name} onClose={() => setLightbox(null)} />
        )}
      </div>
    );
  }

  // ===================== 助手消息分支 =====================
  return (
    <div
      className={`group/assistant-row flex flex-col items-start w-full ${highlight ? "msg-search-hit" : ""}`}
      data-msg-id={message.id}
    >
      <div className="w-full text-sm text-[var(--text)] leading-relaxed">
        <div className="md">
          <MarkdownText text={message.text} streaming={message.status === "streaming"} />
          {message.status === "streaming" ? <ChatLoading loading size="sm" className="mt-1" /> : null}
        </div>

        {message.status === "stopped" ? <div className="msg-stopped mt-2">已停止</div> : null}
        {message.truncatedBy === "maxSteps" ? (
          <div className="msg-max-steps mt-2 flex items-center justify-between gap-3">
            <span>{t("maxStepsReached") || "已达最大步数，本次回复已停止。"}</span>
            {onAppendSend && (
              <button
                type="button"
                onClick={() => onAppendSend(t("continuePrompt") || "请继续执行未完成的步骤")}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-[var(--warn-bg)] hover:bg-[var(--surface-hover)] border border-[var(--warn-border)] text-[var(--warn-text)] cursor-pointer transition-all active:scale-95 shrink-0 shadow-sm"
                title={t("continuePrompt") || "请继续执行未完成的步骤"}
              >
                <Play className="w-3 h-3 fill-current" />
                <span>{t("continueTask") || "继续"}</span>
              </button>
            )}
          </div>
        ) : null}
        {message.status === "error" ? (
          <div className="msg-error mt-2 flex items-start justify-between gap-3">
            <div className="min-w-0 break-words">
              {/* 错误归因徽标（P2-B1）：分类 key → i18n 标签 */}
              {(() => {
                const category = errorCategory(message.error);
                if (category === "unknown") return null;
                const label = (t as (key: string) => string)(`errorCategory.${category}`);
                return (
                  <span className="mr-1.5 inline-block rounded border border-[var(--danger-border,rgba(239,68,68,0.3))] px-1.5 py-0.5 text-[11px] font-medium text-red-400 align-baseline">
                    {label}
                  </span>
                );
              })()}
              {message.error}
              {message.errorHint && message.errorHint !== message.error
                ? ` · ${message.errorHint}`
                : null}
            </div>
            {onRetryFrom && (
              <button
                type="button"
                onClick={() => onRetryFrom(message.id)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-[var(--danger-bg,rgba(239,68,68,0.1))] hover:bg-[var(--surface-hover)] border border-[var(--danger-border,rgba(239,68,68,0.3))] text-red-500 cursor-pointer transition-all active:scale-95 shrink-0 shadow-sm"
                title={t("retry")}
              >
                <RotateCw className="w-3 h-3" />
                <span>{t("retry")}</span>
              </button>
            )}
          </div>
        ) : null}
      </div>

      {/* 助手消息动作栏：常显（复制 / 确认弹层重试 / 确认弹层创建分支 + 右侧时间戳，
          对齐 LiveAgent TranscriptMessageActions 三图标 + 时间格式 YYYY-MM-DD HH:mm） */}
      {message.status !== "streaming" ? (
        <div className="flex items-center gap-1 mt-2 text-[var(--text-dim)]">
          <button
            type="button"
            onClick={handleCopy}
            title={copied ? t("copied") : t("copy")}
            className="p-1 rounded-md hover:bg-[var(--surface-hover)] hover:text-[var(--text)] transition-colors flex items-center gap-1 text-xs cursor-pointer"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
            {copied && <span className="text-[11px] text-green-500">{t("copied")}</span>}
          </button>
          {onRetryFrom && !actionsDisabled && (
            <Popover.Root open={retryConfirmOpen} onOpenChange={setRetryConfirmOpen}>
              <Popover.Trigger asChild>
                <button
                  type="button"
                  title={t("retry")}
                  className="p-1 rounded-md hover:bg-[var(--surface-hover)] hover:text-[var(--text)] transition-colors flex items-center text-xs cursor-pointer"
                >
                  <RotateCw className="w-3.5 h-3.5" />
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  align="start"
                  sideOffset={6}
                  className="z-50 w-64 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-2xl"
                >
                  <div className="text-xs font-medium text-[var(--text)]">{t("retryConfirmTitle")}</div>
                  <div className="mt-1.5 text-xs leading-relaxed text-[var(--text-secondary)]">
                    {t("retryConfirmDescription")}
                  </div>
                  <div className="mt-3 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setRetryConfirmOpen(false)}
                      className="h-7 cursor-pointer rounded-lg border border-[var(--border)] px-2.5 text-xs text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)]"
                    >
                      {t("cancel")}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRetryConfirmOpen(false);
                        onRetryFrom(message.id);
                      }}
                      className="h-7 cursor-pointer rounded-lg bg-[var(--danger)] px-2.5 text-xs text-white transition-opacity hover:opacity-90"
                    >
                      {t("retry")}
                    </button>
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          )}
          {onBranchFrom && !actionsDisabled && (
            <Popover.Root open={branchConfirmOpen} onOpenChange={setBranchConfirmOpen}>
              <Popover.Trigger asChild>
                <button
                  type="button"
                  title={t("branch")}
                  className="p-1 rounded-md hover:bg-[var(--surface-hover)] hover:text-[var(--text)] transition-colors flex items-center text-xs cursor-pointer"
                >
                  <GitBranch className="w-3.5 h-3.5" />
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  align="start"
                  sideOffset={6}
                  className="z-50 w-64 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-2xl"
                >
                  <div className="text-xs font-medium text-[var(--text)]">{t("branchConfirmTitle")}</div>
                  <div className="mt-1.5 text-xs leading-relaxed text-[var(--text-secondary)]">
                    {t("branchConfirmDescription")}
                  </div>
                  <div className="mt-3 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setBranchConfirmOpen(false)}
                      className="h-7 cursor-pointer rounded-lg border border-[var(--border)] px-2.5 text-xs text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)]"
                    >
                      {t("cancel")}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setBranchConfirmOpen(false);
                        onBranchFrom(message.id);
                      }}
                      className="h-7 cursor-pointer rounded-lg bg-[var(--brand)] px-2.5 text-xs text-white transition-opacity hover:opacity-90"
                    >
                      {t("branch")}
                    </button>
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          )}
          {messageTime && (
            <span className="ml-auto whitespace-nowrap text-xs tabular-nums text-[var(--text-dim)] opacity-70">
              {messageTime}
            </span>
          )}
        </div>
      ) : null}
      {lightbox && (
        <ImageLightbox src={lightbox.src} name={lightbox.name} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}

/**
 * 包一层 `memo`：流式期间 `MessageList` 每个 delta 都会重渲染（messages 数组是新的），
 * 但状态机里**只有发生变化的那一条**条目会得到新对象引用，其余条目引用稳定。
 * 默认浅比较即可跳过未变条目（尤其无内部 memo 的用户消息），省掉长会话下的白烧渲染。
 */
export const MessageItem = memo(MessageItemImpl);
