/**
 * tools 的类型声明（实现见同目录 `tools.js`）。
 *
 * 沿用本项目既有做法「纯 `.js` 逻辑 + 手写 `.d.ts`」：
 *   - Node（`node --test`）直接加载 `.js`；
 *   - TS/Vite 取本 `.d.ts` 做类型检查；
 * 无需任何预编译步骤。可参考 `streamFnAdapter.d.ts` / `agentRuntime.d.ts` 的同款模式。
 *
 * ⚠ 本文件里的 import **全部是 `import type`**（类型位置，编译期即被擦除），
 *   因此不会从 pi-agent-core / pi-ai 的**桶文件**拖入运行时依赖。
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

/** 工具硬闸上限。 */
export interface ToolLimits {
  /** 工具返回给模型的文本内容的 UTF-8 字节上限。 */
  maxResultBytes: number;
  /** `calculate` 表达式字符数上限。 */
  maxExpressionLength: number;
  /** `calculate` 括号嵌套深度上限。 */
  maxParenDepth: number;
}

/** `createTools` 的工厂入参。 */
export interface CreateToolsOptions {
  /**
   * 时钟函数，默认 `() => new Date()`。
   * 注入固定时钟即可让测试完全不依赖真实当前时间。
   */
  now?: () => Date;
}

/**
 * 「文本类」工具结果的 `details` 形状。
 * 业务字段（如 `iso` / `expression` / `result`）会与本形状合并。
 */
export interface TextToolResultDetails {
  /** 实际返回文本的 UTF-8 字节长度（截断后）。 */
  length: number;
  /** 截断前原始文本的 UTF-8 字节长度（真值）。 */
  originalLength: number;
  /** 是否发生了截断。 */
  truncated: boolean;
  /** 业务字段（由各工具追加）。 */
  [key: string]: unknown;
}

/** 「文本类」工具结果（`content` 为单段文本，`details` 带限长真值）。 */
export type TextToolResult = AgentToolResult<TextToolResultDetails>;

/** 工具数组类型。 */
export type ToolList = AgentTool[];

/** 工具硬闸上限（运行时为冻结对象）。 */
export declare const TOOL_LIMITS: ToolLimits;

/** 单次运行的默认步数上限（决策 D）。 */
export declare const DEFAULT_MAX_STEPS: number;

/**
 * 构造一个「文本类」工具结果，并在出口按 `maxResultBytes` 做 UTF-8 字节截断。
 * 返回的 `content[0].text` 一定 ≤ `maxResultBytes` 字节；`details` 带 `length` /
 * `originalLength` / `truncated` 真值。业务字段通过第二参合并进 `details`。
 */
export declare function buildTextToolResult(
  text: string,
  details?: Record<string, unknown>,
): TextToolResult;

/** 创建工具集（时钟可注入）。 */
export declare function createTools(options?: CreateToolsOptions): ToolList;

/** 默认工具实例（模块加载时创建一次，时钟为真实系统时钟）。 */
export declare const TOOLS: ToolList;

/** 返回默认工具集的**浅拷贝**，防止外部改动内部注册表数组。 */
export declare function getTools(): ToolList;
