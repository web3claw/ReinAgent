/**
 * FilesPanel —— 工作区文件树（P2-D1 懒加载 + 文件管理器操作批 2026-10-01）。
 *
 * - 根 = 当前任务工作区；目录点击展开/收起（逐层请求 fs_tree_dir）；
 * - 文件点击 → onOpenFile（App 层接 openCodeViewer 打开预览）；
 * - .ReinAgent / node_modules / .git 默认折叠（点击仍可展开）。
 * - 管理操作（行 hover）：目录行 = 新建文件/文件夹/重命名/删除；文件行 = 重命名/删除；
 *   顶部工具条 = 根级新建 + 刷新 + 在资源管理器中显示。删除走 ConfirmActionPopover；
 *   重命名/新建为行内输入； rename 删除均拒绝符号链接（Rust 侧安防）。
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FilePlus,
  Pencil,
  Trash2,
  RefreshCw,
  FolderSearch,
  Check,
  X,
} from "lucide-react";
import { ConfirmActionPopover } from "../lw/ui/confirm-action-popover";
import { toast } from "../lw/ui/toast";

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

type InlineMode =
  | { kind: "none" }
  | { kind: "create"; parentRel: string; isDir: boolean }
  | { kind: "rename"; targetRel: string; isDir: boolean };

export function FilesPanel({
  workspacePath,
  onOpenFile,
}: {
  workspacePath?: string;
  onOpenFile: (relPath: string) => void;
}) {
  const [root, setRoot] = useState<TreeNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inline, setInline] = useState<InlineMode>({ kind: "none" });
  const [reloadTick, setReloadTick] = useState(0);
  /** 子树刷新广播：行 key 加 tick，展开目录在 tick 变化后重拉 */
  const bumpReload = useCallback(() => setReloadTick((t) => t + 1), []);

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
  }, [loadRoot, reloadTick]);

  const joinPath = (parentRel: string, name: string) =>
    parentRel ? `${workspacePath}/${parentRel}/${name}` : `${workspacePath}/${name}`;

  const createEntry = async (parentRel: string, name: string, isDir: boolean) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      if (isDir) {
        await invoke("fs_create_dir", { path: joinPath(parentRel, trimmed) });
      } else {
        await invoke("fs_write_file", { path: joinPath(parentRel, trimmed), content: "" });
      }
      toast.success(`已创建 ${parentRel ? `${parentRel}/` : ""}${trimmed}`);
      setInline({ kind: "none" });
      bumpReload();
    } catch (err) {
      toast.error(String(err).slice(0, 200));
    }
  };

  const renameEntry = async (targetRel: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === targetRel.split("/").pop()) {
      setInline({ kind: "none" });
      return;
    }
    const parentRel = targetRel.includes("/") ? targetRel.slice(0, targetRel.lastIndexOf("/")) : "";
    try {
      await invoke("fs_rename", {
        path: joinPath(parentRel, targetRel.split("/").pop() ?? targetRel),
        new_path: joinPath(parentRel, trimmed),
      });
      toast.success(`已重命名为 ${trimmed}`);
      setInline({ kind: "none" });
      bumpReload();
    } catch (err) {
      toast.error(String(err).slice(0, 200));
    }
  };

  const deleteEntry = async (relPath: string, isDir: boolean) => {
    try {
      await invoke("fs_remove_entry", {
        path: `${workspacePath}/${relPath}`,
        workspaceRoot: workspacePath,
      });
      toast.success(`已删除 ${relPath}${isDir ? "（含内容）" : ""}`);
      bumpReload();
    } catch (err) {
      toast.error(String(err).slice(0, 200));
    }
  };

  const revealEntry = (relPath: string) => {
    void (async () => {
      try {
        { /* revealItemInDir 静态引入 */ }
        await revealItemInDir(relPath ? `${workspacePath}/${relPath}` : workspacePath!);
      } catch (err) {
        toast.error(String(err).slice(0, 200));
      }
    })();
  };

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
      <div className="mb-1 flex items-center justify-between px-2">
        <span className="truncate font-mono text-[10px] text-[var(--text-dim)]">{workspacePath}</span>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            title="新建文件"
            aria-label="新建文件"
            onClick={() => setInline({ kind: "create", parentRel: "", isDir: false })}
            className="rounded p-1 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          >
            <FilePlus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="新建文件夹"
            aria-label="新建文件夹"
            onClick={() => setInline({ kind: "create", parentRel: "", isDir: true })}
            className="rounded p-1 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="刷新"
            aria-label="刷新文件树"
            onClick={bumpReload}
            className="rounded p-1 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="在资源管理器中显示"
            aria-label="在资源管理器中显示"
            onClick={() => revealEntry("")}
            className="rounded p-1 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          >
            <FolderSearch className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <TreeLevel
        level={0}
        nodes={root.children}
        workspacePath={workspacePath}
        onOpenFile={onOpenFile}
        inline={inline}
        setInline={setInline}
        onCreate={createEntry}
        onRename={renameEntry}
        onDelete={deleteEntry}
        onReveal={revealEntry}
        reloadTick={reloadTick}
      />
    </div>
  );
}

