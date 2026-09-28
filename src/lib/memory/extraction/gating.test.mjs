/**
 * 记忆抽取门控单测（P1-8）：空/过短/问候/致谢/节流/确认词 bypass。
 * 运行：bun test src/lib/memory/extraction/gating.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractionSkipReason, graphemeLength, isShortMemoryConfirmationText } from "./gating.ts";

const T0 = 1_000_000_000;

test("门控：空消息 / 纯标点 / 过短 / 问候 / 致谢 / 收到", () => {
  assert.equal(extractionSkipReason({ latestUserText: "", now: T0 }), "empty-user-message");
  assert.equal(
    extractionSkipReason({ latestUserText: "!!!。。。", now: T0 }),
    "punctuation-only-user-message",
  );
  assert.equal(extractionSkipReason({ latestUserText: "好", now: T0 }), "user-message-too-short");
  // 「你好」2 字素先被长度门控拒（同为 skip，语义一致）；长问候才走 greeting 前缀分支
  assert.equal(extractionSkipReason({ latestUserText: "你好", now: T0 }), "user-message-too-short");
  assert.equal(extractionSkipReason({ latestUserText: "你好呀，好久不见的朋友", now: T0 }), "greeting");
  assert.equal(
    extractionSkipReason({ latestUserText: "谢谢你帮大忙了，以后就这么干", now: T0 }),
    "acknowledgement-thanks",
  );
  // 「收到」2 字素同走长度门控（skip 等价）；长「收到」型回复走 ack 分支
  assert.equal(extractionSkipReason({ latestUserText: "收到", now: T0 }), "user-message-too-short");
  assert.equal(
    extractionSkipReason({ latestUserText: "收到了，就这么执行", now: T0 }),
    "acknowledgement-ok",
  );
});

test("门控：30s 节流与同一用户消息不重抽", () => {
  assert.equal(
    extractionSkipReason({
      latestUserText: "请记住我偏好用中文回复",
      lastRunAt: T0,
      now: T0 + 5_000,
    }),
    "throttled-min-interval",
  );
  const key = "12:请记住我偏好:偏好";
  assert.equal(
    extractionSkipReason({
      latestUserText: "请记住我偏好",
      lastRunAt: T0,
      now: T0 + 60_000,
      lastExtractedUserKey: key,
      currentUserKey: key,
    }),
    "no-new-user-message",
  );
});

test("门控：正常长消息放行；短确认词 bypass 长度门控", () => {
  assert.equal(
    extractionSkipReason({
      latestUserText: "以后跑测试前先 lint，这是团队规范",
      now: T0,
    }),
    null,
  );
  // 「对」本身过短，但可能是对记忆确认问题的回答 → 不在纯长度门控处拒绝
  assert.equal(isShortMemoryConfirmationText("对"), true);
  assert.equal(isShortMemoryConfirmationText("yes"), true);
  assert.equal(isShortMemoryConfirmationText("随便聊聊"), false);
  assert.equal(
    extractionSkipReason({ latestUserText: "对", hasConfirmableHypothesis: true, now: T0 }),
    null,
    "短确认词 + 可确认候选 → 放行（defer 到引擎裁决）",
  );
});

test("graphemeLength：CJK 与 emoji 按字素计", () => {
  assert.equal(graphemeLength("中文两字"), 4);
  assert.ok(graphemeLength("👍👍") === 2, "emoji 组合字素");
});
