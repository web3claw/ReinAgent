// LiveAgent 移植：crates/agent-ui/src/components/trajectory/details/shared.tsx
// 适配：Markdown → 本仓 MarkdownText（.md 作用域继承消息排版）；ChatFileLink → 直接传路径；
// SectionFailure / SectionBlocks 一期裁剪（无分段池）。
import type { TrajectorySourceBlock } from "../../../lib/trajectory/types";
import { MarkdownText } from "../../chat/MarkdownText";
import { useTranslation } from "../../../i18n";
import { cn } from "../../../lib/utils";

export function Field(props: { label: string; value: string }) {
  return (
    <div className="flex gap-2 border-b border-border/40 py-1 last:border-0">
      <span className="w-24 shrink-0 text-muted-foreground">{props.label}</span>
      <span className="min-w-0 flex-1 break-words">{props.value}</span>
    </div>
  );
}

export function Empty() {
  const { t } = useTranslation();
  return <p className="text-muted-foreground">{t("trajectory.details.noContent")}</p>;
}

export function TextBlock(props: { value: string | undefined; language?: string }) {
  if (props.value === undefined || props.value === "") return <Empty />;
  return (
    <pre
      data-language={props.language}
      className={cn(
        "max-h-full whitespace-pre-wrap break-words rounded bg-muted/40 p-2",
        "font-mono text-xs leading-relaxed",
      )}
    >
      {props.value}
    </pre>
  );
}

export function JsonBlock(props: { value: unknown }) {
  let serialized: string;
  try {
    serialized = JSON.stringify(props.value, null, 2);
  } catch {
    serialized = String(props.value);
  }
  return <TextBlock value={serialized} language="json" />;
}

export function MarkdownBlock(props: { value: string | undefined }) {
  if (props.value === undefined || props.value === "") return <Empty />;
  return (
    <div className="md text-xs [&_*]:text-inherit">
      <MarkdownText text={props.value} />
    </div>
  );
}

export function SourceBlocks(props: {
  blocks: readonly TrajectorySourceBlock[] | undefined;
  onOpenFileLink?: (path: string) => void;
}) {
  const { t } = useTranslation();
  if (props.blocks === undefined || props.blocks.length === 0) return <Empty />;
  return (
    <div className="space-y-3">
      {props.blocks.map((block, index) => (
        <section key={`${block.type}:${block.callId ?? index}`} className="space-y-1">
          <p className="text-tiny font-medium uppercase tracking-wide text-muted-foreground">
            {block.type}
            {block.toolName ? ` · ${block.toolName}` : ""}
            {block.callId ? ` · ${block.callId}` : ""}
          </p>
          {block.filePath && props.onOpenFileLink ? (
            <button
              type="button"
              className={cn(
                "max-w-full truncate rounded border border-border/60 px-2 py-1",
                "text-left text-xs font-medium text-primary hover:bg-muted/60",
              )}
              title={block.filePath}
              onClick={() => {
                if (block.filePath) props.onOpenFileLink?.(block.filePath);
              }}
            >
              {t("trajectory.details.openFile")} · {block.imageAlt ?? block.filePath}
            </button>
          ) : null}
          {block.imageSrc ? (
            <img
              src={block.imageSrc}
              alt={block.imageAlt ?? block.type}
              loading="lazy"
              className="max-h-72 max-w-full rounded border border-border/50 object-contain"
            />
          ) : block.type === "text" || block.type === "thinking" ? (
            <MarkdownBlock value={block.content} />
          ) : (
            <TextBlock value={block.content} />
          )}
        </section>
      ))}
    </div>
  );
}