function TreeLevel({
  level,
  nodes,
  workspacePath,
  onOpenFile,
  inline,
  setInline,
  onCreate,
  onRename,
  onDelete,
  onReveal,
  reloadTick,
}: {
  level: number;
  nodes: TreeNode[];
  workspacePath: string;
  onOpenFile: (relPath: string) => void;
  inline: InlineMode;
  setInline: (mode: InlineMode) => void;
  onCreate: (parentRel: string, name: string, isDir: boolean) => Promise<void>;
  onRename: (targetRel: string, newName: string) => Promise<void>;
  onDelete: (relPath: string, isDir: boolean) => Promise<void>;
  onReveal: (relPath: string) => void;
  reloadTick: number;
}) {
  // 本层若处于 create 态（父目录匹配），渲染行内新建输入
  const createHere =
    inline.kind === "create" &&
    inline.parentRel === (nodes[0]?.relPath.includes("/")
      ? nodes[0].relPath.slice(0, nodes[0].relPath.lastIndexOf("/"))
      : "");
  return (
    <div className="flex flex-col">
      {nodes.map((node) => (
        <TreeRow
          key={node.relPath}
          node={node}
          level={level}
          workspacePath={workspacePath}
          onOpenFile={onOpenFile}
          inline={inline}
          setInline={setInline}
          onCreate={onCreate}
          onRename={onRename}
          onDelete={onDelete}
          onReveal={onReveal}
          reloadTick={reloadTick}
        />
      ))}
      {createHere ? (
        <InlineNameRow
          level={level + 1}
          isDir={inline.isDir}
          placeholder={inline.isDir ? "文件夹名称" : "文件名"}
          onCancel={() => setInline({ kind: "none" })}
          onSubmit={(name) => void onCreate(inline.parentRel, name, inline.isDir)}
        />
      ) : null}
    </div>
  );
}

