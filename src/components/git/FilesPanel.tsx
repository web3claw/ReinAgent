/**
 * FilesPanel —— 工作区文件树（P2-D1，懒加载）。
 *
 * - 根 = 当前任务工作区；目录点击展开/收起（逐层请求 fs_tree_dir）；
 * - 文件点击 → onOpenFile（App 层接 openCodeViewer 打开预览）；
 * - .ReinAgent / node_modules / .git 默认折叠（点击仍可展开）。
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileText, Folder, FolderOpen } from "lucide-react";

interface TreeEntry {
  name: string;
  isDir: boolean;
  size: number;
}

interface TreeNode {
  /** 相对根的路径（POSIX 分隔），根为 ""。 */
  relPath: string;
  name: string;
  isDir: boolean;
  /** 目录：子节点懒加载后填充。 */
  children?: TreeNode[];
  size: number;
}

const COLLAPSED_PREFIXES = ["node_modules", ".git", ".ReinAgent"];

async function listDir(path: string): Promise<TreeEntry[]> {
  const res = await invoke<{ path: string; entries: TreeEntry[] }>("fs_tree_dir", { path });
  return res.entries;
}

export function FilesPanel({
  workspacePath,
  onOpenFile,
}: {
  workspacePath?: string;
  onOpenFile: (relPath: string) => void;
}) {
  const [root, setRoot] = useState<TreeNode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadRoot = useCallback(async () => {
    if (!workspacePath) return;
    setError(null);
    try {
      const entries = await listDir(workspacePath);
      setRoot({
        relPath: "",
        name: "",
        isDir: true,
        size: 0,
        children: entries.map((e) => ({
          relPath: e.name,
          name: e.name,
          isDir: e.isDir,
          size: e.size,
        })),
      });
    } catch (err) {
      setError(String(err));
    }
  }, [workspacePath]);

  useEffect(() => {
    void loadRoot();
  }, [loadRoot]);

  if (!workspacePath) {
    return <p className="p-4 text-sm text-[var(--text-dim)]">无工作区</p>;
  }
  if (error) {
    return <p className="p-4 text-xs text-[var(--danger)]">{error}</p>;
  }
  if (!root?.children) {
    return <p className="p-4 text-sm text-[var(--text-dim)]">加载中…</p>;
  }

  return (
    <div className="p-2 text-sm">
      <div className="mb-1 px-2 font-mono text-[10px] text-[var(--text-dim)]">{workspacePath}</div>
      <TreeLevel
        level={0}
        nodes={root.children}
        workspacePath={workspacePath}
        onOpenFile={onOpenFile}
      />
    </div>
  );
}

function TreeLevel({
  level,
  nodes,
  workspacePath,
  onOpenFile,
}: {
  level: number;
  nodes: TreeNode[];
  workspacePath: string;
  onOpenFile: (relPath: string) => void;
}) {
  return (
    <div className="flex flex-col">
      {nodes.map((node) => (
        <TreeRow
          key={node.relPath}
          node={node}
          level={level}
          workspacePath={workspacePath}
          onOpenFile={onOpenFile}
        />
      ))}
    </div>
  );
}

function TreeRow({
  node,
  level,
  workspacePath,
  onOpenFile,
}: {
  node: TreeNode;
  level: number;
  workspacePath: string;
  onOpenFile: (relPath: string) => void;
}) {
  const [expanded, setExpanded] = useState(level === 0 && !COLLAPSED_PREFIXES.some((p) => node.name === p));
  const [children, setChildren] = useState<TreeNode[] | null>(node.children ?? null);
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    if (!node.isDir) {
      onOpenFile(node.relPath);
      return;
    }
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (children === null) {
      setLoading(true);
      try {
        const abs = node.relPath ? `${workspacePath}/${node.relPath}` : workspacePath;
        const entries = await listDir(abs);
        setChildren(
          entries.map((e) => ({
            relPath: node.relPath ? `${node.relPath}/${e.name}` : e.name,
            name: e.name,
            isDir: e.isDir,
            size: e.size,
          })),
        );
      } finally {
        setLoading(false);
      }
    }
    setExpanded(true);
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => void toggle()}
        className="flex min-w-0 w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs text-[var(--text)] hover:bg-[var(--surface-hover)]"
        style={{ paddingLeft: level * 12 + 4 }}
      >
        {node.isDir ? (
          expanded ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          )
        ) : (
          <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--text-dim)]" />
        )}
        <span className="min-w-0 truncate">{node.name}</span>
        {loading ? <span className="text-[10px] text-[var(--text-dim)]">…</span> : null}
      </button>
      {node.isDir && expanded && children ? (
        <TreeLevel
          level={level + 1}
          nodes={children}
          workspacePath={workspacePath}
          onOpenFile={onOpenFile}
        />
      ) : null}
      {node.isDir && expanded && children?.length === 0 ? (
        <div style={{ paddingLeft: (level + 1) * 12 + 4 }} className="text-[10px] text-[var(--text-dim)]">
          （空）
        </div>
      ) : null}
    </div>
  );
}
