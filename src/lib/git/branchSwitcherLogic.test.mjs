import { test } from "node:test";
import assert from "node:assert/strict";
const {
  resolveBranchTriggerLabel,
  matchesBranchSearch,
  getPrimaryIssue,
  isCommitAssistIssue,
  resolveIssueMessageKey,
  resolveSuccessMessageKey,
  summarizeIssuePaths,
  selectAffectedFiles,
  getCommitTotals,
  buildAutoCommitMessage,
  hasCommitIdentity,
} = await import("./branchSwitcherLogic.ts");

test("触发器文案：detached 优先、空名回退「分支」", () => {
  assert.equal(
    resolveBranchTriggerLabel({
      headDetached: true,
      currentBranchName: null,
      detachedLabel: "Detached HEAD",
      fallbackLabel: "分支",
    }),
    "Detached HEAD",
  );
  assert.equal(
    resolveBranchTriggerLabel({
      headDetached: false,
      currentBranchName: "  ",
      detachedLabel: "Detached HEAD",
      fallbackLabel: "分支",
    }),
    "分支",
  );
  assert.equal(
    resolveBranchTriggerLabel({
      headDetached: false,
      currentBranchName: "feat/ui",
      detachedLabel: "Detached HEAD",
      fallbackLabel: "分支",
    }),
    "feat/ui",
  );
});

test("搜索过滤：大小写不敏感 includes、空串全过", () => {
  assert.equal(matchesBranchSearch("Feature/X", "feature"), true);
  assert.equal(matchesBranchSearch("main", "MAI"), true);
  assert.equal(matchesBranchSearch("main", "zzz"), false);
  assert.equal(matchesBranchSearch("main", "  "), true);
});

test("issue 归因：overwrite 走切换助手、已知码有 i18n key、未知码返回 null", () => {
  assert.equal(isCommitAssistIssue("tracked-changes-would-be-overwritten"), true);
  assert.equal(isCommitAssistIssue("untracked-changes-would-be-overwritten"), true);
  assert.equal(isCommitAssistIssue("conflicts-present"), false);

  assert.equal(resolveIssueMessageKey({ code: "branch-already-exists", message: "" }), "gitBranchErrAlreadyExists");
  assert.equal(resolveIssueMessageKey({ code: "operation-in-progress", message: "" }), "gitBranchErrOperationInProgress");
  assert.equal(resolveIssueMessageKey({ code: "something-new", message: "" }), null);
  assert.equal(getPrimaryIssue([]), null);
  assert.equal(getPrimaryIssue([{ code: "unknown", message: "x" }])?.code, "unknown");
});

test("成功 toast 选择：no-op 不弹、创建与切换区分", () => {
  assert.equal(resolveSuccessMessageKey({ action: "switch", created: false, didChange: false }), null);
  assert.equal(
    resolveSuccessMessageKey({ action: "switch", created: false, didChange: true }),
    "gitBranchToastSwitchSuccess",
  );
  assert.equal(
    resolveSuccessMessageKey({ action: "create-and-switch", created: true, didChange: true }),
    "gitBranchToastCreateSuccess",
  );
});

test("路径截断：最多展示 2 个 + 剩余计数", () => {
  const { visiblePaths, remainingCount } = summarizeIssuePaths(["a.ts", "b.ts", "c.ts", "d.ts"]);
  assert.deepEqual(visiblePaths, ["a.ts", "b.ts"]);
  assert.equal(remainingCount, 2);
  assert.deepEqual(summarizeIssuePaths(undefined).visiblePaths, []);
});

test("受影响文件：issue paths 主序、numstat 行数合并、缺失占位 0/0", () => {
  const files = [
    { path: "a.ts", added: 3, removed: 1 },
    { path: "b.ts", added: 0, removed: 9 },
  ];
  const affected = selectAffectedFiles({ files, issuePaths: ["b.ts", "zzz.ts"] });
  assert.deepEqual(affected, [
    { path: "b.ts", added: 0, removed: 9 },
    { path: "zzz.ts", added: 0, removed: 0 },
  ]);
  const totals = getCommitTotals(affected);
  assert.deepEqual(totals, { fileCount: 2, totalAdded: 0, totalRemoved: 9 });
});

test("checkpoint 自动提交信息与身份守卫", () => {
  assert.equal(buildAutoCommitMessage("feat/x"), "chore: checkpoint before switching to feat/x");
  assert.equal(buildAutoCommitMessage("  "), "chore: checkpoint before switching branches");

  assert.equal(hasCommitIdentity(null), true, "读不到配置时放行由 git 兜底报错");
  assert.equal(hasCommitIdentity({ userName: "a", userEmail: "b@c" }), true);
  assert.equal(hasCommitIdentity({ userName: "a", userEmail: null }), false);
});
