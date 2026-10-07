/**
 * checkpointRewind —— 「回退本轮代码改动」的前端编排（完整移植 LiveAgent
 * checkpointRewind.tsx：preview → 明细确认框（destructive 确认键 + 等宽路径清单）
 * → 回传全部预览哈希执行（TOCTOU 防护）→ toast / 部分完成对话框反馈 → 重拉轮列表）。
 * 传输层为 Tauri invoke（checkpoint_list / checkpoint_diff_stats / checkpoint_rewind_code）。
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "../../i18n";
import { useConfirmDialog } from "../../components/ui/ConfirmDialog";

export type CheckpointTurnSummary = {
  turnSeq: number;
  turnId: string;
  fileCount: number;
  dirCount: number;
  /** 该轮存在捕获失败记录（前像不完整），回退可能遗漏部分文件。 */
  incomplete: boolean;
  firstCapturedAt: number;
};

export type CheckpointDiffStats = {
  turnSeq: number;
  restoreFiles: number;
  deleteFiles: number;
  cleanFiles: number;
  skippedDirs: number;
  missingBlobs: number;
  /** 根已不在当前授权工作区集合内、或路径链上出现符号链接的条目：一律不回退。 */
  unresolvableFiles: number;
  captureErrors: number;
  entries: { path: string; key: string; action: string; currentHash?: string }[];
};

export type CheckpointRewindResult = {
  turnSeq: number;
  restoredFiles: number;
  deletedFiles: number;
  cleanFiles: number;
  skippedDirs: number;
  captureErrors: number;
  conflicts: string[];
  failed: string[];
};

export type CheckpointRewoundInfo = {
  turnSeq: number;
  restoredFiles: number;
  deletedFiles: number;
  conflicts: number;
  failed: number;
  captureErrors: number;
};

/**
 * 回退完成通知文案（对齐 LiveAgent formatCheckpointRewoundNotification）：
 * 零计数不展示；数字与量词间用不换行空格（U+00A0）防折行；
 * 问题项 collect 进括号尾注；有问题项时 level = "error"。
 */
export function formatCheckpointRewoundNotification(
  info: CheckpointRewoundInfo,
  zh: boolean,
): { level: "success" | "error"; message: string } {
  const nb = (value: number) => `\u00A0${value}\u00A0`;
  const files = (value: number) => `${value} ${value === 1 ? "file" : "files"}`;
  const changes: string[] = [];
  const issues: string[] = [];
  if (zh) {
    if (info.restoredFiles > 0) changes.push(`恢复${nb(info.restoredFiles)}个`);
    if (info.deletedFiles > 0) changes.push(`删除${nb(info.deletedFiles)}个`);
    // 组尾统一补"文件"：单项时"删除 1 个文件"，双项时"恢复 2 个、删除 1 个文件"。
    if (changes.length > 0) changes[changes.length - 1] += "文件";
    if (info.conflicts > 0) issues.push(`冲突跳过${nb(info.conflicts)}个`);
    if (info.failed > 0) issues.push(`失败${nb(info.failed)}个`);
    if (info.captureErrors > 0) issues.push(`${info.captureErrors}\u00A0个无前像未回退`);
  } else {
    if (info.restoredFiles > 0) changes.push(`restored ${files(info.restoredFiles)}`);
    if (info.deletedFiles > 0) changes.push(`deleted ${files(info.deletedFiles)}`);
    if (info.conflicts > 0)
      issues.push(`${info.conflicts} conflict${info.conflicts === 1 ? "" : "s"} skipped`);
    if (info.failed > 0) issues.push(`${info.failed} failed`);
    if (info.captureErrors > 0) issues.push(`${info.captureErrors} without pre-image`);
  }
  const head = zh
    ? changes.length > 0
      ? `已回退代码：${changes.join("、")}`
      : "已回退代码：没有文件需要改动"
    : changes.length > 0
      ? `Code rewound: ${changes.join(", ")}`
      : "Code rewound: no file changes were needed";
  const message =
    issues.length > 0
      ? zh
        ? `${head}（${issues.join("、")}）`
        : `${head} (${issues.join(", ")})`
      : head;
  return {
    level: info.failed > 0 || info.conflicts > 0 || info.captureErrors > 0 ? "error" : "success",
    message,
  };
}

