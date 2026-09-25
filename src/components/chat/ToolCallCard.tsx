/**
 * ToolCallCard —— 工具调用卡片（完整移植 ZCode ToolCallBlocks 渲染器结构）。
 *
 * 布局统一走复制过来的 ToolLayout（摘要行 + Collapsible 详情 + 展开态记忆 +
 * 收起延迟卸载 + 运行态 kindLabel 扫光），各类型渲染结构对照 ZCode：
 * - 终端（exec_command ↔ ExecuteToolCallBlock）：摘要行内联命令（展开时隐藏），
 *   详情为 `rounded-xl border bg-panel` 卡：`$` 命令 + ExecuteOutput（5 行上限、吸底-冻结跟随）；
 * - 编辑/写入（edit_file/write_file ↔ EditToolCallBlock）：primaryText 文件 chip
 *   （类型图标 + 可点击文件名 → 右侧 patch diff 视图）+ 目录路径（带尾斜杠）+
 *   条件 `+N/−N`（added>0 / removed>0 才显示），详情为 Shiki 高亮轻量 diff；
 * - 读取（read_file ↔ ReadToolCallBlock）：不可展开；chip 点击在右侧面板打开文件预览；
 * - 其余工具：通用摘要（工具名 + 参数摘要 + 结果折叠）。
 * 三态不做图标旋转/对叉差异（对齐 ZCode 性能取舍）：运行态 = kindLabel 扫光 + 状态词。
 */

import { memo, useMemo } from "react";
import { Pencil, Search, SquareTerminal, Wrench } from "lucide-react";
import type { ToolTimelineEntry } from "../../lib/chat/conversationModel";
import { formatToolArgs } from "../../lib/chat/toolDisplay";
import { useTranslation } from "../../i18n";
import { useAppStore } from "../../store/useAppStore";
import { ToolLayout } from "../../preview/ToolCallBlocks/ToolLayout";
import { ExecuteOutput } from "../../preview/ToolCallBlocks/renderers/ExecuteOutput";
import { HighlightedLightweightDiffPreview } from "../../preview/components/ui/highlighted-lightweight-diff-preview";
import { getPlainTextPatchFallbackLines } from "../../preview/lib/patchDiffPreview";
import { inferCodeLanguage } from "../../preview/lib/codeViewer";
import { useZCodeStore } from "../../preview/store/StoreProvider";
import {
  FileDisplayIcon,
  resolveFileDisplayDescriptor,
} from "../../preview/lib/fileDisplay";
import {
  buildUnifiedPatch,
  computeDiffStat,
  toolArgPath,
} from "../../lib/chat/turnActivity";

function DiffCountView({ added, removed }: { added: number; removed: number }) {
  // 对齐 ZCode renderDiffCount：added>0 才显示绿色 +N，removed>0 才显示红色 −N，零不显示。
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap font-mono leading-none tabular-nums">
      {added > 0 && <span className="text-diff-added">+{added}</span>}
      {removed > 0 && <span className="text-diff-removed">−{removed}</span>}
    </span>
  );
}

/** 文件 chip（对齐 ZCode renderFileChip clickable 分支）：类型图标 + 文件名，hover 下划线；
 * onMouseDown 阻断默认行为——防止点击文件名误触发整行的折叠/展开。 */
function FileChip({
  path,
  workspaceRoot,
  onOpen,
}: {
  path: string;
  workspaceRoot?: string;
  onOpen: () => void;
}) {
  const descriptor = useMemo(
    () => resolveFileDisplayDescriptor(path, { basePath: workspaceRoot }),
    [path, workspaceRoot],
  );
  return (
    <button
      type="button"
      className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 text-foreground-subtle hover:underline"
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      title={descriptor.filePath ?? descriptor.normalizedPath}
    >
      <FileDisplayIcon src={descriptor.fileIconSrc} size={16} className="size-4 shrink-0" />
      <span className="min-w-0 truncate">{descriptor.fileName}</span>
    </button>
  );
}

