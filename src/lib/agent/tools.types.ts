/**
 * tools · 编译期形状证明（**只有类型，无运行时副作用**）。
 *
 * 本文件**不被任何模块 import** —— 是刻意的类型灯标：
 *   - Vite 只打包入口可达的模块，孤儿文件不会进 bundle；
 *   - 但 `tsc`（`bun run build` 里的 `tsc` 步骤）会检查它。
 * 因此：只要本文件能编译通过，就**证明** `createTools()` 的返回值确实满足库要的
 * `AgentTool[]` 形状（含最容易漏的 `label` 与 `details`）。
 *
 * 若哪天有人改坏了 `tools.js` / `tools.d.ts` 的导出签名，这里会**先于**运行期测试报错。
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";

import { createTools, getTools, TOOLS } from "./tools";

/**
 * ✅ 正证 1：工具集可赋给 `AgentTool[]`。
 * 编译通过 ⇔ 每个工具的字段（name/description/parameters + label/execute）都齐。
 */
export const tools: AgentTool[] = createTools({ now: () => new Date(0) });

/** ✅ 正证 2：`getTools()` / `TOOLS` 同为 `AgentTool[]`。 */
export const copyTools: AgentTool[] = getTools();
export const defaultTools: AgentTool[] = TOOLS;

/**
 * ✅ 正证 3：从工具集里取出一个工具，其 `execute` 返回值的形状与库的
 * `AgentToolResult<unknown>` 兼容 —— 证明 `buildTextToolResult` 的产物
 * 满足 `content` + **必填** `details` 的契约（`details` 会被回调为 UI 卡片的真值）。
 */
export async function probeExecuteResult(): Promise<AgentToolResult<unknown>> {
  const tool = tools[0];
  const params = {} as Static<TSchema>;
  return tool.execute("probe-tool-call-id", params);
}
