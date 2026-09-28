import test from "node:test";
import assert from "node:assert/strict";
import {
  appliedBatchCount,
  buildManualApplyState,
  createEmptyRunReport,
  isDefaultSelectedDecision,
  isOrganizeRunReportV4,
  organizerDecisionKey,
  readRunReport,
} from "./runRecord.ts";

// ---- v4 round-trip ----

test("createEmptyRunReport 产出合法 v4 报告且原样往返", () => {
  const report = createEmptyRunReport();
  assert.equal(report.version, 4);
  assert.equal(isOrganizeRunReportV4(report), true);
  const run = { runId: "r1", report };
  assert.equal(readRunReport(run), report, "v4 报告引用原样透传，不重建");
});

test("完整 v4 报告（含 safeDecisions/rejectionBuckets/forecast/manualApplyState）通过校验", () => {
  const report = {
    version: 4,
    clusterSummaries: ["cluster A", "cluster B"],
    reviewItems: [
      {
        phase: "planning",
        kind: "review",
        severity: "warning",
        message: "needs review",
      },
    ],
    raw: [{ clusterId: "c1", text: "raw model output" }],
    safeDecisions: [
      {
        op: "delete",
        slug: "old-note",
        scope: "global",
        riskLevel: "low",
        requiresUserAck: false,
      },
    ],
    rejectionBuckets: {
      reviewedProtected: 1,
      lowConfidence: 2,
      crossType: 0,
      crossScope: 0,
      reviewRequiredByLlm: 0,
      missingPayload: 0,
      unsupported: 0,
    },
    compressionForecast: { from: 100, toMin: 40, toMax: 60 },
    manualApplyState: {
      status: "applied",
      appliedAt: 1_000,
      appliedDecisionKeys: ["k1"],
      failedDecisionKeys: [],
    },
  };
  assert.equal(isOrganizeRunReportV4(report), true);
  assert.equal(readRunReport({ report }), report);
});

test("v4 校验拒绝坏字段（version/kind/缺 bucket）", () => {
  assert.equal(isOrganizeRunReportV4({ ...createEmptyRunReport(), version: 3 }), false);
  assert.equal(
    isOrganizeRunReportV4({
      ...createEmptyRunReport(),
      reviewItems: [{ phase: "nope", kind: "review", severity: "info", message: "x" }],
    }),
    false,
  );
  assert.equal(
    isOrganizeRunReportV4({
      ...createEmptyRunReport(),
      rejectionBuckets: { reviewedProtected: 1 },
    }),
    false,
  );
  assert.equal(isOrganizeRunReportV4({ report: null }), false);
});

// ---- legacy 降级 ----

test("非记录 / 缺 report → 空 legacy 视图", () => {
  assert.deepEqual(readRunReport(null), {
    version: "legacy",
    clusterSummaries: [],
    reviewItems: [],
  });
  assert.deepEqual(readRunReport({}), {
    version: "legacy",
    clusterSummaries: [],
    reviewItems: [],
  });
});

test("pre-v4 blob 降级：保留 clusterSummaries，reviewNotes 映射为 warning 项", () => {
  const report = readRunReport({
    report: { version: 3, clusterSummaries: ["c1"], reviewNotes: ["n1", "n2"] },
  });
  assert.equal(report.version, "legacy");
  assert.deepEqual(report.clusterSummaries, ["c1"]);
  assert.equal(report.reviewItems.length, 2);
  assert.equal(report.reviewItems[0].message, "n1");
  assert.equal(report.reviewItems[0].phase, "planning");
  assert.equal(report.reviewItems[0].kind, "review");
  assert.equal(report.reviewItems[0].severity, "warning");
});

test("v4 校验失败的 report 也走 legacy 降级", () => {
  const report = readRunReport({
    report: { version: 4, clusterSummaries: ["c"], reviewItems: "corrupted" },
  });
  assert.equal(report.version, "legacy");
  assert.deepEqual(report.clusterSummaries, ["c"]);
});

// ---- 决策辅助纯函数 ----

test("organizerDecisionKey 由 index/op/scope/workdirHash/slug 组成", () => {
  assert.equal(
    organizerDecisionKey({ op: "delete", slug: "s1" }, 3),
    "3:delete:::s1",
  );
  assert.equal(
    organizerDecisionKey({ op: "upsert", slug: "s2", scope: "project", workdirHash: "h" }, 0),
    "0:upsert:project:h:s2",
  );
});

test("isDefaultSelectedDecision：仅低风险且不要求确认的决策默认选中", () => {
  assert.equal(isDefaultSelectedDecision({ op: "delete", slug: "s" }), true);
  assert.equal(isDefaultSelectedDecision({ op: "delete", slug: "s", riskLevel: "high" }), false);
  assert.equal(isDefaultSelectedDecision({ op: "delete", slug: "s", requiresUserAck: true }), false);
});

test("appliedBatchCount 与 buildManualApplyState 状态推导", () => {
  assert.equal(appliedBatchCount({ created: ["a"], updated: [], deleted: ["b", "c"] }), 3);

  const clean = buildManualApplyState({
    selectedCount: 2,
    appliedCount: 2,
    warningCount: 0,
    appliedDecisionKeys: ["k1", "k2"],
    failedDecisionKeys: [],
  });
  assert.equal(clean.status, "applied");

  const partial = buildManualApplyState({
    selectedCount: 2,
    appliedCount: 1,
    warningCount: 1,
    appliedDecisionKeys: ["k1"],
    failedDecisionKeys: ["k2"],
  });
  assert.equal(partial.status, "partial");

  const failed = buildManualApplyState({
    selectedCount: 1,
    appliedCount: 0,
    warningCount: 2,
    appliedDecisionKeys: [],
    failedDecisionKeys: ["k1"],
  });
  assert.equal(failed.status, "failed");
});
