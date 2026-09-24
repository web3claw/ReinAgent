/**
 * SessionStatsBar —— 会话统计行（对齐 LiveAgent 底部统计条）。
 * 一行展示：轮数 · 步数 | 上下文 % | LLM / 工具耗时 | 输入 / 输出 token · 命中率。
 * 数据来自真实 usage 与时间打点；无数据时整行隐藏。
 */
import { formatCompactTokens, formatDurationCompact } from "../../lib/chat/contextUsage";

export interface SessionStats {
  turns: number;
  steps: number;
  contextPercent: number;
  llmMs: number;
  toolMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  hitRate?: number;
}

export function SessionStatsBar({ stats }: { stats: SessionStats }) {
  const { turns, steps, contextPercent, llmMs, toolMs, inputTokens, outputTokens, hitRate } = stats;

  const segments: string[] = [
    `${turns} 轮 · ${steps} 步`,
    `上下文 ${contextPercent.toFixed(0)}%`,
    `LLM ${formatDurationCompact(llmMs)} · 工具 ${formatDurationCompact(toolMs)}`,
    `输入 ${formatCompactTokens(inputTokens)} tok · 输出 ${formatCompactTokens(outputTokens)} tok`,
  ];
  if (hitRate !== undefined) {
    segments.push(`命中 ${Math.round((hitRate) * 100)}%`);
  }

  return (
    <div
      className="flex items-center justify-center gap-3 px-6 sm:px-8 md:px-12 py-1.5 text-[13px] font-mono text-[var(--text-secondary)] overflow-hidden flex-shrink-0 select-none"
      data-testid="session-stats-bar"
    >
      {segments.map((segment, index) => (
        <span key={index} className="whitespace-nowrap truncate">
          {index > 0 ? <span className="opacity-50 mr-3">|</span> : null}
          {segment}
        </span>
      ))}
    </div>
  );
}
