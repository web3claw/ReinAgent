/**
 * PlanModeCard —— 实施计划批准卡（P2 尾巴 #8，对齐 ZCode ExitPlanMode elicitation）。
 *
 * 渲染条件：`state.pendingApproval.args.kind === "plan"`（exit_plan_mode 工具挂起）。
 * 形态：标题「实施计划」+ 计划正文（markdown 渲染）+ 允许的提示式权限清单 +
 * 「批准并开始执行」（批准后任务自动切到「变更前确认」模式）/ 拒绝（可附反馈）。
 * 批准/拒绝经 App 层透传 poolResolveApproval 的结构化值（{approved, feedback?}）；
 * 批准的模式切换在 App 的 onApprove 里先 updateTaskApprovalMode 再 resolve。
 */

import { useState } from "react";
import { ClipboardList } from "lucide-react";
import { useTranslation } from "../../i18n";
import type { PlanAllowedPrompt } from "../../lib/agent/exitPlanModeTool";
import { MarkdownText } from "./MarkdownText";

export interface PlanModeCardProps {
  plan: string;
  allowedPrompts?: PlanAllowedPrompt[];
  /** 批准（App 层：先切任务审批模式再 resolveApproval） */
  onApprove: () => void;
  /** 拒绝（可带调整反馈；工具会提示模型调整后重新提交） */
  onReject: (feedback?: string) => void;
}

export function PlanModeCard({ plan, allowedPrompts, onApprove, onReject }: PlanModeCardProps) {
  const { t } = useTranslation();
  const [feedback, setFeedback] = useState("");
  const [decided, setDecided] = useState(false);

  const submitReject = () => {
    if (decided) return;
    setDecided(true);
    onReject(feedback.trim() || undefined);
  };
  const submitApprove = () => {
    if (decided) return;
    setDecided(true);
    onApprove();
  };

  return (
    <div
      className="mb-2 w-full rounded-xl border border-[var(--capsule-border)] bg-[var(--capsule-bg)] p-4 text-sm shadow-lg"
      role="dialog"
      aria-label={t("planCardTitle")}
    >
      <div className="mb-2 flex items-center gap-2 font-medium text-[var(--text)]">
        <ClipboardList className="w-4 h-4 text-[var(--brand)]" />
        <span>{t("planCardTitle")}</span>
      </div>

      <div className="md max-h-72 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--bg-sunken)] p-3 text-[var(--text)]">
        <MarkdownText text={plan} streaming={false} />
      </div>

      {allowedPrompts && allowedPrompts.length > 0 ? (
        <div className="mt-2 text-xs text-[var(--text-dim)]">
          <div className="mb-1">{t("planCardAllowedPrompts")}</div>
          <ul className="list-disc pl-5">
            {allowedPrompts.map((p, i) => (
              <li key={i}>{p.prompt}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {decided ? (
        <div className="mt-3 text-xs text-[var(--text-dim)]">{t("planCardDecided")}</div>
      ) : (
        <>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder={t("planCardFeedbackPlaceholder")}
            rows={2}
            className="mt-3 w-full resize-none rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 text-xs text-[var(--text)] placeholder-[var(--text-dim)] focus:border-[var(--brand)] focus:outline-none"
          />
          <div className="mt-2 flex items-center justify-between">
            <button
              type="button"
              onClick={submitReject}
              className="text-xs text-[var(--text-dim)] transition-colors hover:text-[var(--danger)]"
            >
              {t("planCardReject")}
            </button>
            <button
              type="button"
              onClick={submitApprove}
              className="rounded-lg bg-[var(--brand)] px-4 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
            >
              {t("planCardApprove")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
