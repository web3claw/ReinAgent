// LiveAgent 移植：<crates/agent-ui/src/pages/skills-hub/SkillsImportSourceTabs.tsx>
// 适配：Radix Tabs 状态属性 data-[active]: → data-[state=active]:。
import { EXTERNAL_TOOL_SOURCE_LABELS, ExternalToolSourceIcon } from "../lw/resources/ExternalToolSourceIcon";
import { Badge } from "../lw/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "../lw/ui/tabs";
import { cn } from "../lw/lib/utils";
import type { ExternalToolScan } from "../../lib/skills/index";

const EXTERNAL_TOOL_OPTIONS = [
  { tool: "claude-code", label: EXTERNAL_TOOL_SOURCE_LABELS["claude-code"] },
  { tool: "codex", label: EXTERNAL_TOOL_SOURCE_LABELS.codex },
  { tool: "codebuddy", label: EXTERNAL_TOOL_SOURCE_LABELS.codebuddy },
  { tool: "agents", label: EXTERNAL_TOOL_SOURCE_LABELS.agents },
] as const;

const EXTERNAL_TOOL_IDS: ReadonlySet<string> = new Set(
  EXTERNAL_TOOL_OPTIONS.map((option) => option.tool),
);

export function SkillsImportSourceTabs(props: {
  scans: ExternalToolScan[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const orderedSources = [
    ...EXTERNAL_TOOL_OPTIONS.map((option) => ({
      ...option,
      scan: props.scans.find((scan) => scan.tool === option.tool),
    })),
    ...props.scans
      .filter((scan) => !EXTERNAL_TOOL_IDS.has(scan.tool))
      .map((scan) => ({ tool: scan.tool, label: scan.tool, scan })),
  ];

  return (
    <Tabs
      value={props.value}
      onValueChange={(value) => {
        if (props.scans.some((scan) => scan.tool === value)) props.onChange(String(value));
      }}
      className="min-w-0 flex-1"
    >
      <TabsList variant="filter">
        {orderedSources.map(({ tool, label, scan }) => (
          <TabsTrigger
            key={tool}
            value={tool}
            disabled={props.disabled || !scan}
            aria-label={`${label}: ${scan?.exists ? scan.skills.length : 0}`}
            className={cn(
              "group shrink-0 gap-1",
              "rounded-md border border-transparent px-2",
              "text-xs font-medium text-muted-foreground shadow-none",
              "hover:bg-muted/60 hover:text-foreground data-[state=active]:bg-muted data-[state=active]:text-foreground data-[state=active]:shadow-none disabled:opacity-60",
            )}
          >
            <ExternalToolSourceIcon tool={tool} className="size-3.5" />
            <span>{label}</span>
            <Badge variant="muted" size="filter-count">
              {scan ? (scan.exists ? scan.skills.length : "—") : "…"}
            </Badge>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
