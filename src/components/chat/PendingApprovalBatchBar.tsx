/**
 * PendingApprovalBatchBar —— 多任务批量审批条（P2-B2）。
 *
 * ≥2 个任务同时挂起审批时显示在聊天区顶部：「{N} 个任务等待审批」+
 * 「全部允许 / 全部拒绝」（循环 pool.resolveApproval 逐任务下发）。
 * 单任务挂起不显示（走各任务自己的 ApprovalCard）。
 */

import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import {
  getPendingApprovalTaskIds,
  resolveApproval as poolResolveApproval,
  subscribePendingApprovals,
} from "../../lib/chat/conversationPool";
import { useTranslation } from "../../i18n";

export function PendingApprovalBatchBar() {
  const { t } = useTranslation();
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // 池的 getPendingApprovalTaskIds 每次 split 出新数组（引用不稳定）——
  // 这里用 signature 字符串比对后再 setState（快照稳定性由 signature 保证）。
  useEffect(() => {
    let last = "__init__";
    const sync = () => {
      const current = getPendingApprovalTaskIds().join(",");
      if (current !== last) {
        last = current;
        setIds(current ? current.split(",") : []);
      }
    };
    sync();
    return subscribePendingApprovals(sync);
  }, []);

  if (ids.length < 2) return null;

  const decideAll = (decision: "allow" | "reject") => {
    setBusy(true);
    for (const taskId of ids) {
      poolResolveApproval(taskId, decision);
    }
    setBusy(false);
  };

  return (
    <div
      data-testid="approval-batch-bar"
      className="absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-2.5 rounded-full border border-[var(--status-warn)]/50 bg-[var(--bg-elev)] px-4 py-1.5 shadow-lg"
    >
      <span className="whitespace-nowrap text-xs font-medium text-[var(--status-warn)]">
        {t("approvalBatchTitle").replace("{count}", String(ids.length))}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => decideAll("allow")}
        className="flex items-center gap-1 rounded-full bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        <Check className="h-3 w-3" />
        {t("approvalBatchAllowAll")}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => decideAll("reject")}
        className="flex items-center gap-1 rounded-full border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--text-dim)] hover:text-[var(--text)] disabled:opacity-50"
      >
        <X className="h-3 w-3" />
        {t("approvalBatchRejectAll")}
      </button>
    </div>
  );
}
