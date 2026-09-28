// LiveAgent 移植：crates/agent-ui/src/pages/mcp-hub/McpImportSourcePicker.tsx
// 适配：Base UI data-[active] → Radix data-[state=active]（lw/ui/tabs 同规则）。
import { Badge } from "../lw/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "../lw/ui/tabs";
import {
  EXTERNAL_TOOL_SOURCE_LABELS,
  ExternalToolSourceIcon,
} from "../lw/resources/ExternalToolSourceIcon";
import { useHubTranslation } from "./i18n";
import type { ExternalMcpToolScan } from "../../lib/skills/index";
import { cn } from "../lw/lib/utils";

export const LOCAL_FILE_TOOL = "local-file";

function fileScanLabel(scan: ExternalMcpToolScan, fallback: string) {
  const basename = scan.configPath.split(/[\\/]/).pop();
  return basename || fallback;
}

export function McpImportSourcePicker(props: {
  scans: ExternalMcpToolScan[];
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useHubTranslation();

  return (
    <Tabs
      value={props.value}
      onValueChange={(value) => {
        if (props.scans.some((scan) => scan.tool === value)) props.onChange(value);
      }}
      className="max-w-full shrink-0"
    >
      <TabsList aria-label={t("mcpHub.tabImport")} variant="filter">
        {props.scans.map((scan) => {
          const isLocalFile = scan.tool === LOCAL_FILE_TOOL;
          const toolLabel = isLocalFile
            ? fileScanLabel(scan, t("mcpHub.importFileTab"))
            : (EXTERNAL_TOOL_SOURCE_LABELS[scan.tool] ?? scan.tool);
          return (
            <TabsTrigger
              key={scan.tool}
              value={scan.tool}
              title={isLocalFile ? scan.configPath : undefined}
              className={cn(
                "group shrink-0 gap-1.5",
                "rounded-md border border-transparent px-2.5",
                "text-xs font-medium text-muted-foreground shadow-none",
                "hover:bg-muted/60 hover:text-foreground data-[state=active]:bg-muted data-[state=active]:text-foreground data-[state=active]:shadow-none",
              )}
            >
              <ExternalToolSourceIcon tool={scan.tool} className="size-3.5" />
              <span className="max-w-40 truncate">{toolLabel}</span>
              <Badge variant="muted" size="filter-count">
                {scan.exists ? scan.servers.length : "—"}
              </Badge>
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}
