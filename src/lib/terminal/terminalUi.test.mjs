/**
 * 终端 tab 条 + 主题读取纯逻辑测试（tabStrip.ts / terminalTheme.ts）。
 * 运行：node --test src/lib/terminal/terminalUi.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Node 直跑需 resolve 钩子补扩展名（bun 原生支持 .ts）。
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

const { moveTabToIndex, tabIndexAtX, decideTabClose } = await import("./tabStrip.ts");
const { readTerminalTheme } = await import("./terminalTheme.ts");

const tabs = (...ids) => ids.map((id) => ({ id }));

test("moveTabToIndex：向右拖（拖 A 到槽 2 → [B,C,A,D]，A 占据 C 原视觉位）", () => {
  assert.deepEqual(
    moveTabToIndex(tabs("a", "b", "c", "d"), "a", 2).map((t) => t.id),
    ["b", "c", "a", "d"],
  );
});

test("moveTabToIndex：向左拖（拖 D 到槽 1 → [A,D,B,C]）", () => {
  assert.deepEqual(
    moveTabToIndex(tabs("a", "b", "c", "d"), "d", 1).map((t) => t.id),
    ["a", "d", "b", "c"],
  );
});

test("moveTabToIndex：原地/未知 id/单 tab 返回原引用（React 跳过更新）", () => {
  const list = tabs("a", "b", "c");
  assert.equal(moveTabToIndex(list, "b", 1), list, "原地不动");
  assert.equal(moveTabToIndex(list, "zzz", 0), list, "未知 id");
  const single = tabs("a");
  assert.equal(moveTabToIndex(single, "a", 0), single, "单 tab");
});

test("moveTabToIndex：越界目标收敛到两端", () => {
  assert.deepEqual(
    moveTabToIndex(tabs("a", "b", "c"), "a", 99).map((t) => t.id),
    ["b", "c", "a"],
  );
  assert.deepEqual(
    moveTabToIndex(tabs("a", "b", "c"), "c", -5).map((t) => t.id),
    ["c", "a", "b"],
  );
});

test("tabIndexAtX：命中槽位 / 左右越界收敛", () => {
  const slots = [
    { id: "a", left: 0, right: 50 },
    { id: "b", left: 60, right: 110 },
  ];
  assert.equal(tabIndexAtX(slots, 25), 0);
  assert.equal(tabIndexAtX(slots, 80), 1);
  assert.equal(tabIndexAtX(slots, -10), 0, "左侧超出 = 首位");
  assert.equal(tabIndexAtX(slots, 500), 1, "右侧超出 = 末位");
  assert.equal(tabIndexAtX(slots, 55), 1, "缝隙归右侧最近槽");
  assert.equal(tabIndexAtX([], 10), -1, "空列表");
});

test("decideTabClose：关闭活动且存活 → confirm；非活动/断开 → direct", () => {
  assert.equal(
    decideTabClose({ activeTabId: "t1", closingTabId: "t1", sessionAlive: true }),
    "confirm",
  );
  assert.equal(
    decideTabClose({ activeTabId: "t1", closingTabId: "t2", sessionAlive: true }),
    "direct",
    "非活动 tab 无存活会话",
  );
  assert.equal(
    decideTabClose({ activeTabId: "t1", closingTabId: "t1", sessionAlive: false }),
    "direct",
    "会话已断开不打扰",
  );
});

test("readTerminalTheme：按 --terminal-{theme}-{kebab} 解析；深色前景绿、浅色前景黑", () => {
  const fake = {
    getPropertyValue(prop) {
      const map = {
        "--terminal-dark-background": "#0b0f14",
        "--terminal-dark-foreground": "#4ade80",
        "--terminal-dark-bright-green": "#4ade80",
        "--terminal-dark-cursor-accent": " #0b0f14 ",
        "--terminal-light-foreground": "#000000",
      };
      return map[prop] ?? "";
    },
  };
  const dark = readTerminalTheme("dark", fake);
  assert.equal(dark.background, "#0b0f14");
  assert.equal(dark.foreground, "#4ade80", "深色前景 = LiveAgent 绿字");
  assert.equal(dark.brightGreen, "#4ade80", "kebab 键名映射（bright-green）");
  assert.equal(dark.cursorAccent, "#0b0f14", "值 trim");
  assert.equal(dark.red, "", "缺 token 回退空串（不猜色）");
  const light = readTerminalTheme("light", fake);
  assert.equal(light.foreground, "#000000", "浅色前景 = 用户定稿黑字");
});
