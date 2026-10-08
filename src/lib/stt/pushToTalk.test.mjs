/**
 * push-to-talk 按键判定测试（pushToTalk.ts）。
 * 运行：node --test src/lib/stt/pushToTalk.test.mjs
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
          if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const { isPushToTalkKey } = await import("./pushToTalk.ts");

test("物理键位 ControlRight 命中（与键盘布局无关）", () => {
  assert.equal(isPushToTalkKey({ key: "Control", code: "ControlRight", location: 2 }), true);
  // 即便 key/location 缺失（部分环境），只要 code 正确就命中
  assert.equal(isPushToTalkKey({ key: "Unidentified", code: "ControlRight", location: 0 }), true);
});

test("code 缺失时回退 key+location=2（右侧修饰键）", () => {
  assert.equal(isPushToTalkKey({ key: "Control", code: "Unidentified", location: 2 }), true);
  assert.equal(isPushToTalkKey({ key: "Control", code: "", location: 2 }), true);
});

test("左 Ctrl / 右侧非 Ctrl 键不命中", () => {
  assert.equal(isPushToTalkKey({ key: "Control", code: "ControlLeft", location: 1 }), false);
  assert.equal(isPushToTalkKey({ key: "Control", code: "Unidentified", location: 1 }), false);
  assert.equal(isPushToTalkKey({ key: "Shift", code: "ShiftRight", location: 2 }), false);
  assert.equal(isPushToTalkKey({ key: "a", code: "KeyA", location: 0 }), false);
});
