// LiveAgent 移植：crates/agent-ui/src/components/trajectory/details/tabs/RenderedTab.tsx
import { Empty, MarkdownBlock, SourceBlocks } from "../shared";
import type { DetailTabProps } from "../types";

export function RenderedTab(props: DetailTabProps) {
  const { record } = props;
  const primary = record.outputDetail ?? record.inputDetail;
  const hasThinking = typeof record.thinkingDetail === "string" && record.thinkingDetail !== "";
  const blocks = record.outputBlocks ?? record.sourceBlocks;
  const supplementalBlocks =
    primary === undefined
      ? blocks
      : blocks?.filter((block) => block.type !== "text" && block.type !== "thinking");
  if (
    (primary === undefined || primary === "") &&
    !hasThinking &&
    (supplementalBlocks === undefined || supplementalBlocks.length === 0)
  ) {
    return <Empty />;
  }
  return (
    <div className="space-y-4">
      {hasThinking && (
        <section className="space-y-1 rounded border border-border/50 bg-muted/20 p-2">
          <p className="text-tiny font-medium uppercase tracking-wide text-muted-foreground">
            thinking
          </p>
          <MarkdownBlock value={record.thinkingDetail} />
        </section>
      )}
      {primary !== undefined && <MarkdownBlock value={primary} />}
      {supplementalBlocks !== undefined && supplementalBlocks.length > 0 && (
        <SourceBlocks blocks={supplementalBlocks} onOpenFileLink={props.onOpenFileLink} />
      )}
    </div>
  );
}
