import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectSkillSourceKind,
  checkSingleSkillUpdate,
  checkAllSkillsUpdate,
  applySkillUpdate,
} from "./skillUpdateTracker.ts";

describe("skillUpdateTracker (上游更新检查单元测试)", () => {
  it("1 · detectSkillSourceKind 精准识别 4 种技能来源", () => {
    // 1. builtin
    assert.equal(detectSkillSourceKind({ name: "grill-me", builtIn: true, skillFile: "", baseDir: "", description: "" }), "builtin");

    // 2. clawhub / skills.sh
    assert.equal(
      detectSkillSourceKind({
        name: "test-hub",
        source: { registry: "clawhub", slug: "test-hub" },
        skillFile: "",
        baseDir: "",
        description: "",
      }),
      "clawhub",
    );
    assert.equal(
      detectSkillSourceKind({
        name: "test-market",
        source: { registry: "skills.sh", slug: "test-market" },
        skillFile: "",
        baseDir: "",
        description: "",
      }),
      "clawhub",
    );

    // 3. git
    assert.equal(
      detectSkillSourceKind({
        name: "test-git",
        source: { registry: "git", slug: "owner/repo" },
        skillFile: "",
        baseDir: "",
        description: "",
      }),
      "git",
    );
    assert.equal(
      detectSkillSourceKind({
        name: "test-gh",
        source: { registry: "custom", slug: "anthropics/skills-repo" },
        skillFile: "",
        baseDir: "",
        description: "",
      }),
      "git",
    );

    // 4. local
    assert.equal(
      detectSkillSourceKind({
        name: "local-skill",
        skillFile: "",
        baseDir: "local-skill",
        description: "",
      }),
      "local",
    );
  });

  it("2 · checkSingleSkillUpdate: builtin 技能恒为最新", async () => {
    const res = await checkSingleSkillUpdate({
      name: "skills-creator",
      builtIn: true,
      description: "builtin",
      skillFile: "",
      baseDir: "",
    });
    assert.equal(res.status, "up_to_date");
    assert.equal(res.sourceKind, "builtin");
  });

  it("3 · checkSingleSkillUpdate: 在 Mock 环境下支持精准返回可更新状态", async () => {
    const res = await checkSingleSkillUpdate({
      name: "liveagent-code-review",
      builtIn: false,
      description: "code review",
      skillFile: "",
      baseDir: "liveagent-code-review",
    });
    assert.equal(res.status, "update_available");
    assert.equal(res.latestVersion, "1.3.0");
    assert.ok(res.message?.includes("v1.3.0"));
  });

  it("4 · checkAllSkillsUpdate: 并发检查多项技能无遗漏", async () => {
    const skills = [
      { name: "grill-me", builtIn: true, skillFile: "", baseDir: "", description: "" },
      { name: "liveagent-code-review", builtIn: false, skillFile: "", baseDir: "", description: "" },
      { name: "skills-installer", builtIn: true, skillFile: "", baseDir: "", description: "" },
    ];
    const map = await checkAllSkillsUpdate(skills);
    assert.equal(Object.keys(map).length, 3);
    assert.equal(map["grill-me"].status, "up_to_date");
    assert.equal(map["liveagent-code-review"].status, "update_available");
    assert.equal(map["skills-installer"].status, "up_to_date");
  });

  it("5 · applySkillUpdate: 内置技能拒绝更新，常规技能允许更新", async () => {
    const builtinRes = await applySkillUpdate({
      name: "grill-me",
      builtIn: true,
      description: "",
      skillFile: "",
      baseDir: "",
    });
    assert.equal(builtinRes.success, false);
    assert.ok(builtinRes.message.includes("内置技能"));

    const normalRes = await applySkillUpdate({
      name: "liveagent-code-review",
      builtIn: false,
      description: "",
      skillFile: "",
      baseDir: "liveagent-code-review",
    });
    assert.equal(normalRes.success, true);
  });

  it("6 · Red/Break Check 破坏性验证：若内置技能判定为 git 则必将失败", () => {
    const fakeSkill = { name: "grill-me", builtIn: true, skillFile: "", baseDir: "", description: "" };
    // 正常状态
    assert.equal(detectSkillSourceKind(fakeSkill), "builtin");
    // 破坏测试：断言它绝不等于 "git"
    assert.notEqual(detectSkillSourceKind(fakeSkill), "git");
  });
});
