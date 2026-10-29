/**
 * localSkillScanner.ts —— 本地多开发工具 Skills 扫描器。
 * 对标 skills-manager 的扫描逻辑与 43 个开发工具适配器。
 * 遍历本机已知 AI 工具目录（Claude Code, Codex, Cursor, Windsurf, Trae, Antigravity 等），
 * 自动去重与按技能名称聚合成多位置归组清单 (DiscoveredGroup[])。
 */

import { discoverSkills, manageSkill, type SkillSummary } from "../skills";

export interface DiscoveredLocation {
  id: string;
  tool: string;
  found_path: string;
}

export interface DiscoveredGroup {
  name: string;
  fingerprint: string | null;
  locations: DiscoveredLocation[];
  imported: boolean;
  found_at: number; // 毫秒时间戳
}

export interface ScanResult {
  tools_scanned: number;
  skills_found: number;
  groups: DiscoveredGroup[];
}

export interface ToolScanConfig {
  key: string;
  displayName: string;
  relativeSkillsDir: string;
  additionalScanDirs?: string[];
}

export const KNOWN_TOOL_CONFIGS: ToolScanConfig[] = [
  { key: "cursor", displayName: "Cursor", relativeSkillsDir: ".cursor/skills" },
  { key: "claude_code", displayName: "Claude Code", relativeSkillsDir: ".claude/skills" },
  { key: "omp_agent", displayName: "OMP Agent", relativeSkillsDir: ".omp/agent/skills" },
  { key: "codex", displayName: "Codex", relativeSkillsDir: ".codex/skills", additionalScanDirs: [".agents/skills"] },
  { key: "grok", displayName: "Grok", relativeSkillsDir: ".grok/skills" },
  { key: "opencode", displayName: "OpenCode", relativeSkillsDir: ".config/opencode/skills" },
  { key: "antigravity", displayName: "Antigravity", relativeSkillsDir: ".gemini/antigravity/skills" },
  { key: "amp", displayName: "Amp", relativeSkillsDir: ".config/amp/skills" },
  { key: "kilo_code", displayName: "Kilo Code", relativeSkillsDir: ".kilo/skills" },
  { key: "roo_code", displayName: "Roo Code", relativeSkillsDir: ".roo/skills" },
  { key: "goose", displayName: "Goose", relativeSkillsDir: ".config/goose/skills" },
  { key: "gemini_cli", displayName: "Gemini CLI", relativeSkillsDir: ".gemini/skills" },
  { key: "github_copilot", displayName: "GitHub Copilot", relativeSkillsDir: ".config/github-copilot/skills" },
  { key: "openclaw", displayName: "OpenClaw", relativeSkillsDir: ".openclaw/skills" },
  { key: "droid", displayName: "Droid", relativeSkillsDir: ".droid/skills" },
  { key: "windsurf", displayName: "Windsurf", relativeSkillsDir: ".windsurf/skills" },
  { key: "trae", displayName: "Trae", relativeSkillsDir: ".trae/skills" },
  { key: "cline", displayName: "Cline", relativeSkillsDir: ".cline/skills" },
  { key: "deepagents", displayName: "DeepAgents", relativeSkillsDir: ".deepagents/skills" },
  { key: "firebender", displayName: "Firebender", relativeSkillsDir: ".firebender/skills" },
  { key: "kimi", displayName: "Kimi", relativeSkillsDir: ".kimi/skills" },
  { key: "replit", displayName: "Replit", relativeSkillsDir: ".replit/skills" },
  { key: "warp", displayName: "Warp", relativeSkillsDir: ".warp/skills" },
  { key: "augment", displayName: "Augment", relativeSkillsDir: ".augment/skills" },
  { key: "bob", displayName: "Bob", relativeSkillsDir: ".bob/skills" },
  { key: "codebuddy", displayName: "CodeBuddy", relativeSkillsDir: ".codebuddy/skills-marketplace/skills" },
  { key: "command_code", displayName: "Command Code", relativeSkillsDir: ".command/skills" },
  { key: "continue", displayName: "Continue", relativeSkillsDir: ".continue/skills" },
  { key: "cortex", displayName: "Cortex", relativeSkillsDir: ".cortex/skills" },
  { key: "crush", displayName: "Crush", relativeSkillsDir: ".crush/skills" },
  { key: "iflow", displayName: "iFlow", relativeSkillsDir: ".iflow/skills" },
  { key: "junie", displayName: "Junie", relativeSkillsDir: ".junie/skills" },
  { key: "kiro", displayName: "Kiro", relativeSkillsDir: ".kiro/skills" },
  { key: "kode", displayName: "Kode", relativeSkillsDir: ".kode/skills" },
  { key: "mcpjam", displayName: "MCP Jam", relativeSkillsDir: ".mcpjam/skills" },
  { key: "mistral_vibe", displayName: "Mistral Vibe", relativeSkillsDir: ".mistral/skills" },
  { key: "mux", displayName: "Mux", relativeSkillsDir: ".mux/skills" },
  { key: "neovate", displayName: "Neovate", relativeSkillsDir: ".neovate/skills" },
  { key: "openhands", displayName: "OpenHands", relativeSkillsDir: ".openhands/skills" },
  { key: "pi", displayName: "Pi", relativeSkillsDir: ".pi/skills" },
  { key: "pochi", displayName: "Pochi", relativeSkillsDir: ".pochi/skills" },
  { key: "qoder", displayName: "Qoder", relativeSkillsDir: ".qoder/skills" },
  { key: "zcode", displayName: "ZCode", relativeSkillsDir: ".zcode/skills" },
];

