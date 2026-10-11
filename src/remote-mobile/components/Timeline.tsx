/**
 * Timeline —— 手机端会话时间线（serializeEntry 行渲染）。
 * 形态对齐 ZCode 手机对话：user 气泡 / assistant 思考块+正文 / 工具折叠卡 / 错误行。
 * 纯展示；工具标签复用桌面 turnActivity 纯函数（toolKindLabel/toolArgPath/toolArgCommand）。
 */
import { memo, useState } from "react";
import { AlertCircle, ChevronDown, ChevronRight, FileText, ImageIcon } from "lucide-react";
import type { TimelineRow, TimelineRowPart } from "../api/protocol";
import { MobileMarkdown } from "./MobileMarkdown";
import { toolArgCommand, toolArgPath, toolKindLabel } from "../../lib/chat/turnActivity";
import { useRemoteIntl, useRemoteT } from "../i18n";
import { cn } from "../lib/cn";

function parsePart<T>(part: TimelineRowPart | undefined, fallback: T): T {
  if (!part) return fallback;
  try {
    return JSON.parse(part.payload) as T;
  } catch {
    return fallback;
  }
}

function ToolRow({ row, locale }: { row: TimelineRow; locale: string }) {
  const [expanded, setExpanded] = useState(false);
  const t = useRemoteT();
  const args = parsePart<unknown>(row.parts.find((p) => p.kind === "tool_args"), null);
  const result = parsePart<{ resultText?: string; details?: { error?: string } }>(
    row.parts.find((p) => p.kind === "tool_result"),
    {},
  );
  const path = toolArgPath(args);
  const command = toolArgCommand(args);
  const label = toolKindLabel(row.tool_name ?? "", locale);
  const isRunning = row.status === "running";
  const isError = row.status === "error" || row.is_error === true;
  const resultText = result.resultText ?? "";

  return (
    <div
      className="mx-3 my-1.5 overflow-hidden rounded-lg border border-card-border bg-card"
      data-tool-row={row.tool_name ?? ""}
    >
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        {isError ? <AlertCircle className="size-3.5 shrink-0 text-destructive" /> : null}
        <span className={cn("shrink-0 font-medium text-foreground", isRunning && "shimmer-text")}>
          {label}
        </span>
        {path ? (
          <span className="min-w-0 flex-1 truncate font-mono text-ui-xs text-foreground-subtle">{path}</span>
        ) : command ? (
          <span className="min-w-0 flex-1 truncate font-mono text-ui-xs text-foreground-subtle">
            {command}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <span className="shrink-0 text-ui-xs text-foreground-subtlest">
          {!isRunning && isError ? t("webRemoteControl.taskStatus.error") : null}
        </span>
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-foreground-subtle" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-foreground-subtle" />
        )}
      </button>
      {expanded && resultText ? (
        <pre className="no-scrollbar max-h-56 overflow-auto border-t border-card-border bg-surface px-3 py-2 font-mono text-ui-xs break-all whitespace-pre-wrap text-foreground-subtle">
          {resultText}
        </pre>
      ) : null}
      {expanded && isError && (result.details?.error ?? row.error) ? (
        <pre className="max-h-40 overflow-auto border-t border-destructive/30 bg-destructive/10 px-3 py-2 font-mono text-ui-xs break-all whitespace-pre-wrap text-destructive">
          {result.details?.error ?? row.error}
        </pre>
      ) : null}
    </div>
  );
}

function ThinkingRow({ row }: { row: TimelineRow }) {
  const [expanded, setExpanded] = useState(false);
  const t = useRemoteT();
  const thinking = parsePart<{ thinking?: string }>(
    row.parts.find((p) => p.kind === "thinking"),
    {},
  ).thinking ?? "";
  const isStreaming = row.status === "streaming" && !row.ended_at && !row.thinking_duration_ms;
  if (!thinking) return null;
  const seconds = row.thinking_duration_ms
    ? Math.max(1, Math.round(row.thinking_duration_ms / 1000))
    : null;

  return (
    <div className="mx-3 my-1">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 py-1 text-left text-ui-sm text-foreground-subtle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {isStreaming ? (
          <span className="shimmer-text">{t("remote.chat.thinkingLabel")}</span>
        ) : (
          <span>
            {t("remote.chat.thoughtLabel")}
            {seconds !== null ? ` · ${seconds}s` : ""}
          </span>
        )}
      </button>
      {expanded ? (
        <div className="thinking-body ml-2.5 border-l border-border pl-3">{thinking}</div>
      ) : null}
    </div>
  );
}

