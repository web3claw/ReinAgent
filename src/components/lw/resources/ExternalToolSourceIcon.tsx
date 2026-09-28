// LiveAgent 移植：crates/agent-ui/src/components/resources/ExternalToolSourceIcon.tsx
// 品牌 SVG：Claude/OpenAI/Grok/Deepseek 由 lw/icons/logos-icons 内联原样带来，
// Skill 内联 SVG 在 lw/icons/brand-icons（LA IconSet 原样）。
import type { ComponentType } from "react";
import { Bot, FileText, Folder } from "lucide-react";

import { ClaudeIcon, OpenaiChatgptIcon } from "../icons/logos-icons";
import { SkillIcon } from "../icons/brand-icons";

export const EXTERNAL_TOOL_SOURCE_LABELS: Readonly<Record<string, string>> = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  codex: "Codex",
  codebuddy: "CodeBuddy",
  agents: "Agent Skills",
};

const EXTERNAL_TOOL_SOURCE_ICONS: Readonly<Record<string, ComponentType<{ className?: string }>>> = {
  "claude-code": ClaudeIcon,
  "claude-desktop": ClaudeIcon,
  codex: OpenaiChatgptIcon,
  codebuddy: Bot,
  agents: SkillIcon,
  "local-file": FileText,
};

export function ExternalToolSourceIcon(props: { tool: string; className?: string }) {
  const SourceIcon = EXTERNAL_TOOL_SOURCE_ICONS[props.tool] ?? Folder;
  return <SourceIcon className={props.className} />;
}
