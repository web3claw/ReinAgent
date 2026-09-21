/**
 * stateBridge —— 「唯一真相源」桥接（纯逻辑，无 React / 无 DOM）。
 *
 * 背景（S4 三轮修复 P2-1）：
 *   原先 useConversation 用 `stateRef.current = state`（在**渲染期**同步）作为真相源。
 *   但 React 的渲染是**异步**的：在**同一个 tick 内**连续调用两次 `send()` 时，
 *   第二次 `send()` 里 `getState()` 读到的仍是**上一次渲染时**的旧状态，
 *   于是「状态派生判忙」在同 tick 内看不见刚刚开始的那一轮 →
 *   第二次 `send()` 也被受理 → 覆盖了第一轮的 abortRef → 第一轮被 isStale 永久丢弃、
 *   其助手消息永久卡在 `streaming`（即 P2-1）。
 *
 * 修法：让**唯一真相源同步推进**，与 React 渲染解耦：
 *   - `setState(updater)`：先 `next = updater(current)`，**立刻**把 `current` 推进为 `next`，
 *     再把 `next` 作为**值**交给注入的 `commit`（React 侧 `commit = setState`）。
 *   - `getState()` 永远返回内部持有的当前真相，因此在**同一 tick 内立即可见**新值。
 *
 * ⚠ 关键：注入的 `commit` 收到的是**值**而非 updater —— updater 会在 React 提交时才求值，
 *   「滞后」就又会回来；值语义保证真相由本模块**单点、同步**推进。
 *
 * 本文件只依赖自身（无 React），因此可被 `node --test` 直接驱动。
 * 类型声明见同目录 `stateBridge.d.ts`。
 */

/**
 * 创建一个状态桥接。
 *
 * @template TState
 * @param {{
 *   initialState: TState,
 *   commit: (next: TState) => void,
 * }} options
 * @returns {{
 *   getState: () => TState,
 *   setState: (updater: ((prev: TState) => TState) | TState) => TState,
 * }}
 */
export function createStateBridge(options) {
  const { initialState: initial, commit } = options;
  let current = initial;

  /** 返回内部持有的当前真相（同 tick 内已是最新）。 */
  function getState() {
    return current;
  }

  /**
   * 同步推进真相。支持 updater（`prev => next`）或直接值。
   * 推进后立即以「值」语义提交给渲染层。
   * @param {((prev: TState) => TState) | TState} updater
   * @returns {TState} 推进后的真相
   */
  function setState(updater) {
    const next = typeof updater === "function" ? updater(current) : updater;
    // 先同步推进真相：同 tick 内的后续 getState() 立即可见新值。
    current = next;
    // 再以「值」语义交给渲染层（React 的 setState）；此处不做任何延迟求值。
    if (typeof commit === "function") commit(next);
    return next;
  }

  return { getState, setState };
}