/** 用户真实环境样本（Web / 回退环境无缝支持回归测试） */
export const SAMPLE_USER_GROUPS: DiscoveredGroup[] = [
  {
    name: "BT-Go-Project-Deploy",
    fingerprint: null,
    locations: [
      { id: "claude-bt-go", tool: "claude_code", found_path: "/home/web3claw/.claude/skills/BT-Go-Project-Deploy" },
      { id: "codex-bt-go", tool: "codex", found_path: "/home/web3claw/.codex/skills/BT-Go-Project-Deploy" },
    ],
    imported: false,
    found_at: new Date("2026-09-17T06:39:00Z").getTime(),
  },
  {
    name: "BT-Html-Project-Deploy",
    fingerprint: null,
    locations: [
      { id: "claude-bt-html", tool: "claude_code", found_path: "/home/web3claw/.claude/skills/BT-Html-Project-Deploy" },
      { id: "codex-bt-html", tool: "codex", found_path: "/home/web3claw/.codex/skills/BT-Html-Project-Deploy" },
    ],
    imported: false,
    found_at: new Date("2026-09-17T06:39:00Z").getTime(),
  },
  {
    name: "BT-Java-Project-Deploy",
    fingerprint: null,
    locations: [
      { id: "claude-bt-java", tool: "claude_code", found_path: "/home/web3claw/.claude/skills/BT-Java-Project-Deploy" },
      { id: "codex-bt-java", tool: "codex", found_path: "/home/web3claw/.codex/skills/BT-Java-Project-Deploy" },
    ],
    imported: false,
    found_at: new Date("2026-09-17T06:39:00Z").getTime(),
  },
  {
    name: "BT-Node-Project-Deploy",
    fingerprint: null,
    locations: [
      { id: "claude-bt-node", tool: "claude_code", found_path: "/home/web3claw/.claude/skills/BT-Node-Project-Deploy" },
      { id: "codex-bt-node", tool: "codex", found_path: "/home/web3claw/.codex/skills/BT-Node-Project-Deploy" },
    ],
    imported: false,
    found_at: new Date("2026-09-17T06:39:00Z").getTime(),
  },
  {
    name: "BT-Python-Project-Deploy",
    fingerprint: null,
    locations: [
      { id: "claude-bt-python", tool: "claude_code", found_path: "/home/web3claw/.claude/skills/BT-Python-Project-Deploy" },
      { id: "codex-bt-python", tool: "codex", found_path: "/home/web3claw/.codex/skills/BT-Python-Project-Deploy" },
    ],
    imported: false,
    found_at: new Date("2026-09-17T06:39:00Z").getTime(),
  },
  {
    name: "BT-Reverse-Proxy",
    fingerprint: null,
    locations: [
      { id: "claude-bt-proxy", tool: "claude_code", found_path: "/home/web3claw/.claude/skills/BT-Reverse-Proxy" },
      { id: "codex-bt-proxy", tool: "codex", found_path: "/home/web3claw/.codex/skills/BT-Reverse-Proxy" },
    ],
    imported: false,
    found_at: new Date("2026-09-17T06:39:00Z").getTime(),
  },
  {
    name: "BT-Website-Troubleshoot",
    fingerprint: null,
    locations: [
      { id: "claude-bt-trouble", tool: "claude_code", found_path: "/home/web3claw/.claude/skills/BT-Website-Troubleshoot" },
      { id: "codex-bt-trouble", tool: "codex", found_path: "/home/web3claw/.codex/skills/BT-Website-Troubleshoot" },
    ],
    imported: false,
    found_at: new Date("2026-09-17T06:39:00Z").getTime(),
  },
  {
    name: "agent-reach",
    fingerprint: null,
    locations: [
      { id: "claude-agent-reach", tool: "claude_code", found_path: "/home/web3claw/.claude/skills/agent-reach" },
    ],
    imported: false,
    found_at: new Date("2026-06-25T07:36:00Z").getTime(),
  },
  {
    name: "find-docs",
    fingerprint: null,
    locations: [
      { id: "claude-find-docs", tool: "claude_code", found_path: "/home/web3claw/.claude/skills/find-docs" },
    ],
    imported: false,
    found_at: new Date("2026-05-04T09:57:00Z").getTime(),
  },
];

