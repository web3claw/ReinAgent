/**
 * 粘贴路由纯逻辑测试（pasteRouting.ts）。
 * 运行：node --test src/lib/chat/pasteRouting.test.mjs（挂在 test:chat）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Node 直跑需 resolve 钩子补扩展名；bun 原生支持 .ts 且 1.4.x 无 registerHooks —— 动态导入 + 能力检测。
const { registerHooks } = await import("node:module");
if (typeof registerHooks === "function") registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
      const url = new URL(specifier, context.parentURL);
      if (!/\.[a-z0-9]+$/i.test(url.pathname)) {
        for (const ext of [".js", ".ts", ".mjs", ".json"]) {
          const candidate = new URL(url.href + ext);
          if (existsSync(fileURLToPath(candidate))) {
            return { url: candidate.href, shortCircuit: true };
          }
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const {
  classifyPaste,
  utf8ByteLength,
  createPastedTextFilename,
  LONG_PASTE_TEXT_THRESHOLD_CHARS,
  PASTED_TEXT_MAX_BYTES,
} = await import("./pasteRouting.ts");

const shape = (over) => ({ hasImageFile: false, textLength: 0, textBytes: 0, ...over });

test("classifyPaste：DOM 已交付图片时优先走图片路径（即便同时有文本）", () => {
  assert.equal(classifyPaste(shape({ hasImageFile: true })).kind, "image-file");
  assert.equal(
    classifyPaste(shape({ hasImageFile: true, textLength: 99999, textBytes: 99999 })).kind,
    "image-file",
  );
});

test("classifyPaste：15KB 阈值边界 14999 / 15000 / 15001", () => {
  const at = (n) => classifyPaste(shape({ textLength: n, textBytes: n })).kind;
  assert.equal(at(LONG_PASTE_TEXT_THRESHOLD_CHARS - 1), "plain");
  assert.equal(at(LONG_PASTE_TEXT_THRESHOLD_CHARS), "text-file");
  assert.equal(at(LONG_PASTE_TEXT_THRESHOLD_CHARS + 1), "text-file");
});

test("classifyPaste：10MB 上限边界（等于上限放行、超一字节报错）", () => {
  const at = (bytes) =>
    classifyPaste(shape({ textLength: LONG_PASTE_TEXT_THRESHOLD_CHARS, textBytes: bytes })).kind;
  assert.equal(at(PASTED_TEXT_MAX_BYTES), "text-file");
  assert.equal(at(PASTED_TEXT_MAX_BYTES + 1), "text-too-large");
});

test("classifyPaste：无图且无文本 → 原生读剪贴板兜底（WebKitGTK 位图形态）", () => {
  assert.equal(classifyPaste(shape({})).kind, "native-image");
});

test("classifyPaste：普通短文本不拦截", () => {
  assert.equal(classifyPaste(shape({ textLength: 10, textBytes: 20 })).kind, "plain");
});

test("utf8ByteLength：ASCII 与 CJK 口径", () => {
  assert.equal(utf8ByteLength("abc"), 3);
  assert.equal(utf8ByteLength("中文"), 6);
  assert.equal(utf8ByteLength(""), 0);
});

test("createPastedTextFilename：ZCode 同款命名", () => {
  assert.equal(
    createPastedTextFilename(new Date(2026, 9, 5, 19, 3, 7)),
    "pasted-text-20261005-190307.txt",
  );
});
