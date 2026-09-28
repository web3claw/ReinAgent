/**
 * UsageChartLoadBoundary —— ZCode 原样移植（P1-7）：lazy 图表的 Suspense +
 * 局部错误边界（ScopedErrorBoundary → 我们的 UsageScopedErrorBoundary）。
 */

import { Suspense, type ReactNode } from "react";
import { useZCodeIntl } from "./usageIntl";
import { UsageEmptyState } from "./usageStatsUiParts";
import { UsageScopedErrorBoundary } from "./usageErrorBoundary";

export function UsageChartLoadBoundary({
  children,
  loadingDescription,
  resetKeys,
  scope,
}: {
  children: ReactNode;
  loadingDescription: string;
  resetKeys: readonly unknown[];
  scope: string;
}) {
  const { intl } = useZCodeIntl();

  return (
    <UsageScopedErrorBoundary scope={scope} resetKeys={resetKeys} variant="inline">
      <Suspense
        fallback={
          <UsageEmptyState
            title={intl.formatMessage({ id: "settings.usage.loadingTitle" })}
            description={loadingDescription}
          />
        }
      >
        {children}
      </Suspense>
    </UsageScopedErrorBoundary>
  );
}
