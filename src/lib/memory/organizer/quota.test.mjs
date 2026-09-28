import test from "node:test";
import assert from "node:assert/strict";
import { deriveQuotaLadder } from "./quota.ts";

const scope = (overrides = {}) => ({
  scope: "global",
  workdirHash: "h1",
  used: 400,
  limit: 500,
  headroom: 100,
  archivedCount: 0,
  unreviewedCount: 0,
  ...overrides,
});

test("空摘要或无 scope → normal", () => {
  assert.deepEqual(deriveQuotaLadder(null), { level: "normal" });
  assert.deepEqual(deriveQuotaLadder({ scopes: [] }), { level: "normal" });
});

test("配额分级：headroom 100/50/20/5 四档阈值", () => {
  assert.equal(deriveQuotaLadder({ scopes: [scope({ headroom: 101 })] }).level, "normal");
  assert.equal(deriveQuotaLadder({ scopes: [scope({ headroom: 100 })] }).level, "notice");
  assert.equal(deriveQuotaLadder({ scopes: [scope({ headroom: 50 })] }).level, "degraded");
  assert.equal(deriveQuotaLadder({ scopes: [scope({ headroom: 20 })] }).level, "critical");
  assert.equal(deriveQuotaLadder({ scopes: [scope({ headroom: 5 })] }).level, "exhausted");
  assert.equal(deriveQuotaLadder({ scopes: [scope({ headroom: 0 })] }).level, "exhausted");
});

test("取 headroom 最小的 scope 作为最紧 scope，并推导压缩目标与横幅", () => {
  const ladder = deriveQuotaLadder({
    scopes: [scope({ scope: "project", headroom: 120 }), scope({ scope: "global", headroom: 30 })],
  });
  assert.equal(ladder.level, "degraded");
  assert.equal(ladder.tightestScope.scope, "global");
  assert.equal(ladder.compressionTarget, 400, "压缩目标 = limit - notice 阈值");
  assert.equal(ladder.bannerKey, "settings.memoryQuotaDegraded");
});

test("normal 档不产出压缩目标与横幅", () => {
  const ladder = deriveQuotaLadder({ scopes: [scope({ headroom: 250 })] });
  assert.equal(ladder.level, "normal");
  assert.equal(ladder.compressionTarget, undefined);
  assert.equal(ladder.bannerKey, undefined);
  assert.ok(ladder.tightestScope);
});