function ToolCallCardImpl({
  entry,
  workspaceRoot,
}: {
  entry: ToolTimelineEntry;
  workspaceRoot?: string;
}) {
  const { t, locale } = useTranslation();
  const openCodeViewer = useAppStore((state) => state.openCodeViewer);
  const theme = useAppStore((state) => state.theme);
  const codePreviewSettings = useZCodeStore((state) => state.codePreviewSettings);

  const isRunning = entry.status === "running";
  const isError = Boolean(entry.isError);
  const statusLabel = isRunning
    ? t("toolStatusRunning")
    : isError
      ? t("toolStatusFailed")
      : t("toolStatusDone");
  const statusTooltip = isError ? entry.error ?? entry.resultText : undefined;
  // 失败状态词标红（语义变量 --danger），字号不变
  const statusLabelNode = isError ? (
    <span className="text-[var(--danger)]">{statusLabel}</span>
  ) : (
    statusLabel
  );
  const kindLabel = useMemo(
    () => {
      const known: Record<string, string> = {
        read_file: "读取",
        list_dir: "查阅",
        write_file: "写入",
        edit_file: "编辑",
        exec_command: "终端",
      };
      return known[entry.toolName] ?? entry.toolName;
    },
    [entry.toolName, locale]
  );

  const path = toolArgPath(entry.args);
  const fileName = path ? path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path : undefined;
  // 目录段（带尾斜杠、剥工作区根前缀），仅剩文件名时为 undefined（不显示目录）
  const dirPath = useMemo(() => {
    if (!path) return undefined;
    const descriptor = resolveFileDisplayDescriptor(path, { basePath: workspaceRoot });
    return descriptor.filePath ?? undefined;
  }, [path, workspaceRoot]);

  // ---- 终端（对齐 ZCode ExecuteToolCallBlock）----
  if (entry.toolName === "exec_command") {
    const command = typeof entry.args?.command === "string" ? entry.args.command : "";
    const hasResult = entry.resultText.length > 0;
    return (
      <ToolLayout
        toolId={entry.toolCallId}
        icon={<SquareTerminal className="size-4 shrink-0 text-foreground-subtle" />}
        kindLabel={kindLabel}
        primaryText={null}
        secondaryText={<code className="truncate font-sans">{command}</code>}
        hideSecondaryTextWhenOpen
        statusLabel={statusLabelNode}
        showStatusLabel
        showFailureStatus={isError}
        statusTooltip={statusTooltip}
        isRunning={isRunning}
        renderContent={() => (
          <div className="space-y-3 mb-2 rounded-xl border border-border bg-panel px-4 py-3">
            <div className="flex items-start gap-2 font-mono text-ui-base text-foreground">
              <span className="shrink-0 text-foreground-subtle">$</span>
              <pre className="min-w-0 flex-1 block max-h-15 whitespace-pre-wrap break-words">
                {command}
              </pre>
            </div>
            {hasResult ? (
              <ExecuteOutput text={entry.resultText} running={isRunning} />
            ) : !isRunning ? (
              <p className="font-mono text-ui-base text-foreground-subtle">{t("toolNoOutput")}</p>
            ) : null}
          </div>
        )}
      />
    );
  }

  // ---- 编辑 / 写入（对齐 ZCode EditToolCallBlock + EditInlineDiffContent 轻量路径）----
  if (entry.toolName === "edit_file" || entry.toolName === "write_file") {
    const diffStat = useMemo(() => computeDiffStat(entry.toolName, entry.args), [entry]);
    // 参数名回退：edit_file 实际签名为 target/replacement（old_string/new_string 为兼容别名）
    const oldString =
      entry.toolName === "edit_file" && typeof entry.args?.old_string === "string"
        ? entry.args.old_string
        : entry.toolName === "edit_file" && typeof entry.args?.target === "string"
          ? entry.args.target
          : "";
    const newString =
      entry.toolName === "edit_file" && typeof entry.args?.new_string === "string"
        ? entry.args.new_string
        : entry.toolName === "edit_file" && typeof entry.args?.replacement === "string"
          ? entry.args.replacement
          : typeof entry.args?.content === "string"
            ? entry.args.content
            : "";
    const patch = buildUnifiedPatch(path ?? fileName ?? entry.toolName, oldString, newString);
    const highlightLanguage = inferCodeLanguage(path ?? entry.toolName, patch);
    const highlightTheme =
      theme === "light" ? codePreviewSettings.lightTheme : codePreviewSettings.darkTheme;

    return (
      <ToolLayout
        toolId={entry.toolCallId}
        icon={<Pencil className="size-4 shrink-0 text-foreground-subtle" />}
        kindLabel={kindLabel}
        primaryText={
          fileName && path ? (
            <FileChip
              path={path}
              workspaceRoot={workspaceRoot}
              onOpen={() =>
                openCodeViewer({
                  type: "patch",
                  title: fileName,
                  path,
                  patch,
                })
              }
            />
          ) : fileName ? (
            <span className="truncate">{fileName}</span>
          ) : null
        }
        secondaryText={dirPath}
        diffCount={
          diffStat ? (
            <DiffCountView added={diffStat.added} removed={diffStat.removed} />
          ) : undefined
        }
        statusLabel={statusLabelNode}
        showStatusLabel
        showFailureStatus={isError}
        statusTooltip={statusTooltip}
        isRunning={isRunning}
        renderContent={() => (
          <div className="mb-2 max-h-60 overflow-auto rounded-xl border border-border bg-card">
            <HighlightedLightweightDiffPreview
              className="h-full bg-card"
              codePreviewSettings={codePreviewSettings}
              language={highlightLanguage}
              lines={
              getPlainTextPatchFallbackLines(patch) ?? patch.split(/\r?\n/)
            }
              path={path ?? fileName ?? entry.toolName}
              theme={highlightTheme}
            />
          </div>
        )}
      />
    );
  }

  // ---- 读取（对齐 ZCode ReadToolCallBlock：不可展开；chip 点击在右侧面板打开文件）----
  if (entry.toolName === "read_file") {
    return (
      <ToolLayout
        toolId={entry.toolCallId}
        icon={<Search className="size-4 shrink-0 text-foreground-subtle" />}
        kindLabel={kindLabel}
        canToggle={false}
        primaryText={
          fileName && path ? (
            <FileChip
              path={path}
              workspaceRoot={workspaceRoot}
              onOpen={() => openCodeViewer({ type: "file", title: fileName, path })}
            />
          ) : (
            <span className="truncate">{fileName ?? kindLabel}</span>
          )
        }
        secondaryText={dirPath}
        statusLabel={statusLabelNode}
        showStatusLabel
        isRunning={isRunning}
      />
    );
  }

  // ---- 通用兜底（未知工具等）：参数摘要 + 结果折叠 ----
  const argsText = formatToolArgs(entry.args);
  const hasResult = entry.resultText.length > 0;

  return (
    <ToolLayout
      toolId={entry.toolCallId}
      icon={<Wrench className="size-4 shrink-0 text-foreground-subtle" />}
      kindLabel={kindLabel}
      primaryText={null}
      statusLabel={statusLabelNode}
      showStatusLabel
      showFailureStatus={isError}
      statusTooltip={statusTooltip}
      isRunning={isRunning}
      renderContent={() => (
        <div className="mb-2 space-y-1">
          {argsText ? <div className="tool-args" title={argsText}>{argsText}</div> : null}
          {hasResult ? (
            <pre className="tool-result">{entry.resultText}</pre>
          ) : (
            <div className="tool-pending">{t("toolNoOutput")}</div>
          )}
        </div>
      )}
    />
  );
}

/** 仅当条目变化时才重渲染（默认浅比较即可：props 只有 entry）。 */
export const ToolCallCard = memo(ToolCallCardImpl);
