/**
 * ✨AI 生成提交信息（对齐 ZCode generateCommitMessage 的输入构成：变更文件 + diff；
 * 其会话上下文/当前任务文件过滤不搬——首版用 分支名+diff）。模型调用复用
 * promptEnhancement 的 one-shot 通道（buildModel+streamSimple），60s 硬超时同款。
 */

import { completeOneShotText, PROMPT_ENHANCEMENT_TIMEOUT_MS } from "../promptEnhancement/enhance";
import type { ProviderConfig } from "../providers/modelFactory";

/** diff 输入上限（字符）：防止大 diff 撑爆上下文；超长只取头部并注明截断。 */
const DIFF_INPUT_LIMIT = 24_000;
/** 提交信息长度上限（字符）：提交信息不需要长文。 */
const MESSAGE_OUTPUT_LIMIT = 600;

const SYSTEM_PROMPT = `You write git commit messages. Output rules:
- Reply with the commit message ONLY — no explanations, no quotes, no markdown fences.
- First line: a concise subject in Conventional Commits style (type(scope): summary), imperative mood, max 72 characters.
- If the changes need more context, add one blank line then a short body (bullet lines, max 5 lines). Otherwise output the subject line only.
- Write the message in the same language as the diff content or branch name; prefer English when mixed.`;

export function buildCommitMessageUserPrompt(options: {
  branchName: string | null;
  diffText: string;
}): string {
  const truncated =
    options.diffText.length > DIFF_INPUT_LIMIT
      ? `${options.diffText.slice(0, DIFF_INPUT_LIMIT)}\n...(diff truncated)`
      : options.diffText;
  const branchLine = options.branchName
    ? `Branch: ${options.branchName}\n`
    : "";
  return `${branchLine}Diff of the changes to commit:\n\n${truncated || "(no textual diff — binary or whitespace-only changes)"}`;
}

/** 清洗模型输出：剥 markdown 围栏/引号包裹，压掉多余空行，限长。 */
export function cleanCommitMessage(raw: string): string {
  let text = raw.trim();
  const fence = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fence) {
    text = fence[1].trim();
  }
  text = text.replace(/^["'「『]+/, "").replace(/["'」』]+$/, "");
  text = text
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line, index, arr) => line.trim().length > 0 || (index > 0 && arr[index - 1].trim().length > 0))
    .join("\n")
    .trim();
  if (text.length > MESSAGE_OUTPUT_LIMIT) {
    text = `${text.slice(0, MESSAGE_OUTPUT_LIMIT).trimEnd()}…`;
  }
  return text;
}

export interface GenerateCommitMessageOptions {
  config: ProviderConfig;
  branchName: string | null;
  diffText: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  signal?: AbortSignal;
}

/** 生成提交信息；失败如实抛错（No-Fallback），超时复用提示词增强的 60s 上限语义。 */
export async function generateCommitMessage(options: GenerateCommitMessageOptions): Promise<string> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), PROMPT_ENHANCEMENT_TIMEOUT_MS);
  const merged = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  try {
    const raw = await completeOneShotText(
      options.config,
      SYSTEM_PROMPT,
      buildCommitMessageUserPrompt({ branchName: options.branchName, diffText: options.diffText }),
      options.thinkingLevel ?? "off",
      merged,
    );
    const cleaned = cleanCommitMessage(raw);
    if (!cleaned) {
      throw new Error("模型返回了空结果");
    }
    return cleaned;
  } finally {
    window.clearTimeout(timer);
  }
}
