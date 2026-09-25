/**
 * ApprovalCard —— 审批卡（对齐 ZCode PermissionDialog 的挂起审批交互）。
 *
 * - 数据源：ChatState.pendingApproval（工具执行前审批门挂起时写入）；
 * - 三个决策：允许（放行本次）/ 总是允许（本任务内该工具后续免审）/ 拒绝（block 工具调用）；
 * - 纯展示组件：决策经 onDecide 回调上抛（App → pool.resolveApproval）。
 */
import type { PendingApproval } from "../../lib/chat/conversationModel";
import type { ApprovalDecision } from "../../lib/providers/runAgentTurn";
import { toolKindLabel } from "../../lib/chat/turnActivity";
import { useTranslation } from "../../i18n";
import { Hand, ShieldCheck, X } from "lucide-react";

/** 审批卡参数摘要：命令工具展示命令行，写工具展示路径。 */
function summarizeArgs(args: unknown): string {
  if (args === null || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  const command = typeof record.command === "string" ? record.command : "";
  const path = typeof record.path === "string" ? record.path : "";
  const summary = command || path;
  return summary.length > 120 ? `${summary.slice(0, 120)}…` : summary;
}

export function ApprovalCard({
  request,
  onDecide,
}: {
  request: PendingApproval;
  onDecide: (decision: ApprovalDecision) => void;
}) {
  const { t, locale } = useTranslation();
  const title = toolKindLabel(request.toolName, locale);
  const summary = summarizeArgs(request.args);

  return (
    <div
      data-approval-card
      className="mx-4 mb-2 rounded-xl border border-[var(--status-warn)] bg-[var(--capsule-bg)] shadow-lg px-4 py-3"
    >
      <div className="flex items-center gap-2">
        <Hand className="w-4 h-4 shrink-0 text-[var(--status-warn)]" />
        <span className="text-[13px] font-medium text-[var(--text)]">{title}</span>
        <span className="text-[11px] px-1.5 py-0.5 rounded border border-[var(--status-warn)]/40 text-[var(--status-warn)] font-medium">
          {t("approvalRequiredBadge")}
        </span>
      </div>
      {summary && (
        <div className="mt-1.5 ml-6 text-[12px] font-mono text-[var(--text-secondary)] break-all">
          {summary}
        </div>
      )}
      <div className="mt-3 ml-6 flex items-center gap-2">
        <button
          type="button"
          data-approval-allow
          onClick={() => onDecide("allow")}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--accent)] text-white hover:opacity-90 transition-opacity cursor-pointer"
        >
          <ShieldCheck className="w-3.5 h-3.5" />
          {t("approvalAllow")}
        </button>
        <button
          type="button"
          data-approval-allow-always
          onClick={() => onDecide("always")}
          className="px-3 py-1.5 rounded-lg text-xs border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer"
        >
          {t("approvalAllowAlways")}
        </button>
        <button
          type="button"
          data-approval-reject
          onClick={() => onDecide("reject")}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
          {t("approvalReject")}
        </button>
      </div>
    </div>
  );
}
