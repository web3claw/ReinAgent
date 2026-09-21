/**
 * markdownBlocks 的类型声明（实现见同目录 `markdownBlocks.js`）。
 *
 * 采用「.js 实现 + .d.ts 声明」：Node（`node --test` / 基准脚本）直接加载 `.js`，
 * TS/Vite 取 `.d.ts` 做类型检查，无需预编译 —— 与 conversationModel / stateBridge 同模式。
 */

import type { ReactElement } from "react";

/** 首次渲染的字符预算（约 60KB）。 */
export const INITIAL_RENDER_CHAR_BUDGET: number;

/**
 * 把 Markdown 文本切成顶层块（无损：`splitBlocks(t).join("") === t`）。
 * 空串 → `[]`；纯空白 → 单元素数组；单块 → 长度 1 的数组。
 * 若含**文档作用域构造**（见 `hasDocumentScopedConstructs`）→ 返回 `[text]`（整篇单块）。
 */
export function splitBlocks(text: string): string[];

/**
 * 文本是否含文档作用域构造（链接引用定义 / GFM 脚注定义 / 可跨空行的 HTML 块 type 1-5）。
 * 定义类构造**不锚定缩进**：既可在容器块内（引用块 `>`、列表项 `- ` `1.`，**可重复/交替**如
 * `- - - [a]:`、`1. 1. [a]:`），也可作为**列表项续行**（无标记、行首缩进 ≥4），作用域一律是整篇；
 * 标签允许转义 `\]`、允许恰为 `^`。保守实现：宁可误报（只损失性能）也不漏报（会损失正确性）。
 */
export function hasDocumentScopedConstructs(text: string): boolean;

export interface WindowBlocksOptions {
  /** 字符预算，默认 `INITIAL_RENDER_CHAR_BUDGET`。 */
  budget?: number;
}

export interface WindowBlocksResult {
  /** 预算内的可见块（至少包含第一块）。 */
  visible: string[];
  /** 被隐藏的字符总数。 */
  hiddenChars: number;
  /** 被隐藏的块数。 */
  hiddenBlocks: number;
  /** 是否发生截断（hiddenBlocks > 0）。 */
  truncated: boolean;
}

/** 渲染预算：按顺序累计到预算即截断，至少渲染第一块。纯函数。 */
export function windowBlocks(blocks: string[], options?: WindowBlocksOptions): WindowBlocksResult;

export interface MarkdownBlocksProps {
  /** 完整 Markdown 文本。 */
  text: string;
  /** 字符预算（默认 `INITIAL_RENDER_CHAR_BUDGET`）。 */
  budget?: number;
}

/** 块级 Markdown 渲染组件（每块独立 memo；`truncated` 时提供展开/收起按钮）。 */
export function MarkdownBlocks(props: MarkdownBlocksProps): ReactElement;