/** 行内回退按钮所需的全部状态：available=false 时按钮禁用展示（无检查点）。 */
export type CheckpointRewindAction = {
  available: boolean;
  pending: boolean;
  disabled: boolean;
  onRewind?: () => void;
};

type CheckpointRewindContextValue = {
  turns: Map<string, CheckpointTurnSummary>;
  loading: boolean;
  disabled: boolean;
  busyTurn: number | null;
  rewind: (turn: CheckpointTurnSummary) => void;
};

const CheckpointRewindContext = createContext<CheckpointRewindContextValue | null>(null);

/**
 * 检查点覆盖 write_file（edit = 读后整文件写回）工具的改动；终端命令的写入
 * 不在检查点内。回退点 = 用户消息：turnId 就是用户消息 ID，行内按钮按
 * messageId 命中本轮（对齐 LiveAgent/Claude Code 的每消息回退）。
 */
export function CheckpointRewindProvider(props: {
  children: ReactNode;
  conversationId?: string;
  /** 发送/流式中为 true：行内按钮全体禁用，且暂停列表刷新。 */
  disabled?: boolean;
  /**
   * 回退授权的唯一来源：当前会话工作区根。后端只认这个集合里的 root，
   * 记录里存的绝对路径本身不构成授权（fail-closed）。
   */
  resolveAuthorizedRoots: () => Promise<string[]>;
  onRewound?: (info: CheckpointRewoundInfo) => void;
}) {
  const { children, conversationId, disabled = false, resolveAuthorizedRoots, onRewound } = props;
  const { locale } = useTranslation();
  const zh = locale === "zh-CN";
  const { confirm, dialog } = useConfirmDialog();
  const [turns, setTurns] = useState<CheckpointTurnSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyTurn, setBusyTurn] = useState<number | null>(null);

  // latest-ref：宿主通常内联传回调（每渲染新身份），不进依赖，避免 context 随帧重建。
  const resolveRootsRef = useRef(resolveAuthorizedRoots);
  const onRewoundRef = useRef(onRewound);
  const disabledRef = useRef(disabled);
  useEffect(() => {
    resolveRootsRef.current = resolveAuthorizedRoots;
    onRewoundRef.current = onRewound;
    disabledRef.current = disabled;
  });

  // 列表加载代际：慢响应（切任务前发出的）一律丢弃，防乱序覆盖。
  const loadEpochRef = useRef(0);
  const loadTurns = useCallback(async () => {
    const epoch = ++loadEpochRef.current;
    if (!conversationId) {
      setTurns([]);
      return;
    }
    setLoading(true);
    try {
      const list = await invoke<CheckpointTurnSummary[]>("checkpoint_list", {
        conversationId,
      });
      if (loadEpochRef.current === epoch) setTurns(list);
    } catch (err) {
      console.warn(`[checkpoint] checkpoint_list failed for conversation ${conversationId}:`, err);
      if (loadEpochRef.current === epoch) setTurns([]);
    } finally {
      if (loadEpochRef.current === epoch) setLoading(false);
    }
  }, [conversationId]);

  // 切任务立刻清空旧列表：旧任务的轮残留可能错配到新任务的同 ID 气泡上。
  useEffect(() => {
    loadEpochRef.current += 1;
    setTurns([]);
  }, [conversationId]);

  // 空闲（挂载/切任务/轮次结束）时刷新；发送中不拉取，半截时间线没有展示价值。
  useEffect(() => {
    if (!disabled) void loadTurns();
  }, [disabled, loadTurns]);

  // busy 守卫走 ref：rewind 不依赖 busyTurn state，身份保持稳定。
  const busyTurnRef = useRef<number | null>(null);
  const rewind = useCallback(
    async (turn: CheckpointTurnSummary) => {
      if (!conversationId || disabledRef.current || busyTurnRef.current !== null) return;
      busyTurnRef.current = turn.turnSeq;
      setBusyTurn(turn.turnSeq);
      try {
        const authorizedRoots = await resolveRootsRef.current();
        const stats = await invoke<CheckpointDiffStats>("checkpoint_diff_stats", {
          conversationId,
          turnSeq: turn.turnSeq,
          authorizedRoots,
        });
        const parts: string[] = [];
        if (stats.restoreFiles > 0)
          parts.push(
            zh ? `将恢复 ${stats.restoreFiles} 个文件` : `Restore ${stats.restoreFiles} file(s)`,
          );
        if (stats.deleteFiles > 0)
          parts.push(
            zh ? `将删除 ${stats.deleteFiles} 个文件` : `Delete ${stats.deleteFiles} file(s)`,
          );
        if (stats.cleanFiles > 0)
          parts.push(
            zh ? `${stats.cleanFiles} 个文件无变化` : `${stats.cleanFiles} file(s) unchanged`,
          );
        if (stats.skippedDirs > 0)
          parts.push(
            zh
              ? `${stats.skippedDirs} 个已删除的目录无法恢复`
              : `${stats.skippedDirs} deleted director(ies) cannot be restored`,
          );
        if (stats.missingBlobs > 0)
          parts.push(
            zh
              ? `${stats.missingBlobs} 个文件缺少改动前快照`
              : `${stats.missingBlobs} file(s) missing their pre-edit snapshot`,
          );
        if (stats.unresolvableFiles > 0)
          parts.push(
            zh
              ? `${stats.unresolvableFiles} 个路径无法回退（目录未授权，或路径包含符号链接）`
              : `${stats.unresolvableFiles} path(s) cannot be rewound (directory unauthorized, or path contains a symlink)`,
          );
        if (stats.captureErrors > 0 || turn.incomplete)
          parts.push(
            zh
              ? `本轮有 ${Math.max(stats.captureErrors, 1)} 次快照记录失败，回退结果可能不完整`
              : `${Math.max(stats.captureErrors, 1)} snapshot(s) failed to record this turn; the rewind may be incomplete`,
          );
        const actionable = stats.entries.filter(
          (entry) => entry.action === "restore" || entry.action === "delete",
        );
        // 检查点只记录工具写入前的前像，编辑器/文件树里的手改既不入账、
        // 也无法与工具写入区分。回退按前像整体覆盖，手改会被一并抹掉，先说清楚。
        if (actionable.length > 0)
          parts.push(
            zh
              ? "在编辑器或文件树中的手动修改不在检查点内，将被一并覆盖"
              : "Manual edits made in the editor or file tree are not checkpointed and will be overwritten",
          );
        const confirmed = await confirm({
          title: zh ? "回退到本轮开始前" : "Rewind to before this turn",
          subtitle: new Date(turn.firstCapturedAt).toLocaleString(),
          description:
            parts.length > 0
              ? parts.join(zh ? "，" : ", ")
              : zh
                ? "本轮没有可回退的文件改动"
                : "No file changes to rewind in this turn",
          detail:
            actionable.length > 0 ? actionable.map((entry) => entry.path).join("\n") : undefined,
          confirmLabel: zh ? "回退" : "Rewind",
          cancelLabel: zh ? "取消" : "Cancel",
        });
        if (!confirmed) return;
        // 把预览时的现状哈希传回后端，回退前逐个复核：预览到执行之间被外部
        // 修改的文件会被跳过并报告为冲突，绝不覆盖（TOCTOU 防护）。
        // 必须回传全部可解析条目（含 clean）——后端对缺哈希的条目一律判冲突。
        const expected = stats.entries.flatMap((entry) =>
          entry.currentHash == null ? [] : [{ key: entry.key, currentHash: entry.currentHash }],
        );
        const result = await invoke<CheckpointRewindResult>("checkpoint_rewind_code", {
          conversationId,
          turnSeq: turn.turnSeq,
          authorizedRoots,
          expected,
        });
        onRewoundRef.current?.({
          turnSeq: turn.turnSeq,
          restoredFiles: result.restoredFiles,
          deletedFiles: result.deletedFiles,
          conflicts: result.conflicts.length,
          failed: result.failed.length,
          captureErrors: result.captureErrors,
        });
        // 完整回退会在后端剪掉 turnSeq 及之后的轮，重拉让按钮态跟上。
        await loadTurns();
        if (
          result.failed.length > 0 ||
          result.conflicts.length > 0 ||
          result.captureErrors > 0 ||
          result.skippedDirs > 0
        ) {
          const issueLines = [
            ...result.conflicts.map((path) =>
              zh ? `冲突(已跳过): ${path}` : `conflict (skipped): ${path}`,
            ),
            ...result.failed.map((path) => (zh ? `失败: ${path}` : `failed: ${path}`)),
          ];
          if (result.captureErrors > 0)
            issueLines.push(
              zh
                ? `该轮有 ${result.captureErrors} 个文件没有前像(捕获失败)，未被回退`
                : `${result.captureErrors} file(s) had no pre-image (capture failed) and were not rewound`,
            );
          if (result.skippedDirs > 0)
            issueLines.push(
              zh
                ? `${result.skippedDirs} 个被删除目录无法恢复`
                : `${result.skippedDirs} deleted dir(s) could not be restored`,
            );
          await confirm({
            title: zh ? "回退部分未完成" : "Rewind partially completed",
            description: zh
              ? `已恢复 ${result.restoredFiles} 个、删除 ${result.deletedFiles} 个；冲突跳过 ${result.conflicts.length} 个、失败 ${result.failed.length} 个`
              : `Restored ${result.restoredFiles}, deleted ${result.deletedFiles}; ${result.conflicts.length} conflict(s) skipped, ${result.failed.length} failed`,
            detail: issueLines.join("\n"),
            confirmLabel: zh ? "知道了" : "OK",
            cancelLabel: "",
            hideCancel: true,
          });
        }
      } catch (error) {
        await confirm({
          title: zh ? "回退失败" : "Rewind failed",
          description: String(error),
          confirmLabel: zh ? "知道了" : "OK",
          cancelLabel: "",
          hideCancel: true,
        });
      } finally {
        busyTurnRef.current = null;
        setBusyTurn(null);
      }
    },
    [confirm, conversationId, loadTurns, zh],
  );

  const value = useMemo<CheckpointRewindContextValue>(
    () => ({
      turns: new Map(turns.map((turn) => [turn.turnId, turn])),
      loading,
      disabled,
      busyTurn,
      rewind: (turn) => void rewind(turn),
    }),
    [busyTurn, disabled, loading, rewind, turns],
  );

  return (
    <CheckpointRewindContext.Provider value={value}>
      {children}
      {dialog}
    </CheckpointRewindContext.Provider>
  );
}

/** 按用户消息 ID 取本行的回退动作。Provider 之外返回 null（按钮以禁用态展示）。 */
export function useCheckpointRewindAction(turnId?: string): CheckpointRewindAction | null {
  const context = useContext(CheckpointRewindContext);
  if (!context) return null;
  const turn = turnId ? context.turns.get(turnId) : undefined;
  return {
    available: !!turn,
    pending: !!turn && context.busyTurn === turn.turnSeq,
    disabled: context.disabled || context.loading || context.busyTurn !== null || !turn,
    onRewind: turn ? () => context.rewind(turn) : undefined,
  };
}
