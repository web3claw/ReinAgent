// LiveAgent 移植：crates/agent-ui/src/components/trajectory/details/tabs/UsageTab.tsx
import { useTranslation } from "../../../../i18n";
import {
  formatTrajectoryCount,
  TRAJECTORY_USAGE_FIELDS,
} from "../../../../lib/trajectory/presentation";
import { Empty, Field } from "../shared";
import type { DetailTabProps } from "../types";

export function UsageTab({ record }: DetailTabProps) {
  const { t, locale } = useTranslation();
  if (record.usage === undefined && record.cumulativeUsage === undefined) return <Empty />;
  return (
    <div>
      {TRAJECTORY_USAGE_FIELDS.map((field) => {
        const own = record.usage?.[field];
        const total = record.cumulativeUsage?.[field];
        if (own === undefined && total === undefined) return null;
        return (
          <Field
            key={field}
            label={field}
            value={`${formatTrajectoryCount(own, locale)}${
              total === undefined
                ? ""
                : ` · ${t("trajectory.metric.cumulative")} ${formatTrajectoryCount(total, locale)}`
            }`}
          />
        );
      })}
    </div>
  );
}
