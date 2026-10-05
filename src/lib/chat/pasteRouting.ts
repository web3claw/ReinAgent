/**
 * pasteRouting —— 输入框粘贴路由判定（纯逻辑，便于单测）。
 *
 * 背景两条：
 * 1. Tauri Linux 用 WebKitGTK：paste 事件会派发，但不交付剪贴板图片
 *    （clipboardData 的 types/files/items 全空、文本也是 0），所以「无图且无文本」
 *    这一形态要识别出来并走原生读剪贴板兜底（见 clipboard_read_image）；
 * 2. 对齐 ZCode：超长文本不塞进输入框，而是落盘成附件文件（路径引用附件）。
 */

/** 超长文本转附件的阈值（字符数；与 ZCode LONG_PASTE_TEXT_ATTACHMENT_CHAR_THRESHOLD 同值）。 */
export const LONG_PASTE_TEXT_THRESHOLD_CHARS = 15 * 1024;

/** 文本附件的大小上限（UTF-8 字节）：超出则如实报错、不落盘。 */
export const PASTED_TEXT_MAX_BYTES = 10 * 1024 * 1024;

export type PasteRoute =
  /** clipboardData 已交付图片文件（Chromium/WebView2）→ 既有路径 */
  | { kind: "image-file" }
  /** 超长文本 → 落盘为 .txt 附件 */
  | { kind: "text-file" }
  /** 超长文本且超过上限 → 如实报错，不落盘 */
  | { kind: "text-too-large" }
  /** 无图且无文本 → WebKitGTK 下的位图粘贴形态，走原生读剪贴板 */
  | { kind: "native-image" }
  /** 普通文本粘贴 → 交给默认行为，不做任何拦截 */
  | { kind: "plain" };

export interface PasteShape {
  /** clipboardData.files 里是否已有图片文件。 */
  hasImageFile: boolean;
  /** clipboardData.getData("text/plain") 的字符数。 */
  textLength: number;
  /** 同一文本的 UTF-8 字节数（用 utf8ByteLength 计算）。 */
  textBytes: number;
}

export function classifyPaste({
  hasImageFile,
  textLength,
  textBytes,
}: PasteShape): PasteRoute {
  // DOM 已交付图片：优先按图片处理（与既有行为一致，即便同时带文本）
  if (hasImageFile) return { kind: "image-file" };
  if (textLength >= LONG_PASTE_TEXT_THRESHOLD_CHARS) {
    return textBytes > PASTED_TEXT_MAX_BYTES ? { kind: "text-too-large" } : { kind: "text-file" };
  }
  if (textLength === 0) return { kind: "native-image" };
  return { kind: "plain" };
}

/** UTF-8 字节数（浏览器与 Node 均有 TextEncoder）。 */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** 粘贴文本附件的文件名（对齐 ZCode：`pasted-text-YYYYMMDD-HHmmss.txt`）。 */
export function createPastedTextFilename(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `pasted-text-${stamp}.txt`;
}
