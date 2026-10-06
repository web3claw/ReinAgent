// LiveAgent 移植：crates/agent-ui/src/components/trajectory/details/tabs/InputTab.tsx
import { TextBlock } from "../shared";
import type { DetailTabProps } from "../types";

export function InputTab({ record }: DetailTabProps) {
  return <TextBlock value={record.inputDetail} />;
}
