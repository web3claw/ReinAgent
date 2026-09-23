import test from "node:test";
import assert from "node:assert/strict";
import {
  truncatePreview,
  buildNavigatorItems,
  resolveNavigatorLayout,
  resolveActiveAnchor,
  resolvePeakVisual,
  NAVIGATOR_DEFAULT_RAIL_HEIGHT,
  NAVIGATOR_MAX_SLOT,
  NAVIGATOR_MIN_SLOT,
} from "./conversationNavigatorHelpers.ts";

// ---- truncatePreview：对齐 ZCode 220 字符 / 2 段截断规则 ----

test("truncatePreview 折叠段内空白并按空行切段", () => {
  const raw = "第一段：你好\n  世界  多空格\t折叠\n\n第二段内容";
  assert.equal(truncatePreview(raw), "第一段：你好 世界 多空格 折叠\n第二段内容");
});

test("truncatePreview 只取前 2 段", () => {
  const raw = "段落一\n\n段落二\n\n段落三\n\n段落四";
  assert.equal(truncatePreview(raw), "段落一\n段落二");
});

test("truncatePreview 超 220 字符截断并以 ... 结尾", () => {
  const long = "字".repeat(300);
  const out = truncatePreview(long);
  assert.equal(out.length, 220);
  assert.ok(out.endsWith("..."));
  assert.equal(out.startsWith("字".repeat(217)), true);
});

test("truncatePreview 空输入返回空串", () => {
  assert.equal(truncatePreview(""), "");
});

// ---- buildNavigatorItems：用户提问粒度刻度 ----

const msg = (id, role, text, status = "done") => ({ id, role, text, status });

test("buildNavigatorItems 仅用户消息产生刻度，助手与工具不计", () => {
  const timeline = [
    msg("m1", "user", "第一个问题"),
    msg("m2", "assistant", "第一个回答"),
    msg("m3", "tool", ""),
    msg("m4", "assistant", "补充回答"),
    msg("m5", "user", "第二个问题"),
    msg("m6", "assistant", "第二个回答"),
  ];
  const items = buildNavigatorItems(timeline);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.msgId), ["m1", "m5"]);
});

test("buildNavigatorItems 助手预览取提问后首条 assistant，且不跨提问", () => {
  const timeline = [
    msg("u1", "user", "Q1"),
    msg("a1", "assistant", "A1"),
    msg("a2", "assistant", "A2 不应被取到"),
    msg("u2", "user", "Q2"),
    msg("t1", "tool", ""),
  ];
  const items = buildNavigatorItems(timeline);
  assert.equal(items[0].assistantPreview, "A1");
  assert.equal(items[1].assistantPreview, "");
  assert.equal(items[1].assistantRunning, false);
});

test("buildNavigatorItems 流式中的助手回复标记 running", () => {
  const timeline = [msg("u1", "user", "Q"), msg("a1", "assistant", "部分回答", "streaming")];
  const items = buildNavigatorItems(timeline);
  assert.equal(items[0].assistantRunning, true);
  assert.equal(items[0].assistantPreview, "部分回答");
});

// ---- resolveNavigatorLayout：240 初始高度 / [10,24] 自适应间距 / 超容量滚动 ----

test("resolveNavigatorLayout 零刻度返回零布局", () => {
  assert.deepEqual(resolveNavigatorLayout(0, 800), { slot: 0, railHeight: 0, scrollable: false });
});

test("resolveNavigatorLayout 少量刻度：最大间距 24，默认高度 240", () => {
  const layout = resolveNavigatorLayout(3, 1000);
  assert.equal(layout.slot, NAVIGATOR_MAX_SLOT);
  assert.equal(layout.railHeight, NAVIGATOR_DEFAULT_RAIL_HEIGHT);
  assert.equal(layout.scrollable, false);
});

test("resolveNavigatorLayout 恰好 10 枚：240/10=24 铺满", () => {
  const layout = resolveNavigatorLayout(10, 1000);
  assert.equal(layout.slot, 24);
  assert.equal(layout.scrollable, false);
});

test("resolveNavigatorLayout 11~24 枚：间距线性压缩", () => {
  const layout = resolveNavigatorLayout(20, 1000);
  assert.equal(layout.slot, 12);
  assert.equal(layout.scrollable, false);
});

test("resolveNavigatorLayout 超过 24 枚：锁定最小间距 10px 并进入内部滚动", () => {
  const layout = resolveNavigatorLayout(30, 1000);
  assert.equal(layout.slot, NAVIGATOR_MIN_SLOT);
  assert.equal(layout.railHeight, NAVIGATOR_DEFAULT_RAIL_HEIGHT);
  assert.equal(layout.scrollable, true);
});

test("resolveNavigatorLayout 容器不足时目标高度封顶为可用高度", () => {
  const roomy = resolveNavigatorLayout(5, 100);
  assert.equal(roomy.slot, 20);
  assert.equal(roomy.railHeight, 100);
  assert.equal(roomy.scrollable, false);

  const tight = resolveNavigatorLayout(15, 100);
  assert.equal(tight.slot, NAVIGATOR_MIN_SLOT);
  assert.equal(tight.scrollable, true);
});

test("resolveNavigatorLayout 可用高度非法时回退默认高度", () => {
  const layout = resolveNavigatorLayout(4, 0);
  assert.equal(layout.railHeight, NAVIGATOR_DEFAULT_RAIL_HEIGHT);
  assert.equal(layout.slot, NAVIGATOR_MAX_SLOT);
});

// ---- resolveActiveAnchor：几何判定（无 IntersectionObserver） ----

test("resolveActiveAnchor 取视口内最靠顶的相交刻度", () => {
  const starts = [0, 300, 900];
  assert.equal(resolveActiveAnchor(starts, 0, 600), 0);
  assert.equal(resolveActiveAnchor(starts, 350, 600), 1);
  assert.equal(resolveActiveAnchor(starts, 950, 600), 2);
});

test("resolveActiveAnchor 全部滚出视口时回退视口顶上方最近一条", () => {
  assert.equal(resolveActiveAnchor([0, 100], 5000, 600), 1);
});

test("resolveActiveAnchor 空数组返回 -1", () => {
  assert.equal(resolveActiveAnchor([], 0, 600), -1);
});

// ---- resolvePeakVisual：山峰衰减参数对齐 ZCode ----

test("resolvePeakVisual 距离衰减 2.6/1.7/1.25，远处回落 1/0.58，方向对称", () => {
  assert.deepEqual(resolvePeakVisual(0), { scaleX: 2.6, opacity: 1 });
  assert.deepEqual(resolvePeakVisual(1), { scaleX: 1.7, opacity: 0.86 });
  assert.deepEqual(resolvePeakVisual(-1), { scaleX: 1.7, opacity: 0.86 });
  assert.deepEqual(resolvePeakVisual(2), { scaleX: 1.25, opacity: 0.72 });
  assert.deepEqual(resolvePeakVisual(5), { scaleX: 1, opacity: 0.58 });
});
