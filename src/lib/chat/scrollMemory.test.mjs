import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeScrollMemoryState,
  resolveScrollRestoreAction,
} from "./scrollMemory.ts";

describe("scrollMemory - 会话切换滚动记忆与底部跟随守护", () => {
  it("用户处于跟随态 (isFollowing=true) 时，保存状态必须标记 wasPinnedToBottom=true", () => {
    const memory = computeScrollMemoryState({
      isFollowing: true,
      scrollTop: 1000,
      scrollHeight: 1600,
      clientHeight: 600,
      topMsgId: "msg-old-1",
      topMsgOffset: 12,
    });
    assert.ok(memory, "应返回记忆对象");
    assert.equal(
      memory.wasPinnedToBottom,
      true,
      "在底部跟随态离开时，必须记录 wasPinnedToBottom=true，绝不能记成历史阅读锚点",
    );
  });

  it("用户滚动到底部阈值内 (<=80px) 时，保存状态必须标记 wasPinnedToBottom=true", () => {
    const memory = computeScrollMemoryState({
      isFollowing: false,
      scrollTop: 1550,
      scrollHeight: 2200,
      clientHeight: 600, // 2200 - 1550 - 600 = 50px <= 80px
      topMsgId: "msg-near-bottom",
      topMsgOffset: 0,
    });
    assert.ok(memory);
    assert.equal(
      memory.wasPinnedToBottom,
      true,
      "接近底部视为贴底，必须记录 wasPinnedToBottom=true",
    );
  });

  it("用户向上滚动查阅历史消息时，保存状态必须记录 wasPinnedToBottom=false 并保存锚点", () => {
    const memory = computeScrollMemoryState({
      isFollowing: false,
      scrollTop: 300,
      scrollHeight: 2200,
      clientHeight: 600, // 距底 1300px > 80px
      topMsgId: "msg-history-42",
      topMsgOffset: 18,
    });
    assert.ok(memory);
    assert.equal(memory.wasPinnedToBottom, false);
    assert.deepEqual(memory.anchor, { mid: "msg-history-42", off: 18 });
  });

  it("当前任务正在运行 (hasLiveTurn=true) 时，切回必须无条件贴底 (stick_bottom)，绝不能恢复旧锚点", () => {
    const action = resolveScrollRestoreAction({
      saved: {
        wasPinnedToBottom: false,
        anchor: { mid: "msg-historical-top", off: 0 },
      },
      hasLiveTurn: true,
    });
    assert.equal(
      action.type,
      "stick_bottom",
      "正在运行的任务产生新消息，切回必须跟随最新输出 (stick_bottom)，不能跳到上方旧消息",
    );
  });

  it("切出前记录为 wasPinnedToBottom=true 时，切回必须贴底 (stick_bottom)", () => {
    const action = resolveScrollRestoreAction({
      saved: {
        wasPinnedToBottom: true,
      },
      hasLiveTurn: false,
    });
    assert.equal(action.type, "stick_bottom");
  });

  it("切出前处于历史阅读位置且当前非运行态时，切回必须精准恢复锚点 (restore_anchor)", () => {
    const action = resolveScrollRestoreAction({
      saved: {
        wasPinnedToBottom: false,
        anchor: { mid: "msg-history-42", off: 18 },
      },
      hasLiveTurn: false,
    });
    assert.equal(action.type, "restore_anchor");
    assert.deepEqual(action.anchor, { mid: "msg-history-42", off: 18 });
  });

  it("无任何记忆时，默认贴底 (stick_bottom)", () => {
    const action = resolveScrollRestoreAction({
      saved: null,
      hasLiveTurn: false,
    });
    assert.equal(action.type, "stick_bottom");
  });
});
