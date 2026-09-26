import { memo, useState, useCallback, useEffect } from "react";
import type { TimelineEntry, ToolTimelineEntry } from "../../lib/chat/conversationModel";
import { MarkdownText } from "./MarkdownText";
import { RetryDetailsBlock } from "./RetryDetailsBlock";
import { ToolCallCard } from "./ToolCallCard";
import { Copy, Check, Pencil, CornerDownLeft, X, ThumbsUp, ThumbsDown, Play, RotateCw } from "lucide-react";
import { useTranslation } from "../../i18n";
import { ImageLightbox } from "./ImageLightbox";

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
  onEditSend?: (newText: string) => void;
  onRetry?: () => void;
}

/**
 * 单条消息渲染组件：
 * - 仿 ZCode 对话流与气泡外观：
 *   - 用户消息：靠右对齐、不对称圆角气泡 (rounded-2xl rounded-tr-sm)、独立 hover 动作栏（复制、编辑）
 *   - 编辑状态：行内编辑框，带「取消」与「保存并发送」
 *   - 助手消息：居左、清晰 Markdown 渲染、流式光标、快捷复制动作栏
 */
function MessageItemImpl({ message, onEditSend, onRetry }: MessageItemProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(message.text);

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

  const isUser = message.role === "user";
  const isStreaming = message.status === "streaming";

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 忽略复制异常
    }
  }, [message.text]);

  const handleStartEdit = useCallback(() => {
    setEditText(message.text);
    setIsEditing(true);
  }, [message.text]);

  const handleCancelEdit = useCallback(() => {
    setIsEditing(false);
    setEditText(message.text);
  }, [message.text]);

  const handleSaveAndSend = useCallback(() => {
    const trimmed = editText.trim();
    if (!trimmed) return;
    setIsEditing(false);
    onEditSend?.(trimmed);
  }, [editText, onEditSend]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSaveAndSend();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancelEdit();
    }
  };

  if (isToolEntry(message)) {
    return <ToolCallCard entry={message} />;
  }

  // ===================== 用户消息分支 =====================
  if (isUser) {
    return (
      <div className="group/user-row flex flex-col items-end w-full" data-msg-id={message.id}>
        {isEditing ? (
          // 编辑模式：行内编辑框
          <div className="w-full max-w-2xl bg-[var(--surface)] border border-[var(--border)] rounded-xl p-3 shadow-md flex flex-col gap-2">
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={3}
              autoFocus
              className="w-full bg-transparent text-[var(--text)] text-sm resize-none outline-none border-none leading-relaxed"
              placeholder={t("inputPlaceholder")}
            />
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--border)]">
              <button
                type="button"
                onClick={handleCancelEdit}
                className="flex items-center gap-1 px-3 py-1 rounded text-xs text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
                <span>{t("cancel")}</span>
              </button>
              <button
                type="button"
                onClick={handleSaveAndSend}
                disabled={!editText.trim()}
                className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium bg-[var(--brand)] text-white hover:opacity-90 disabled:opacity-50 transition-opacity cursor-pointer"
              >
                <CornerDownLeft className="w-3.5 h-3.5" />
                <span>{t("resend")}</span>
              </button>
            </div>
          </div>
        ) : (
          // 普通展示模式：ZCode 风格不对称圆角气泡
          <>
            <div className="flex max-w-2xl flex-col gap-2 rounded-2xl rounded-tr-sm border border-[#2563eb] dark:border-[#3a5db0] bg-[#2563eb] dark:bg-[#3a5db0] px-4 py-3 text-sm text-white shadow-xs">
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

            {/* 底部动作栏：悬停时淡入显示（复制 + 编辑） */}
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

              {onEditSend && (
                <button
                  type="button"
                  onClick={handleStartEdit}
                  title={t("edit")}
                  className="p-1.5 rounded-md hover:bg-[var(--surface-hover)] text-[var(--text-dim)] hover:text-[var(--text)] transition-colors flex items-center gap-1 text-xs cursor-pointer"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </>
        )}
        {lightbox && (
          <ImageLightbox src={lightbox.src} name={lightbox.name} onClose={() => setLightbox(null)} />
        )}
      </div>
    );
  }

  // ===================== 助手消息分支 =====================
  return (
    <div className="group/assistant-row flex flex-col items-start w-full">
      <div className="w-full text-sm text-[var(--text)] leading-relaxed">
        <div className="md">
          <MarkdownText text={message.text} streaming={message.status === "streaming"} />
          {isStreaming ? <span className="msg-caret">▋</span> : null}
        </div>

        {message.status === "stopped" ? <div className="msg-stopped mt-2">已停止</div> : null}
        {message.truncatedBy === "maxSteps" ? (
          <div className="msg-max-steps mt-2 flex items-center justify-between gap-3">
            <span>{t("maxStepsReached") || "已达最大步数，本次回复已停止。"}</span>
            {onEditSend && (
              <button
                type="button"
                onClick={() => onEditSend(t("continuePrompt") || "请继续执行未完成的步骤")}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-[var(--warn-bg)] hover:bg-[var(--surface-hover)] border border-[var(--warn-border)] text-[var(--warn-text)] cursor-pointer transition-all active:scale-95 shrink-0 shadow-sm"
                title={t("continuePrompt") || "请继续执行未完成的步骤"}
              >
                <Play className="w-3 h-3 fill-current" />
                <span>{t("continueTask") || "继续"}</span>
              </button>
            )}
          </div>
        ) : null}
        {message.retryAttempts && message.retryAttempts.length > 0 && (
          <RetryDetailsBlock attempts={message.retryAttempts} />
        )}
        {message.status === "error" ? (
          <div className="msg-error mt-2 flex items-center justify-between gap-3">
            <div className="min-w-0">
              {message.error?.includes("自动重试") ? (
                <div className="break-words text-[var(--status-warn)]">{message.error}</div>
              ) : (
                <div className="break-words">{message.error}</div>
              )}
              {message.errorHint && message.errorHint !== message.error && (
                <div className="mt-1 text-xs opacity-60 break-words">{message.errorHint}</div>
              )}
            </div>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-[var(--danger-bg,rgba(239,68,68,0.1))] hover:bg-[var(--surface-hover)] border border-[var(--danger-border,rgba(239,68,68,0.3))] text-red-500 cursor-pointer transition-all active:scale-95 shrink-0 shadow-sm"
                title={t("retryPrompt") || "请重试刚才失败的操作"}
              >
                <RotateCw className="w-3 h-3" />
                <span>{t("retry") || "重试"}</span>
              </button>
            )}
          </div>
        ) : null}
      </div>

      {/* 助手消息动作栏：完成态悬停显现动作按钮（复制、点赞、点踩、时间戳） */}
      {!isStreaming && message.text && (
        <div className="flex items-center gap-1 mt-2 opacity-0 transition-opacity group-hover/assistant-row:opacity-100 focus-within:opacity-100 text-[var(--text-dim)]">
          <button
            type="button"
            onClick={handleCopy}
            title={copied ? t("copied") : t("copy")}
            className="p-1 rounded-md hover:bg-[var(--surface-hover)] hover:text-[var(--text)] transition-colors flex items-center gap-1 text-xs cursor-pointer"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
            {copied && <span className="text-[11px] text-green-500">{t("copied")}</span>}
          </button>
          <button
            type="button"
            className="p-1 rounded-md hover:bg-[var(--surface-hover)] hover:text-[var(--text)] transition-colors flex items-center text-xs cursor-pointer"
            title="赞"
          >
            <ThumbsUp className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            className="p-1 rounded-md hover:bg-[var(--surface-hover)] hover:text-[var(--text)] transition-colors flex items-center text-xs cursor-pointer"
            title="踩"
          >
            <ThumbsDown className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
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
