// LiveAgent 移植：crates/agent-ui/src/components/trajectory/details/tabs/SourceTab.tsx
import { Empty, SourceBlocks } from "../shared";
import type { DetailTabProps } from "../types";

export function SourceTab(props: DetailTabProps) {
  const { record } = props;
  if (
    (record.sourceBlocks === undefined || record.sourceBlocks.length === 0) &&
    (record.outputBlocks === undefined || record.outputBlocks.length === 0)
  ) {
    return <Empty />;
  }
  return (
    <div className="space-y-4">
      {record.sourceBlocks !== undefined && (
        <SourceBlocks blocks={record.sourceBlocks} onOpenFileLink={props.onOpenFileLink} />
      )}
      {record.outputBlocks !== undefined && (
        <SourceBlocks blocks={record.outputBlocks} onOpenFileLink={props.onOpenFileLink} />
      )}
    </div>
  );
}
