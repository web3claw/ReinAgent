import { test } from "node:test";
import assert from "node:assert/strict";
import { findInTimeline } from "./useConversationFind.ts";

const msg = (id, role, text, extra = {}) => ({ id, role, text, thinking: "", status: "done", ...extra });

test("findInTimeline：命中聚合到消息（正文/思考/工具结果），大小写不敏感，计数正确", () => {
  const messages = [
    msg("u1", "user", "帮我看看 FooBar 的实现"),
    msg("a1", "assistant", "foobar 出现在这里两次 foobar"),
    msg("t1", "tool", "", { toolName: "grep", resultText: "src/foobar.ts:1" }),
    msg("a2", "assistant", "无关内容"),
  ];
  const hits = findInTimeline(messages, "foobar");
  assert.equal(hits.length, 3, "三条消息命中");
  assert.equal(hits[0].messageId, "u1");
  assert.equal(hits[1].count, 2, "a1 内两次");
  assert.deepEqual(hits[2].fields, ["toolResult"]);
  assert.deepEqual(findInTimeline(messages, "  ").length, 0);
  assert.deepEqual(findInTimeline(messages, "不存在词").length, 0);
});