function UserRow({ row }: { row: TimelineRow }) {
  const text = parsePart<{ text?: string }>(row.parts.find((p) => p.kind === "text"), {}).text ?? "";
  const attachments = parsePart<{ attachments?: { path: string; name: string; kind: string }[] }>(
    row.parts.find((p) => p.kind === "user_attachments"),
    {},
  ).attachments ?? [];
  return (
    <div className="mx-3 my-2 flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-3.5 py-2.5">
        {text ? (
          <div className="text-ui-base break-words whitespace-pre-wrap text-foreground">{text}</div>
        ) : null}
        {attachments.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {attachments.map((a) => (
              <span
                key={a.path}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-ui-xs text-foreground-subtle"
              >
                {a.kind === "image" ? (
                  <ImageIcon className="size-3 shrink-0" />
                ) : (
                  <FileText className="size-3 shrink-0" />
                )}
                <span className="truncate">{a.name}</span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AssistantRow({ row }: { row: TimelineRow }) {
  const text = parsePart<{ text?: string }>(row.parts.find((p) => p.kind === "text"), {}).text ?? "";
  const streaming = row.status === "streaming";
  const retries = parsePart<{ retryAttempts?: unknown[] }>(
    row.parts.find((p) => p.kind === "retry_attempts"),
    {},
  ).retryAttempts?.length ?? 0;
  return (
    <div className="mx-3 my-2">
      {text ? <MobileMarkdown text={text} streaming={streaming} /> : null}
      {streaming ? (
        <span className="ml-1 inline-block h-4 w-2 translate-y-0.5 animate-pulse rounded-sm bg-foreground-subtle" />
      ) : null}
      {row.error ? (
        <div className="mt-1.5 flex items-start gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-ui-sm text-destructive">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-all">{row.error}</span>
        </div>
      ) : null}
      {retries > 0 ? <div className="mt-1 text-ui-xs text-foreground-subtlest">{retries} retries</div> : null}
    </div>
  );
}

function CompactionRow({ row }: { row: TimelineRow }) {
  const t = useRemoteT();
  const text = parsePart<{ text?: string }>(row.parts.find((p) => p.kind === "text"), {}).text ?? "";
  return (
    <div className="mx-3 my-2 rounded-lg border border-dashed border-border bg-surface px-3 py-2">
      <div className="text-ui-xs font-medium text-foreground-subtle">{t("remote.chat.compactedBand")}</div>
      {text ? (
        <div className="mt-1 line-clamp-3 text-ui-sm whitespace-pre-wrap text-foreground-subtlest">{text}</div>
      ) : null}
    </div>
  );
}

export const Timeline = memo(function Timeline({ rows }: { rows: TimelineRow[] }) {
  const { locale } = useRemoteIntl();
  return (
    <div className="flex flex-col pb-2">
      {rows.map((row, index) => {
        switch (row.role) {
          case "user":
            return <UserRow key={row.msg_id} row={row} />;
          case "tool":
            return <ToolRow key={row.msg_id} row={row} locale={locale} />;
          case "assistant":
          default:
            if (row.msg_id.startsWith("compact-")) {
              return <CompactionRow key={row.msg_id} row={row} />;
            }
            return (
              <div key={row.msg_id || `row-${index}`} data-msg-id={row.msg_id || undefined}>
                <ThinkingRow row={row} />
                <AssistantRow row={row} />
              </div>
            );
        }
      })}
    </div>
  );
});
