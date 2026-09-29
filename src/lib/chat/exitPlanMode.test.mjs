/**
 * ExitPlanMode 工具与审批门模式分支的验证（node:test，无头驱动）。
 * 运行：bun test src/lib/chat/exitPlanMode.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { createExitPlanModeTool, isPlanApprovalDecision } = await import(
  "../agent/exitPlanModeTool.ts"
);
const { createApprovalGate, EXIT_PLAN_MODE_TOOL_NAME } = await import(
  "../providers/runAgentTurn.ts"
);

/** 构造 gate 的 ctx */
const ctx = (id) => ({ toolCall: { name: EXIT_PLAN_MODE_TOOL_NAME, id, args: { plan: "p" } } });

test("门：非 plan 模式一律拦截 exit_plan_mode（plan-mode-policy 语义）", async () => {
  for (const mode of ["ask", "edit", "full"]) {
    const gate = createApprovalGate(mode, {
      request: async () => "allow",
      isAlwaysAllowed: () => false,
      allowAlways: () => {},
    });
    const result = await gate(ctx("t1"));
    assert.ok(result?.block, `${mode} 模式应拦截 exit_plan_mode`);
    assert.ok(result.reason.includes("只能在计划模式下"));
  }
});

test("门：plan 模式放行 exit_plan_mode（去工具处理器挂起）且不受工具级策略影响", async () => {
  const gate = createApprovalGate(
    "plan",
    { request: async () => "allow", isAlwaysAllowed: () => false, allowAlways: () => {} },
    { exit_plan_mode: "deny" },
  );
  const result = await gate(ctx("t2"));
  assert.equal(result, undefined, "plan 模式应放行（模式门优先于工具级策略）");
});

test("工具：批准 → approved:true 成功收敛", async () => {
  let capturedArgs = null;
  const tool = createExitPlanModeTool({
    request: async (req) => {
      capturedArgs = req.args;
      return { approved: true };
    },
  });
  const result = await tool.execute("call-1", { plan: "# 计划\n1. 改 a", allowedPrompts: [{ tool: "Bash", prompt: "run tests" }] });
  assert.equal(capturedArgs.kind, "plan");
  assert.equal(capturedArgs.plan, "# 计划\n1. 改 a");
  assert.deepEqual(capturedArgs.allowedPrompts, [{ tool: "Bash", prompt: "run tests" }]);
  assert.ok(result.content[0].text.includes("已批准"));
  assert.equal(result.details.approved, true);
});

test("工具：拒绝带反馈 → 反馈透传给模型", async () => {
  const tool = createExitPlanModeTool({
    request: async () => ({ approved: false, feedback: "先补测试方案" }),
  });
  const result = await tool.execute("call-2", { plan: "p" });
  assert.ok(result.content[0].text.includes("先补测试方案"));
  assert.equal(result.details.approved, false);
});

test("工具：跳过（reject 通道）→ 提示继续调研", async () => {
  const tool = createExitPlanModeTool({ request: async () => "reject" });
  const result = await tool.execute("call-3", { plan: "p" });
  assert.ok(result.content[0].text.includes("拒绝了该计划"));
});

test("工具：空 plan 抛错（trim 校验）", async () => {
  const tool = createExitPlanModeTool({ request: async () => ({ approved: true }) });
  await assert.rejects(() => tool.execute("call-4", { plan: "   " }), /plan 不能为空/);
});

test("isPlanApprovalDecision 守卫", () => {
  assert.equal(isPlanApprovalDecision({ approved: true }), true);
  assert.equal(isPlanApprovalDecision({ approved: false, feedback: "x" }), true);
  assert.equal(isPlanApprovalDecision("reject"), false);
  assert.equal(isPlanApprovalDecision({ answers: [] }), false);
});
