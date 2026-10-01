/**
 * shortcuts —— 可自定义全局快捷键（P2-G2 尾巴）。
 *
 * 动作注册表固定（id + 默认绑定 + 说明键），用户绑定存 kv
 * `reinagent-shortcuts`（JSON {actionId: "Ctrl+Shift+K"}）。
 * G1 集中键盘 handler 每次按键用 matchesShortcut 查当前绑定（kv 缓存读，廉价）。
 * 冲突检测：保存时与其它动作的绑定比对，重复则拒绝。
 */

import { kvGet, kvSet } from "../storage/db";

const BINDINGS_KEY = "reinagent-shortcuts";

export interface ShortcutActionDef {
  id: string;
  /** i18n 键 */
  labelKey: string;
  /** 默认绑定（用户未自定义时） */
  defaultBinding: string;
  /** 编辑框聚焦时是否仍触发（G1 语义） */
  allowInEditable: boolean;
}

export const SHORTCUT_ACTIONS: ShortcutActionDef[] = [
  { id: "find", labelKey: "shortcutFind", defaultBinding: "Ctrl+F", allowInEditable: true },
  { id: "newTask", labelKey: "paletteNewTask", defaultBinding: "Ctrl+T", allowInEditable: false },
  { id: "palette", labelKey: "paletteTitle", defaultBinding: "Ctrl+K", allowInEditable: true },
  { id: "focusComposer", labelKey: "paletteFocusComposer", defaultBinding: "Ctrl+Shift+A", allowInEditable: false },
];

export type ShortcutBindings = Record<string, string>;

/** 当前生效绑定（用户自定义覆盖默认；坏值回退默认）。 */
export function getShortcutBindings(): ShortcutBindings {
  const custom: ShortcutBindings = (() => {
    try {
      const raw = kvGet(BINDINGS_KEY);
      return raw ? (JSON.parse(raw) as ShortcutBindings) : {};
    } catch {
      return {};
    }
  })();
  const out: ShortcutBindings = {};
  for (const action of SHORTCUT_ACTIONS) {
    const value = custom[action.id];
    out[action.id] = typeof value === "string" && value.trim() ? value : action.defaultBinding;
  }
  return out;
}

export function getShortcutFor(actionId: string): string {
  return getShortcutBindings()[actionId] ?? "";
}

export function setShortcutBinding(actionId: string, binding: string): void {
  const custom: ShortcutBindings = (() => {
    try {
      const raw = kvGet(BINDINGS_KEY);
      return raw ? (JSON.parse(raw) as ShortcutBindings) : {};
    } catch {
      return {};
    }
  })();
  const def = SHORTCUT_ACTIONS.find((a) => a.id === actionId);
  if (def && binding === def.defaultBinding) {
    delete custom[actionId]; // 回默认 = 删除自定义项
  } else {
    custom[actionId] = binding;
  }
  kvSet(BINDINGS_KEY, JSON.stringify(custom));
}

export interface ParsedShortcut {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** 规范化主键（小写字母/数字/功能键原名） */
  key: string;
}

/** 解析 "Ctrl+Shift+A" 形态的绑定串；非法返回 null。 */
export function parseShortcut(binding: string): ParsedShortcut | null {
  const parts = binding
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null; // 必须带至少一个修饰键（防占用纯字符键）
  const key = parts.pop() as string;
  if (!/^[a-z0-9]$/i.test(key) && !/^F([1-9]|1[0-2])$/i.test(key)) return null;
  const has = (name: string) => parts.some((p) => p.toLowerCase() === name);
  return { ctrl: has("ctrl"), shift: has("shift"), alt: has("alt"), key: key.toLowerCase() };
}

/** 从键盘事件规范化出绑定串（用于录制）；无修饰键的按键返回 null（不可录制）。 */
export function shortcutFromEvent(e: KeyboardEvent): string | null {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  const mainOk = /^[a-z0-9]$/i.test(key) || /^F([1-9]|1[0-2])$/i.test(key);
  if (!mainOk) return null;
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("Ctrl");
  if (e.shiftKey) mods.push("Shift");
  if (e.altKey) mods.push("Alt");
  if (mods.length === 0) return null; // 必须带修饰键
  return `${mods.join("+")}+${key.toUpperCase()}`;
}

/** 按键事件是否命中绑定。 */
export function matchesShortcut(e: KeyboardEvent, binding: string): boolean {
  const parsed = parseShortcut(binding);
  if (!parsed) return false;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  return (
    parsed.key === key &&
    parsed.ctrl === (e.ctrlKey || e.metaKey) &&
    parsed.shift === e.shiftKey &&
    parsed.alt === e.altKey
  );
}
