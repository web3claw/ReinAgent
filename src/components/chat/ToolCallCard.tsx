/**
 * ToolCallCard —— 工具调用卡片（完整移植 ZCode ToolCallBlocks 渲染器结构）。
 *
 * 布局统一走复制过来的 ToolLayout（摘要行 + Collapsible 详情 + 展开态记忆 +
 * 收起延迟卸载 + 运行态 kindLabel 扫光），各类型渲染结构对照 ZCode：
 * - 终端（exec_command ↔ ExecuteToolCallBlock）：摘要行内联命令（展开时隐藏），
 *   详情为 `rounded-xl border bg-panel` 卡：`$` 命令 + ExecuteOutput（5 行上限、吸底-冻结跟随）；
 * - 编辑/写入（edit_file/write_file ↔ EditToolCallBlock）：primaryText 文件 chip +
 *   `+N/−N`（LCS 精确口径），详情为 Shiki 高亮轻量 diff（buildUnifiedPatch 生成统一格式）；
 * - 读取（read_file ↔ ReadToolCallBlock）：不可展开；chip 点击在右侧面板打开文件预览；
 * - 其余工具：通用摘要（工具名 + 参数摘要 + 结果折叠）。
 * 三态不做图标旋转/对叉差异（对齐 ZCode 性能取舍）：运行态 = kindLabel 扫光 + 状态词。
 */

import { memo, useMemo } from "react";
import { FileText, Pencil, Search, SquareTerminal, Wrench } from "lucide-react";
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
  buildUnifiedPatch,
  computeDiffStat,
  toolArgPath,
} from "../../lib/chat/turnActivity";

function DiffCountView({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="font-mono tabular-nums">
      <span className="text-diff-added">+{added}</span>{" "}
      <span className="text-diff-removed">−{removed}</span>
    </span>
  );
}

function ToolCallCardImpl({ entry }: { entry: ToolTimelineEntry }) {
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
        calculate: "计算",
      };
      return known[entry.toolName] ?? entry.toolName;
    },
    [entry.toolName, locale]
  );

  const path = toolArgPath(entry.args);
  const fileName = path ? path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path : undefined;

  // ---- 终端（对齐 ZCode ExecuteToolCallBlock）----
  if (entry.toolName === "exec_command") {
    const command = typeof entry.args?.command === "string" ? entry.args.command : "";
    const hasResult = entry.resultText.length > 0;
    return (
      <ToolLayout
        toolId={entry.toolCallId}
        icon={<SquareTerminal className="size-4 shrink-0 text-foreground-subtle" />}
        kindLabel={isRunning ? t("toolStatusRunning") : kindLabel}
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
    const oldString =
      entry.toolName === "edit_file" && typeof entry.args?.old_string === "string"
        ? entry.args.old_string
        : "";
    const newString =
      entry.toolName === "edit_file" && typeof entry.args?.new_string === "string"
        ? entry.args.new_string
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
        kindLabel={isRunning ? t("toolStatusRunning") : kindLabel}
        primaryText={fileName ? <span className="truncate">{fileName}</span> : null}
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
          <button
            type="button"
            className="inline-flex min-w-0 cursor-pointer items-center gap-1.5"
            onClick={() => path && openCodeViewer({ type: "file", title: fileName ?? path, path })}
            title={path}
          >
            <FileText className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{fileName ?? kindLabel}</span>
          </button>
        }
        secondaryText={path}
        statusLabel={statusLabelNode}
        showStatusLabel
        isRunning={isRunning}
      />
    );
  }

  // ---- 通用兜底（calculate / 未知工具等）：参数摘要 + 结果折叠 ----
  const argsText = formatToolArgs(entry.args);
  const hasResult = entry.resultText.length > 0;

  return (
    <ToolLayout
      toolId={entry.toolCallId}
      icon={<Wrench className="size-4 shrink-0 text-foreground-subtle" />}
      kindLabel={isRunning ? t("toolStatusRunning") : kindLabel}
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
