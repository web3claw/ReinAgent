/** entranceOnce 的类型声明（实现见同目录 `entranceOnce.js`）。 */

/** 标记一个条目 id 诞生（controller 在编辑重发替换消息时调用）。 */
export function markTurnEntrance(id: string): void;

/** 该 id 是否仍在诞生窗口（600ms）内。 */
export function wasRecentlyCreated(id: string): boolean;
