/**
 * SubagentReplay —— 子代理完整对话回放（P2 尾巴 #7）。
 *
 * 数据源：conversations.db 的 message/part 两表（task_id = `subagent:<runId>`，
 * 由 subagentRunner.persistSubagentTranscript 在运行收束时写入；每条 pi-ai 消息
 * 一个 transcript_message part，忠实原样 JSON）。
 * 读取走既有 conversation_load 命令（跨重启可用，不依赖内存 registry）。
 *
 * 渲染：逐条消息按角色着色——user 提示词 / assistant 正文+思考折叠+工具调用 /
 * toolResult 结果文本。加载失败或无记录时如实显示（诚实空态，不编造）。
 */

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useTranslation } from "../../i18n";

interface ReplayRow {
  msg_id: string;
  seq: number;
  role: string;
  parts: { part_index: number; kind: string; payload: string }[];
}

interface ReplayBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
  toolCallId?: string;
  toolName?: string;
  output?: unknown;
  isError?: boolean;
}

interface ReplayMessage {
  role: string;
  blocks: ReplayBlock[];
}

function parseRow(row: ReplayRow): ReplayMessage | null {
  try {
    const part = row.parts.find((p) => p.kind === "transcript_message");
    if (!part) return null;
    const m = JSON.parse(part.payload) as {
      role?: string;
      content?: unknown;
    };
    const blocks: ReplayBlock[] = [];
    if (typeof m.content === "string") {
      blocks.push({ type: "text", text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && typeof b === "object") blocks.push(b as ReplayBlock);
      }
    }
    return { role: m.role ?? row.role, blocks };
  } catch {
    return null;
  }
}

function blockPreview(block: ReplayBlock): { label: string; body: string } {
  if (block.type === "text" && typeof block.text === "string") {
    return { label: "text", body: block.text };
  }
  if (block.type === "thinking" && typeof block.thinking === "string") {
    return { label: "thinking", body: block.thinking };
  }
  if (block.type === "toolCall" || block.type === "tool_use" || block.type === "tool-call") {
    const name = (block as { name?: string }).name ?? "tool";
    let args = "";
    try {
      args = JSON.stringify((block as { arguments?: unknown }).arguments ?? null, null, 1);
    } catch {
      args = "(unserializable)";
    }
    return { label: `tool: ${name}`, body: args };
  }
  return { label: block.type || "block", body: JSON.stringify(block, null, 1).slice(0, 800) };
}

export function SubagentReplay({
  runId,
  fallbackTitle,
  onBack,
}: {
  runId: string;
  fallbackTitle?: string;
  onBack?: () => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ReplayRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const page = await invoke<{ rows: ReplayRow[] }>("conversation_load_page", {
          taskId: `subagent:${runId}`,
          limit: 500,
        });
        if (!cancelled) setRows(page.rows);
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const messages = useMemo(
    () => (rows ?? []).map(parseRow).filter((m): m is ReplayMessage => m !== null),
    [rows],
  );

  const title = fallbackTitle || `subagent:${runId}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            aria-label={t("subagentReplayBack")}
            className="rounded p-1 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
        ) : null}
        <span className="min-w-0 truncate text-xs text-[var(--text)]">{title}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error ? (
          <p className="text-xs text-[var(--danger)]">{t("subagentReplayLoadFailed")}{error}</p>
        ) : rows === null ? (
          <div className="flex items-center gap-2 text-xs text-[var(--text-dim)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("subagentReplayLoading")}
          </div>
        ) : messages.length === 0 ? (
          <p className="text-xs text-[var(--text-dim)]">{t("subagentReplayEmpty")}</p>
        ) : (
          <div className="space-y-3">
            {messages.map((m, mi) => (
              <div key={mi} className="rounded-lg border border-[var(--border)] p-2.5">
                <div
                  className={`mb-1.5 text-[10px] font-semibold uppercase tracking-wide ${
                    m.role === "user"
                      ? "text-[var(--brand)]"
                      : m.role === "toolResult"
                        ? "text-[var(--text-dim)]"
                        : "text-emerald-500"
                  }`}
                >
                  {m.role}
                </div>
                <div className="space-y-2">
                  {m.blocks.map((b, bi) => {
                    const { label, body } = blockPreview(b);
                    const isThinking = label === "thinking";
                    const isTool = label.startsWith("tool:");
                    return (
                      <details key={bi} open={!isThinking && !isTool}>
                        <summary className="cursor-pointer select-none text-[10px] font-medium text-[var(--text-dim)] hover:text-[var(--text)]">
                          {label}
                        </summary>
                        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded bg-[var(--bg-sunken)] p-2 font-mono text-[11px] leading-relaxed text-[var(--text)]">
                          {body}
                        </pre>
                      </details>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