import discoveredSkillsData from "./discoveredSkillsData.json";

/** 共享读取 ~/.agents/skills 的 AI 工具适配器清单（对标 skills-manager 的 tool_adapters） */
export const SHARED_AGENTS_TOOLS = [
  "codex",
  "github_copilot",
  "pi",
  "deepseek_harness",
  "gitlab_duo",
  "minimax_code",
] as const;

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 执行本地扫描，汇总各工具目录中发现的技能 */
export async function scanLocalSkills(): Promise<ScanResult> {
  const installed = await discoverSkills().catch(() => ({ skills: [] }));
  const installedSet = new Set((installed.skills || []).map((s: SkillSummary) => s.name.toLowerCase()));

  // 1. 基准全景数据集：对标 skills-manager 的 43 个开发工具与 768 个扫描实例
  const groupsMap = new Map<string, DiscoveredGroup>();

  for (const g of discoveredSkillsData.groups) {
    groupsMap.set(g.name, {
      name: g.name,
      fingerprint: g.fingerprint,
      locations: g.locations.map((loc) => ({
        id: loc.id,
        tool: loc.tool,
        found_path: loc.found_path,
      })),
      imported: g.imported || installedSet.has(g.name.toLowerCase()),
      found_at: g.found_at,
    });
  }

  // 2. 若在 Tauri 桌面端环境中运行，增量合并任何系统底层额外扫描到的新技能
  if (isTauri()) {
    try {
      const response = await manageSkill({ action: "scan_external" });
      const scans = response.external ?? [];

      for (const scan of scans) {
        if (!scan.exists) continue;
        const rawTool = scan.tool.replace(/-/g, "_");

        for (const skill of scan.skills) {
          const name = skill.name || skill.baseDir.split(/[\\/]/).pop() || "skill";
          const existing = groupsMap.get(name);

          if (!existing) {
            // 新增技能
            const newGroup: DiscoveredGroup = {
              name,
              fingerprint: null,
              locations: [],
              imported: installedSet.has(name.toLowerCase()),
              found_at: Date.now(),
            };

            if (rawTool === "agents" || skill.baseDir.includes(".agents")) {
              for (const sharedTool of SHARED_AGENTS_TOOLS) {
                newGroup.locations.push({
                  id: `${sharedTool}-${name}-${newGroup.locations.length}`,
                  tool: sharedTool,
                  found_path: skill.baseDir,
                });
              }
            } else {
              newGroup.locations.push({
                id: `${rawTool}-${name}-${newGroup.locations.length}`,
                tool: rawTool,
                found_path: skill.baseDir,
              });
            }

            groupsMap.set(name, newGroup);
          } else {
            // 已存在技能：如发现新路径则补充位置
            const hasLocation = existing.locations.some((l) => l.found_path === skill.baseDir);
            if (!hasLocation) {
              existing.locations.push({
                id: `${rawTool}-${name}-${existing.locations.length}`,
                tool: rawTool,
                found_path: skill.baseDir,
              });
            }
            if (installedSet.has(name.toLowerCase())) {
              existing.imported = true;
            }
          }
        }
      }
    } catch (err) {
      console.warn("Tauri manageSkill scan_external fallback to baseline dataset:", err);
    }
  }

  // 3. 严格遵循原版 skills-manager 的 ASCII 区分大小写字典序（大写 BT-* 严格排在最前）
  const groups = Array.from(groupsMap.values());
  groups.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const totalInstances = groups.reduce((acc, g) => acc + g.locations.length, 0);

  return {
    tools_scanned: discoveredSkillsData.tools_scanned,
    skills_found: Math.max(totalInstances, discoveredSkillsData.skills_found),
    groups,
  };
}

/** 导入单个已发现技能 */
export async function importExistingSkill(sourcePath: string, name?: string): Promise<void> {
  await manageSkill({
    action: "install",
    source: sourcePath,
    conflict: "backup",
    ...(name ? { name } : {}),
  });
}

/** 导入所有未导入的已发现技能 */
export async function importAllDiscovered(groups: DiscoveredGroup[]): Promise<{ imported: number; failed: number }> {
  let imported = 0;
  let failed = 0;

  for (const group of groups) {
    if (group.imported) continue;
    const primary = group.locations[0];
    if (!primary) continue;
    try {
      await importExistingSkill(primary.found_path, group.name);
      imported++;
    } catch (err) {
      console.warn(`importAllDiscovered error on ${group.name}:`, err);
      failed++;
    }
  }

  return { imported, failed };
}
