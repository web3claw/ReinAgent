/**
 * worktree TS 纯函数测试：决议单点回退语义。
 * 运行：node --test src/lib/worktree/worktree.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { resolveTaskEffectiveRoot } = await import("./resolve.ts");

test("resolveTaskEffectiveRoot：开启且有路径 → worktree 路径", () => {
  assert.equal(
    resolveTaskEffectiveRoot({ worktreeEnabled: true, worktreePath: "D:/.reinagent-worktrees/repo/task-1" }, "D:/repo"),
    "D:/.reinagent-worktrees/repo/task-1",
  );
});

test("resolveTaskEffectiveRoot：关闭 / 未建 / 未开启 → 回退主工作区", () => {
  assert.equal(resolveTaskEffectiveRoot({ worktreeEnabled: false, worktreePath: "/wt" }, "D:/repo"), "D:/repo");
  assert.equal(resolveTaskEffectiveRoot({ worktreeEnabled: true, worktreePath: undefined }, "D:/repo"), "D:/repo");
  assert.equal(resolveTaskEffectiveRoot(null, "D:/repo"), "D:/repo");
  assert.equal(resolveTaskEffectiveRoot(undefined, "D:/repo"), "D:/repo");
});
