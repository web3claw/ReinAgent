/**
 * push-to-talk（长按说话）按键判定。
 *
 * 独立成无依赖模块，便于单测锁定语义：
 * - 优先物理键位 `code === "ControlRight"`（与键盘布局/输入法无关，最可靠）；
 * - 某些 WebKitGTK 环境不下发 `code`（实测合成按键为 "Unidentified"），
 *   回退 `key === "Control" && location === 2`（DOM 规范里 2 = 右侧修饰键）。
 */

/** 最小键盘事件形状（避免与 React/DOM 类型耦合）。 */
export interface PushToTalkKeyEvent {
  key: string;
  code: string;
  location: number;
}

export function isPushToTalkKey(e: PushToTalkKeyEvent): boolean {
  return e.code === "ControlRight" || (e.key === "Control" && e.location === 2);
}
