/**
 * UsageStatsErrorNotice —— ZCode 简化移植（P1-7）。
 *
 * ZCode 版含凭据错误/团队套餐业务错误分类（远端 monitor 场景）；
 * 我们的 App Usage 全部走本地 SQLite，只保留内联错误条形态。
 */

import { AlertTriangle } from "lucide-react";

export function UsageStatsErrorNotice({ error }: { error: string }) {
  return (
    <div className="flex w-fit min-w-0 items-center gap-1.5 text-ui-base">
      <AlertTriangle className="size-3 shrink-0 text-[var(--danger)]" />
      <span className="min-w-0 truncate whitespace-nowrap text-[var(--danger)]">{error}</span>
    </div>
  );
}
