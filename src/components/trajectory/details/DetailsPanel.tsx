// LiveAgent 移植：crates/agent-ui/src/components/trajectory/details/DetailsPanel.tsx
// 适配：一期无 header/分段池——去掉 SECTION_TABS / loadSections / SystemPrompt/Tools/Diff/Schema
// 四个 tab；tab 条改为普通按钮（不引 LA 的 ui/tabs）；useLocale → useTranslation。
import { type ComponentType, type CSSProperties, type RefObject, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "../../../i18n";
import { cn } from "../../../lib/utils";
import { trajectoryKindLabelKey } from "../../../lib/trajectory/presentation";
import type { TrajectoryRecord } from "../../../lib/trajectory/types";
import { DetailsResizeHandle } from "./DetailsResizeHandle";
import { InputTab } from "./tabs/InputTab";
import { OptionsTab } from "./tabs/OptionsTab";
import { OutputTab } from "./tabs/OutputTab";
import { OverviewTab } from "./tabs/OverviewTab";
import { RawTab } from "./tabs/RawTab";
import { RenderedTab } from "./tabs/RenderedTab";
import { SourceTab } from "./tabs/SourceTab";
import { TimingTab } from "./tabs/TimingTab";
import { UsageTab } from "./tabs/UsageTab";
import type { DetailTabId, DetailTabProps } from "./types";

function tabsFor(record: TrajectoryRecord): readonly DetailTabId[] {
  switch (record.kind) {
    case "message":
      return ["overview", "rendered", "raw", "source", "output", "options", "usage", "timing"];
    case "tool":
    case "subtool":
      return ["overview", "rendered", "raw", "source", "input", "output", "options", "timing"];
    case "compacted":
      return ["overview", "raw", "timing"];
    default:
      return ["rendered", "raw", "source", "input"];
  }
}

const TAB_COMPONENTS: Record<DetailTabId, ComponentType<DetailTabProps>> = {
  overview: OverviewTab,
  rendered: RenderedTab,
  raw: RawTab,
  source: SourceTab,
  input: InputTab,
  output: OutputTab,
  options: OptionsTab,
  usage: UsageTab,
  timing: TimingTab,
};

export function DetailsPanel(props: {
  record: TrajectoryRecord | null;
  onOpenFileLink?: (path: string) => void;
  onClose: () => void;
  containerRef: RefObject<HTMLDivElement | null>;
  width: number;
  onWidthChange: (width: number) => void;
}) {
  const { t } = useTranslation();
  const tf = t as unknown as (key: string) => string;
  const { record } = props;
  const tabs = useMemo(() => (record === null ? [] : tabsFor(record)), [record]);
  const [activeTab, setActiveTab] = useState<DetailTabId | null>(null);
  const currentTab = activeTab !== null && tabs.includes(activeTab) ? activeTab : (tabs[0] ?? null);

  const selectedRecordId = record?.recordId;
  useEffect(() => {
    // 选中另一条记录时必须重置 tab（即使两条记录暴露同一组 tab）。
    setActiveTab(null);
  }, [selectedRecordId]);

  if (record === null) {
    // 窄容器为上下排布：空态占位直接隐藏，把整块高度让给列表。
    return (
      <aside
        className={cn(
          "relative flex min-w-160px max-w-trajectory-details w-[var(--trajectory-details-width)] shrink-0 items-center justify-center",
          "border-l border-border/60 p-6",
          "text-center text-xs text-muted-foreground @max-[520px]:p-3 @max-[640px]:hidden",
        )}
        style={{ "--trajectory-details-width": `${props.width}px` } as CSSProperties}
      >
        <DetailsResizeHandle
          containerRef={props.containerRef}
          width={props.width}
          onWidthChange={props.onWidthChange}
        />
        {t("trajectory.details.empty")}
      </aside>
    );
  }

  const ActiveTab = currentTab === null ? null : TAB_COMPONENTS[currentTab];
  const tabProps: DetailTabProps = {
    record,
    onOpenFileLink: props.onOpenFileLink,
  };

  return (
    <aside
      className={cn(
        "relative flex min-w-160px max-w-trajectory-details w-[var(--trajectory-details-width)] shrink-0 flex-col",
        "border-l border-border/60 bg-background",
        "@max-[640px]:h-[55%] @max-[640px]:w-full @max-[640px]:min-w-0 @max-[640px]:max-w-none @max-[640px]:border-l-0 @max-[640px]:border-t",
      )}
      style={{ "--trajectory-details-width": `${props.width}px` } as CSSProperties}
    >
      <DetailsResizeHandle
        containerRef={props.containerRef}
        width={props.width}
        onWidthChange={props.onWidthChange}
      />
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="truncate text-xs font-medium">
          {tf(trajectoryKindLabelKey(record.kind))}
          <span className="ml-2 font-normal text-muted-foreground">#{record.index}</span>
        </span>
        <button
          type="button"
          aria-label={t("trajectory.details.close")}
          onClick={props.onClose}
          className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </header>

      <div
        role="tablist"
        className={cn(
          "relative flex shrink-0 flex-wrap gap-1 border-b border-border/60 px-2 py-1",
          "@max-[520px]:flex-nowrap @max-[520px]:overflow-x-auto",
        )}
      >
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={currentTab === tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "shrink-0 rounded px-2 py-0.5 text-xs transition-colors",
              currentTab === tab
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tf(`trajectory.details.tab.${tab}`)}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-xs @max-[520px]:p-2.5">
        {ActiveTab === null ? null : <ActiveTab {...tabProps} />}
      </div>
    </aside>
  );
}
