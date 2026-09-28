// LiveAgent 移植：crates/agent-ui/src/components/resources/McpTransportMeta.ts
// IconSet 图标 → lucide-react 同名（Globe2 / Terminal / Wifi）。
import { Globe2, Terminal, Wifi } from "lucide-react";

export function getMcpTransportMeta(transport: string) {
  if (transport === "http") return { label: "http", Icon: Globe2 } as const;
  if (transport === "sse") return { label: "sse", Icon: Wifi } as const;
  return { label: "stdio", Icon: Terminal } as const;
}
