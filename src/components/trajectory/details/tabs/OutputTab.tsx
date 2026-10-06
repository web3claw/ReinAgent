// LiveAgent 移植：crates/agent-ui/src/components/trajectory/details/tabs/OutputTab.tsx
import { TextBlock } from "../shared";
import type { DetailTabProps } from "../types";

export function OutputTab({ record }: DetailTabProps) {
  return <TextBlock value={record.outputDetail} />;
}
