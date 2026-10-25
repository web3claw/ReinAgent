/**
 * PR 面板纯展示逻辑验证（node:test）。
 * 运行：node --test src/lib/git/prLogic.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeStateKey,
  reviewKey,
  mergeBlocked,
  checkBucketClass,
  buildPrHandoffPrompt,
} from "./prLogic.ts";

test("mergeStateKey：CONFLICTING 一票否决优先于门禁状态", () => {
  assert.equal(mergeStateKey("CLEAN", "CONFLICTING"), "conflicting");
  assert.equal(mergeStateKey("CLEAN", "MERGEABLE"), "clean");
  assert.equal(mergeStateKey("DIRTY", ""), "conflicting");
  assert.equal(mergeStateKey("BEHIND", "MERGEABLE"), "behind");
  assert.equal(mergeStateKey(null, undefined), "unknown");
});

test("reviewKey：空/未给全归 pending", () => {
  assert.equal(reviewKey("APPROVED"), "approved");
  assert.equal(reviewKey("CHANGES_REQUESTED"), "changesRequested");
  assert.equal(reviewKey("REVIEW_REQUIRED"), "reviewRequired");
  assert.equal(reviewKey(null), "pending");
  assert.equal(reviewKey(""), "pending");
});

test("mergeBlocked：非 clean 门禁或要求修改即禁用", () => {
  assert.equal(mergeBlocked("CLEAN", "MERGEABLE", null), false);
  assert.equal(mergeBlocked("CLEAN", "MERGEABLE", "APPROVED"), false);
  assert.equal(mergeBlocked("UNSTABLE", "MERGEABLE", "APPROVED"), true);
  assert.equal(mergeBlocked("CLEAN", "MERGEABLE", "CHANGES_REQUESTED"), true);
  assert.equal(mergeBlocked("CLEAN", "CONFLICTING", "APPROVED"), true);
});

test("checkBucketClass：四桶分色类名互不相同", () => {
  const classes = ["pass", "fail", "pending", "cancel"].map(checkBucketClass);
  assert.equal(new Set(classes).size, 4);
});

test("buildPrHandoffPrompt：包含状态/CI/意见/日志四段与修复指令", () => {
  const prompt = buildPrHandoffPrompt({
    number: 3,
    title: "修复登录",
    url: "https://github.com/o/r/pull/3",
    mergeable: "MERGEABLE",
    mergeStateStatus: "UNSTABLE",
    reviewDecision: "CHANGES_REQUESTED",
    additions: 12,
    deletions: 5,
    changedFiles: 4,
    checks: [
      { name: "build", workflow: null, state: "FAILURE", bucket: "fail", link: "https://github.com/o/r/actions/runs/9" },
      { name: "lint", workflow: null, state: "PENDING", bucket: "pending", link: null },
    ],
    comments: [
      { author: "alice", body: "这里要判空", path: "src/a.rs", line: 12, kind: "review", createdAt: "2026-10-25T00:00:00Z" },
      { author: "bob", body: "总体方向 OK", path: null, line: null, kind: "review-summary", createdAt: "2026-10-25T01:00:00Z" },
    ],
    logExcerpt: "error: unresolved import",
  });
  assert.ok(prompt.includes("#3"));
  assert.ok(prompt.includes("unstable"));
  assert.ok(prompt.includes("changesRequested"));
  assert.ok(prompt.includes("[src/a.rs:12] alice"));
  assert.ok(prompt.includes("error: unresolved import"));
  assert.ok(prompt.includes("不要创建新 PR"));
});
