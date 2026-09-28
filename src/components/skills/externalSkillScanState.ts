// LiveAgent 移植：<crates/agent-ui/src/pages/skills-hub/externalSkillScanState.ts>
import type { ExternalSkillEntry, ExternalToolScan } from "../../lib/skills/index";

function stringArraysEqual(previous: string[], next: string[]) {
  return previous.length === next.length && previous.every((value, index) => value === next[index]);
}

function externalSkillsEqual(previous: ExternalSkillEntry[], next: ExternalSkillEntry[]) {
  return (
    previous.length === next.length &&
    previous.every((skill, index) => {
      const candidate = next[index];
      return (
        candidate !== undefined &&
        skill.name === candidate.name &&
        skill.description === candidate.description &&
        skill.baseDir === candidate.baseDir &&
        skill.skillFile === candidate.skillFile
      );
    })
  );
}

function externalToolScansEqual(previous: ExternalToolScan[], next: ExternalToolScan[]) {
  return (
    previous.length === next.length &&
    previous.every((scan, index) => {
      const candidate = next[index];
      return (
        candidate !== undefined &&
        scan.tool === candidate.tool &&
        scan.rootDir === candidate.rootDir &&
        scan.exists === candidate.exists &&
        externalSkillsEqual(scan.skills, candidate.skills) &&
        stringArraysEqual(scan.errors, candidate.errors)
      );
    })
  );
}

export function reconcileExternalToolScans(
  previous: ExternalToolScan[] | null,
  next: ExternalToolScan[],
) {
  return previous && externalToolScansEqual(previous, next) ? previous : next;
}
