/**
 * MCP / 技能的外部工具扫描与导入：复用本方已有的扫描通道（Rust
 * mcp_scan_external / skills scan_external），写入走各自的标准入口
 * （updateMcpOps upsert / manageSkill install），与两个 hub 页同一套真相源。
 */

import { scanExternalMcpServers, scanExternalSkills, manageSkill, type ExternalMcpToolScan, type ExternalSkillEntry, type ExternalToolScan, type ExternalMcpServerEntry } from "../skills";
import { useHubSettings } from "../../store/hubSettingsStore";
import type { McpServerConfig } from "../hub/mcpTypes";

// ---------- MCP ----------

export interface McpImportCandidate {
  tool: string;
  origin: string;
  entry: ExternalMcpServerEntry;
}

export async function scanMcpCandidates(): Promise<McpImportCandidate[]> {
  const scans: ExternalMcpToolScan[] = await scanExternalMcpServers();
  const out: McpImportCandidate[] = [];
  for (const scan of scans) {
    if (!scan.exists) continue;
    for (const entry of scan.servers) {
      out.push({ tool: scan.tool, origin: entry.origin, entry });
    }
  }
  return out;
}

function toMcpServerConfig(candidate: McpImportCandidate, existingIds: Set<string>): McpServerConfig {
  const baseId = candidate.entry.id || `imported-${candidate.tool}`;
  // 与本方现有 id 冲突时加来源后缀，避免静默覆盖用户已有同名服务
  const id = existingIds.has(baseId) ? `${baseId}-${candidate.tool}` : baseId;
  return {
    id,
    description: candidate.origin && candidate.origin !== "user" ? `${candidate.tool} · ${candidate.origin}` : candidate.tool,
    enabled: true,
    transport: candidate.entry.transport,
    command: candidate.entry.command ?? "",
    args: candidate.entry.args ?? [],
    url: candidate.entry.url ?? "",
    env: candidate.entry.env ?? {},
    headers: candidate.entry.headers ?? {},
    cwd: candidate.entry.cwd ?? undefined,
    timeoutMs: candidate.entry.timeoutMs ?? 60_000,
  };
}

export async function runMcpImport(candidates: McpImportCandidate[]): Promise<{ imported: string[]; skipped: string[]; failed: Array<{ id: string; reason: string }> }> {
  const existing = useHubSettings.getState().settings.mcp.servers;
  const existingIds = new Set(existing.map((s) => s.id));
  const imported: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ id: string; reason: string }> = [];
  const ops: Array<{ kind: "upsert"; server: McpServerConfig }> = [];
  for (const candidate of candidates) {
    const server = toMcpServerConfig(candidate, existingIds);
    existingIds.add(server.id);
    ops.push({ kind: "upsert", server });
  }
  try {
    useHubSettings.getState().updateMcpOps(ops);
    for (const op of ops) imported.push(op.server.id);
  } catch (err) {
    for (const op of ops) failed.push({ id: op.server.id, reason: String(err) });
  }
  return { imported, skipped, failed };
}

// ---------- 技能 ----------

export interface SkillImportCandidate {
  tool: string;
  rootDir: string;
  entry: ExternalSkillEntry;
}

export async function scanSkillCandidates(): Promise<SkillImportCandidate[]> {
  const scans: ExternalToolScan[] = await scanExternalSkills();
  const out: SkillImportCandidate[] = [];
  for (const scan of scans) {
    if (!scan.exists) continue;
    for (const entry of scan.skills) {
      out.push({ tool: scan.tool, rootDir: scan.rootDir, entry });
    }
  }
  return out;
}

/**
 * 技能导入 = 复制安装（v1 不做 symlink：Windows 符号链接需要管理员/开发者模式）。
 * 同名已存在按 backup 冲突策略由 manageSkill 处理；失败逐项归类。
 */
export async function runSkillImport(candidates: SkillImportCandidate[]): Promise<{ imported: string[]; skipped: string[]; failed: Array<{ id: string; reason: string }> }> {
  const imported: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ id: string; reason: string }> = [];
  for (const candidate of candidates) {
    const name = candidate.entry.name || candidate.entry.baseDir.split(/[\\/]/).pop() || "skill";
    try {
      await manageSkill({ action: "install", source: candidate.entry.baseDir, conflict: "backup" });
      imported.push(name);
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      if (/already exists|已存在/i.test(message)) {
        skipped.push(name);
      } else {
        failed.push({ id: name, reason: message.slice(0, 200) });
      }
    }
  }
  return { imported, skipped, failed };
}
