/**
 * 导入类型与工具（移植自 PI-Desktop apps/desktop/electron/main/importers/types.ts）。
 *
 * 确定性会话 id：重复导入同一来源会话 = 幂等 no-op（任务 id 即去重键）。
 */

export type ExternalSource = "claude-code" | "opencode" | "codex" | "pi";

export interface ExternalSessionSummary {
  source: ExternalSource;
  externalId: string;
  title: string;
  projectPath: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * 完整扫描时的精确条目数；文件过大走采样时为 null（UI 显示「—」）。
   * 仅扫描期元数据——导入后的会话始终知道真实条数。
   */
  messageCount: number | null;
  filePath: string;
}

export interface ImportedUiMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  status?: string;
  toolName?: string;
  toolCallId?: string;
  toolStatus?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  isError?: boolean;
}

export interface ImportedSession {
  session: {
    id: string;
    title: string;
    projectPath: string | null;
    modelId: string | null;
    providerId: string | null;
    mode: string;
    createdAt: string;
    updatedAt: string;
  };
  messages: ImportedUiMessage[];
}

export interface SessionImporter {
  source: ExternalSource;
  scan(): Promise<ExternalSessionSummary[]>;
  convert(summary: ExternalSessionSummary): Promise<ImportedSession>;
}

/** 确定性会话 id：重复导入同一来源会话是 no-op。 */
export function importedSessionId(source: ExternalSource, externalId: string): string {
  return `import-${source}-${externalId}`;
}

export function toIso(value: string | number | undefined | null, fallback?: string): string {
  if (value !== undefined && value !== null) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    // 提供了但非法的时间戳 = 数据损坏（截断的 jsonl / 越界数字）：告警而不是
    // 静默把会话历史改写成导入时刻；缺省值保持静默（可选字段里属正常）。
    console.warn(
      `[import] session import timestamp invalid: ${String(value)} → ${fallback ?? "import-time"}`,
    );
  }
  return fallback ?? new Date().toISOString();
}

export function truncateTitle(text: string, max = 48): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** ISO/毫秒 → epoch 毫秒；非法值回退 fallback ?? Date.now()。 */
export function toMs(value: string | number | undefined | null, fallback?: number): number {
  if (value !== undefined && value !== null) {
    const d = new Date(value).getTime();
    if (!Number.isNaN(d)) return d;
  }
  return fallback ?? Date.now();
}