function TreeRow({
  node,
  level,
  workspacePath,
  onOpenFile,
  inline,
  setInline,
  onCreate,
  onRename,
  onDelete,
  onReveal,
  reloadTick,
}: {
  node: TreeNode;
  level: number;
  workspacePath: string;
  onOpenFile: (relPath: string) => void;
  inline: InlineMode;
  setInline: (mode: InlineMode) => void;
  onCreate: (parentRel: string, name: string, isDir: boolean) => Promise<void>;
  onRename: (targetRel: string, newName: string) => Promise<void>;
  onDelete: (relPath: string, isDir: boolean) => Promise<void>;
  onReveal: (relPath: string) => void;
  reloadTick: number;
}) {
  const [expanded, setExpanded] = useState(level === 0 && !COLLAPSED_PREFIXES.some((p) => node.name === p));
  const [children, setChildren] = useState<TreeNode[] | null>(node.children ?? null);
  const [loading, setLoading] = useState(false);
  const isRenaming = inline.kind === "rename" && inline.targetRel === node.relPath;

  // 删除/重命名后父链刷新：展开目录按 reloadTick 重拉子节点
  useEffect(() => {
    if (reloadTick === 0 || !node.isDir || !expanded) return;
    let cancelled = false;
    void (async () => {
      try {
        const abs = node.relPath ? `${workspacePath}/${node.relPath}` : workspacePath;
        const entries = await listDir(abs);
        if (!cancelled) {
          setChildren(
            entries.map((e) => ({
              relPath: node.relPath ? `${node.relPath}/${e.name}` : e.name,
              name: e.name,
              isDir: e.isDir,
              size: e.size,
            })),
          );
        }
      } catch {
        /* 目录可能已被删除：保留旧子节点 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadTick]); // eslint-disable-line react-hooks/exhaustive-deps

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

  if (isRenaming) {
    return (
      <InlineNameRow
        level={level}
        isDir={node.isDir}
        initial={node.name}
        onCancel={() => setInline({ kind: "none" })}
        onSubmit={(name) => void onRename(node.relPath, name)}
      />
    );
  }

  return (
    <div>
      <div className="group/frow flex items-center">
        <button
          type="button"
          onClick={() => void toggle()}
          className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-0.5 text-left text-xs text-[var(--text)] hover:bg-[var(--surface-hover)]"
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
        <div className="hidden shrink-0 items-center gap-0.5 pr-1 group-hover/frow:flex">
          {node.isDir ? (
            <button
              type="button"
              title="在此文件夹新建"
              aria-label={`在 ${node.name} 中新建`}
              onClick={() => {
                setExpanded(true);
                setInline({ kind: "create", parentRel: node.relPath, isDir: false });
              }}
              className="rounded p-0.5 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            >
              <FilePlus className="h-3 w-3" />
            </button>
          ) : null}
          <button
            type="button"
            title="重命名"
            aria-label={`重命名 ${node.name}`}
            onClick={() => setInline({ kind: "rename", targetRel: node.relPath, isDir: node.isDir })}
            className="rounded p-0.5 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            type="button"
            title="在资源管理器中显示"
            aria-label={`显示 ${node.name}`}
            onClick={() => onReveal(node.relPath)}
            className="rounded p-0.5 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          >
            <FolderSearch className="h-3 w-3" />
          </button>
          <ConfirmActionPopover
            title="删除"
            description={node.isDir ? `“${node.name}” 及其全部内容将被删除` : `“${node.name}” 将被删除`}
            confirmLabel="删除"
            cancelLabel="取消"
            onConfirm={() => void onDelete(node.relPath, node.isDir)}
          >
            {(open) => (
              <button
                type="button"
                title="删除"
                aria-label={`删除 ${node.name}`}
                onClick={open}
                className="rounded p-0.5 text-[var(--text-dim)] hover:bg-red-500/10 hover:text-red-500"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </ConfirmActionPopover>
        </div>
      </div>
      {node.isDir && expanded && children ? (
        <TreeLevel
          level={level + 1}
          nodes={children}
          workspacePath={workspacePath}
          onOpenFile={onOpenFile}
          inline={inline}
          setInline={setInline}
          onCreate={onCreate}
          onRename={onRename}
          onDelete={onDelete}
          onReveal={onReveal}
          reloadTick={reloadTick}
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

/** 行内命名输入（新建/重命名共用；Enter 提交、Esc 取消） */
function InlineNameRow({
  level,
  isDir,
  initial = "",
  placeholder,
  onCancel,
  onSubmit,
}: {
  level: number;
  isDir: boolean;
  initial?: string;
  placeholder?: string;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const submit = () => {
    if (value.trim()) onSubmit(value.trim());
    else onCancel();
  };
  return (
    <div
      className="flex items-center gap-1 py-0.5 pr-1"
      style={{ paddingLeft: level * 12 + 4 }}
    >
      {isDir ? (
        <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" />
      ) : (
        <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--text-dim)]" />
      )}
      <input
        autoFocus
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={submit}
        className="min-w-0 flex-1 rounded border border-[var(--brand)] bg-transparent px-1 py-0.5 text-xs text-[var(--text)] focus:outline-none"
      />
      <button
        type="button"
        title="确认"
        onMouseDown={(e) => {
          e.preventDefault();
          submit();
        }}
        className="rounded p-0.5 text-emerald-500 hover:bg-[var(--surface-hover)]"
      >
        <Check className="h-3 w-3" />
      </button>
      <button
        type="button"
        title="取消"
        onMouseDown={(e) => {
          e.preventDefault();
          onCancel();
        }}
        className="rounded p-0.5 text-[var(--text-dim)] hover:text-red-500"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
