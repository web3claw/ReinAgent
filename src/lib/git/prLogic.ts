/**
 * PR 面板纯展示逻辑（node --test 直测，零依赖）：
 * 门禁/审查标签 key、合并按钮 gating、CI 分色、交给 Agent 的 prompt 组装。
 */

export interface GitPrCheck {
  name: string;
  workflow: string | null;
  state: string;
  /** pass | fail | pending | cancel | skipping | "" */
  bucket: string;
  link: string | null;
}

export interface GitPrComment {
  author: string;
  body: string;
  path: string | null;
  line: number | null;
  /** review | review-summary */
  kind: string;
  createdAt: string;
}

/** 门禁可读标签 key（i18n 前缀 pr.mergeState.） */
export function mergeStateKey(mergeStateStatus: string | null | undefined, mergeable: string | null | undefined): string {
  if ((mergeable ?? "").toUpperCase() === "CONFLICTING") return "conflicting";
  switch ((mergeStateStatus ?? "").toUpperCase()) {
    case "CLEAN": return "clean";
    case "DIRTY": return "conflicting";
    case "BLOCKED": return "blocked";
    case "BEHIND": return "behind";
    case "UNSTABLE": return "unstable";
    case "HAS_HOOKS": return "hasHooks";
    default: return "unknown";
  }
}

/** 审查结论可读标签 key（i18n 前缀 pr.review.） */
export function reviewKey(decision: string | null | undefined): string {
  switch ((decision ?? "").toUpperCase()) {
    case "APPROVED": return "approved";
    case "CHANGES_REQUESTED": return "changesRequested";
    case "REVIEW_REQUIRED": return "reviewRequired";
    default: return "pending";
  }
}

/** 合并按钮是否应禁用：门禁非 clean 或审查要求修改 */
export function mergeBlocked(mergeStateStatus: string | null | undefined, mergeable: string | null | undefined, reviewDecision: string | null | undefined): boolean {
  if (mergeStateKey(mergeStateStatus, mergeable) !== "clean") return true;
  return (reviewDecision ?? "").toUpperCase() === "CHANGES_REQUESTED";
}

/** CI 检查分色桶（图标用；绿/红沿用 diff 语义变量，warn 用既有警告变量） */
export function checkBucketClass(bucket: string): string {
  switch (bucket) {
    case "pass": return "text-[var(--diff-added)]";
    case "fail": return "text-[var(--diff-removed)]";
    case "pending": return "text-[var(--warn-text)]";
    default: return "text-[var(--text-dim)]"; // cancel / skipping / 未知
  }
}

/** 「交给 Agent 修」prompt 组装（对齐 Hetu WorkPrPanel.buildPrompt 语义） */
export function buildPrHandoffPrompt(input: {
  number: number;
  title: string;
  url: string;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  checks: GitPrCheck[];
  comments: GitPrComment[];
  logExcerpt: string | null;
}): string {
  const lines: string[] = [];
  lines.push(`请修复 PR #${input.number}「${input.title}」的待处理问题，使其可以合并：${input.url}`);
  const gate = mergeStateKey(input.mergeStateStatus, input.mergeable);
  const review = reviewKey(input.reviewDecision);
  lines.push(`当前状态：门禁=${gate}；审查=${review}；变更 +${input.additions}/-${input.deletions}（${input.changedFiles} 个文件）`);
  if (input.checks.length > 0) {
    lines.push("", "失败的 CI 检查：");
    for (const c of input.checks) lines.push(`- ${c.name}: ${c.state}${c.link ? `（${c.link}）` : ""}`);
  }
  const inline = input.comments.filter((c) => c.kind === "review");
  const summaries = input.comments.filter((c) => c.kind === "review-summary");
  if (inline.length > 0) {
    lines.push("", "行内审查意见：");
    for (const c of inline) {
      const at = c.path ? `${c.path}${c.line ? `:${c.line}` : ""}` : "";
      lines.push(`- ${at ? `[${at}] ` : ""}${c.author}：${c.body}`);
    }
  }
  if (summaries.length > 0) {
    lines.push("", "审查结论：");
    for (const c of summaries) lines.push(`- ${c.author}：${c.body}`);
  }
  if (input.logExcerpt) {
    lines.push("", "失败日志摘录：", "```", input.logExcerpt, "```");
  }
  lines.push("", "请逐项修复以上问题（跑通失败检查、回应审查意见），完成后推送新提交，不要创建新 PR。");
  return lines.join("\n");
}
