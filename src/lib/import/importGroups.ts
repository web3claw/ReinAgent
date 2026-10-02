/**
 * 会话候选分组（移植自 PI-Desktop apps/desktop/src/lib/import-groups.ts）。
 */

import type { ExternalSessionSummary, ExternalSource } from "./types.ts";

export type ImportGroupLabels = {
  noProject: string;
  sources: Record<ExternalSource, string>;
};

export type ImportGroupBy = "path" | "source";

export const DEFAULT_IMPORT_GROUP_BY: ImportGroupBy = "source";

export type ImportGroup = {
  id: string;
  name: string;
  projectPath: string | null;
  items: ExternalSessionSummary[];
  latest: string;
};

export function projectNameOf(projectPath: string | null): string {
  if (!projectPath) return "";
  const parts = projectPath.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || projectPath;
}

export function groupImportCandidates(
  candidates: ExternalSessionSummary[],
  groupBy: ImportGroupBy,
  labels: ImportGroupLabels,
): ImportGroup[] {
  const grouped = new Map<string, ExternalSessionSummary[]>();

  for (const candidate of candidates) {
    const key = groupBy === "path" ? candidate.projectPath ?? "" : candidate.source;
    const items = grouped.get(key) ?? [];
    items.push(candidate);
    grouped.set(key, items);
  }

  return [...grouped.entries()]
    .map(([key, items]) => {
      const projectPath = groupBy === "path" && key ? key : null;
      return {
        id: `${groupBy}:${key || "(none)"}`,
        name:
          groupBy === "path"
            ? projectNameOf(projectPath) || labels.noProject
            : labels.sources[key as ExternalSource],
        projectPath,
        items: [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        latest: items.reduce((latest, candidate) => (candidate.updatedAt > latest ? candidate.updatedAt : latest), ""),
      };
    })
    .sort((a, b) => {
      if (groupBy === "path" && Boolean(a.projectPath) !== Boolean(b.projectPath)) {
        return a.projectPath ? -1 : 1;
      }
      return b.latest.localeCompare(a.latest) || a.name.localeCompare(b.name);
    });
}

export function formatImportDate(updatedAt: string, locale?: string): string {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return updatedAt;
  return new Intl.DateTimeFormat(locale || undefined, { dateStyle: "medium" }).format(date);
}
