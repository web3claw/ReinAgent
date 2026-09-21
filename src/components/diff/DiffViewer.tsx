import React, { useMemo } from "react";
import { PatchDiff } from "@pierre/diffs/react";
import { useAppStore } from "../../store/useAppStore";

export interface DiffViewerProps {
  patch?: string;
  oldCode?: string;
  newCode?: string;
  filename?: string;
  className?: string;
}

export const DiffViewer: React.FC<DiffViewerProps> = ({
  patch,
  oldCode,
  newCode,
  filename = "diff",
  className = "",
}) => {
  const theme = useAppStore((s) => s.theme);

  // Generate unified patch format if oldCode and newCode are supplied without patch
  const resolvedPatch = useMemo(() => {
    if (patch) return patch;
    if (oldCode !== undefined && newCode !== undefined) {
      const oldLines = oldCode.split("\n");
      const newLines = newCode.split("\n");
      let header = `--- a/${filename}\n+++ b/${filename}\n@@ -1,${oldLines.length} +1,${newLines.length} @@\n`;
      let body = "";
      for (const line of oldLines) {
        body += `-${line}\n`;
      }
      for (const line of newLines) {
        body += `+${line}\n`;
      }
      return header + body;
    }
    return "";
  }, [patch, oldCode, newCode, filename]);

  if (!resolvedPatch) {
    return null;
  }

  return (
    <div
      className={`diff-viewer-wrapper rounded-lg overflow-hidden border border-[var(--border)] bg-[var(--bg-secondary)] my-2 text-xs font-mono ${className}`}
    >
      <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--bg-card)] border-b border-[var(--border)] text-[var(--text-secondary)] text-xs">
        <span className="font-semibold">{filename}</span>
        <span className="opacity-75 uppercase tracking-wide">Diff</span>
      </div>
      <div className="overflow-x-auto p-2">
        <PatchDiff
          patch={resolvedPatch}
          disableWorkerPool={true}
          options={{
            theme: theme === "dark" ? "dark-plus" : "light-plus",
          }}
        />
      </div>
    </div>
  );
};
