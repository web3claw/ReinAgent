/**
 * settingsStore 的自动化验证（S3）。
 *
 * 重点验证「优雅降级」：后端不可用时退化为内存、不抛异常、给出警示。
 *
 * 运行：node --test src/lib/settings/settingsStore.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createSettingsStore, normalizeSettings } from "./settingsStore.js";

const DEFAULTS = { apiKey: "", modelId: "deepseek-flash", baseUrl: "" };

test("持久化可用：load 读回归一化设置，save 写回并返回 true", async () => {
  let disk;
  const written = [];
  const store = createSettingsStore({
    read: async () => disk,
    write: async (value) => {
      written.push(value);
      disk = value;
    },
    defaults: DEFAULTS,
  });

  // 初始磁盘为空 → 得到默认值，未降级。
  let loaded = await store.load();
  assert.deepEqual(loaded, DEFAULTS);
  assert.equal(store.degraded, false);
  assert.equal(store.backendKind, "persistent");
  assert.equal(store.warning, null);

  // 保存后写回磁盘，且可再次读出。
  const ok = await store.save({ apiKey: "sk-abc", modelId: "deepseek-v4-pro", baseUrl: "https://api.deepseek.com" });
  assert.equal(ok, true);
  assert.equal(written.length, 1);
  loaded = await store.load();
  assert.equal(loaded.apiKey, "sk-abc");
  assert.equal(loaded.modelId, "deepseek-v4-pro");
  assert.equal(loaded.baseUrl, "https://api.deepseek.com");
  assert.equal(store.degraded, false);
});

test("降级：读后端不可用 → 退化为内存、不抛异常、给出警示（只提示一次）", async () => {
  const warns = [];
  const store = createSettingsStore({
    read: async () => {
      throw new Error("plugin-store 不可用（无 Tauri 环境）");
    },
    write: async () => {
      throw new Error("plugin-store 不可用");
    },
    defaults: DEFAULTS,
    warn: (message) => warns.push(message),
  });

  // 关键：不抛异常，返回默认值。
  const loaded = await store.load();
  assert.deepEqual(loaded, DEFAULTS, "读失败应回退到默认值");
  assert.equal(store.degraded, true);
  assert.equal(store.backendKind, "memory");
  assert.ok(store.warning && /内存/.test(store.warning), `应给出内存降级警示，实际：${store.warning}`);
  assert.equal(warns.length, 1, "warn 回调只应被触发一次");

  // 写失败：保留内存值 + 返回 false + 原警示不被覆盖。
  const ok = await store.save({ apiKey: "sk-x" });
  assert.equal(ok, false);
  assert.equal(store.snapshot().apiKey, "sk-x", "内存中仍应保留新值");
  assert.ok(/内存/.test(store.warning));
  assert.equal(warns.length, 1, "已有警示不应重复叠加");
});

test("降级：仅写失败也应给警示且保留内存值", async () => {
  const store = createSettingsStore({
    read: async () => DEFAULTS,
    write: async () => {
      throw new Error("disk full");
    },
    defaults: DEFAULTS,
  });

  await store.load();
  assert.equal(store.degraded, false, "仅读成功时不应降级");

  const ok = await store.save({ modelId: "deepseek-v4-pro" });
  assert.equal(ok, false);
  assert.equal(store.degraded, true);
  assert.ok(store.warning && /保存失败/.test(store.warning));
  assert.equal(store.snapshot().modelId, "deepseek-v4-pro");
});

test("normalizeSettings：只保留已知字段、类型不符回退默认、过滤脏数据", () => {
  const out = normalizeSettings({ apiKey: "k", modelId: 123, extra: "x" }, DEFAULTS);
  assert.equal(out.apiKey, "k");
  assert.equal(out.modelId, DEFAULTS.modelId, "非字符串字段应回退默认");
  assert.equal(out.baseUrl, DEFAULTS.baseUrl);
  assert.equal(Object.prototype.hasOwnProperty.call(out, "extra"), false, "未知字段不应保留");

  assert.deepEqual(normalizeSettings(null, DEFAULTS), DEFAULTS);
  assert.deepEqual(normalizeSettings("nope", DEFAULTS), DEFAULTS);
  assert.deepEqual(normalizeSettings(undefined, DEFAULTS), DEFAULTS);
});

test("normalizeSettings：apiKey 去前后空白（避免粘贴带空白导致必然 401）", () => {
  // 常见粘贴形态：前后空格。
  assert.equal(normalizeSettings({ apiKey: "  sk-x  " }, DEFAULTS).apiKey, "sk-x");
  // 含换行/制表符。
  assert.equal(normalizeSettings({ apiKey: "\n\t sk-live \t\n" }, DEFAULTS).apiKey, "sk-live");
  // 中间空白不动（Key 内部不应有空白，但这里只保证不误伤首尾）。
  assert.equal(normalizeSettings({ apiKey: "sk-a-b" }, DEFAULTS).apiKey, "sk-a-b");

  // 全空白 → 归一化为空串：上层据此判定「演示模式」，
  // 绝不能因为「字符串非空」而去发一个注定 401 的请求。
  assert.equal(normalizeSettings({ apiKey: "   " }, DEFAULTS).apiKey, "");
  assert.equal(normalizeSettings({ apiKey: "\t\n " }, DEFAULTS).apiKey, "");

  // 缺失/非字符串 → 仍取默认（空串）。
  assert.equal(normalizeSettings({}, DEFAULTS).apiKey, "");
  assert.equal(normalizeSettings({ apiKey: 123 }, DEFAULTS).apiKey, DEFAULTS.apiKey);
});

test("normalizeSettings 与演示模式判定一致：全空白 Key 经归一化后 trim 仍为空", () => {
  // 复刻 App.tsx 的判定：settings.apiKey.trim().length === 0 → 演示模式。
  const fromWhitespace = normalizeSettings({ apiKey: "  \n  " }, DEFAULTS);
  assert.equal(fromWhitespace.apiKey.trim().length, 0, "全空白 Key 应稳定判定为演示模式");
  const fromReal = normalizeSettings({ apiKey: "  sk-real  " }, DEFAULTS);
  assert.ok(fromReal.apiKey.trim().length > 0, "真实 Key 归一化后应非空");
});
