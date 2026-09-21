/**
 * stateBridge 的类型声明（实现见同目录 `stateBridge.js`）。
 *
 * 与 conversationModel / conversationController 一致，采用「.js 实现 + .d.ts 声明」：
 *   - Node（`node --test`）直接加载 `.js`；
 *   - TS/Vite 取 `.d.ts` 做类型检查，无需预编译。
 */

import type { ChatState } from "./conversationModel";

export interface StateBridgeOptions {
  /** 初始真相（**值**语义）。 */
  initialState: ChatState;
  /** 渲染提交：以「值」语义接收新状态（React 侧传 `setState`）。 */
  commit: (next: ChatState) => void;
}

export interface StateBridge {
  /** 返回内部持有的当前真相（同 tick 内已是最新）。 */
  getState: () => ChatState;
  /** 同步推进真相；支持 updater 或直接值；返回推进后的真相。 */
  setState: (updater: ((prev: ChatState) => ChatState) | ChatState) => ChatState;
}

export function createStateBridge(options: StateBridgeOptions): StateBridge;
