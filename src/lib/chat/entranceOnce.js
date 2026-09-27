/**
 * entranceOnce —— 消息行入场动画的一次性注册表（对齐 LiveAgent entranceOnce）。
 * 条目诞生（编辑重发替换原位消息）后的短窗口内允许播放入场动画；
 * 初始构建/晚挂载的历史行永不播放。纯逻辑（无 DOM），供 controller 与组件共用。
 */

const WINDOW_MS = 600;
const bornAt = new Map();

/** 标记一个条目 id 诞生（controller 在编辑重发替换消息时调用）。 */
export function markTurnEntrance(id) {
  bornAt.set(id, Date.now());
  if (bornAt.size > 500) {
    const now = Date.now();
    for (const [key, at] of bornAt) {
      if (now - at > WINDOW_MS) bornAt.delete(key);
    }
  }
}

/** 该 id 是否仍在诞生窗口内（渲染时判定一次即可）。 */
export function wasRecentlyCreated(id) {
  const at = bornAt.get(id);
  if (at === undefined) return false;
  if (Date.now() - at > WINDOW_MS) {
    bornAt.delete(id);
    return false;
  }
  return true;
}
