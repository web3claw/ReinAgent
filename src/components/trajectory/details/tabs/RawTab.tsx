// LiveAgent 移植：crates/agent-ui/src/components/trajectory/details/tabs/RawTab.tsx
import { JsonBlock } from "../shared";
import type { DetailTabProps } from "../types";

export function RawTab({ record }: DetailTabProps) {
  return <JsonBlock value={record} />;
}
