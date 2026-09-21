/**
 * toolDisplay 的类型声明（实现见同目录 `toolDisplay.js`）。
 *
 * 沿用本项目既有做法「纯 `.js` 逻辑 + 手写 `.d.ts`」：
 *   - Node（`node --test`）直接加载 `.js`；
 *   - TS/Vite 取本 `.d.ts` 做类型检查；
 * 无需任何预编译步骤。
 *
 * 本文件没有任何 import，因此不可能从 pi-ai / pi-agent-core 的桶文件拖入运行时依赖。
 */

/** `formatToolArgs` 的选项。 */
export interface FormatToolArgsOptions {
  /**
   * 截断上限，按 **Unicode 码点** 计（默认 120）。
   * 超过时截前 `maxLength` 个码点并补 `…`（省略号不计入额度）。
   * 负数 / NaN / 非数字按 0 处理。
   */
  maxLength?: number;
}

/**
 * 把「库解析好的参数对象」格式化成一行可读文本。
 * - `undefined` / `null` / 空对象 `{}` → `""`；
 * - 其它对象 → `key=value`（`, ` 连接，顺序取 `Object.keys`）；
 * - 非对象 → 按单值渲染。
 * 任何输入都不会抛错。
 */
export function formatToolArgs(args?: unknown, options?: FormatToolArgsOptions): string;
