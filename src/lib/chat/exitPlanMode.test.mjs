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

test("门：函数形态实时读取模式——回合中途切换立即生效（/plan 批准后执行立即放行的回归）", async () => {
  // 2026-10-07 /plan E2E 实锤：冻结的 approvalMode 让已批准的计划在后续工具调用上
  // 继续被计划门拦截（模型收到「已批准、开始实施」后 exec 仍被 block）。修复 = 门按
  // 调用实时取模式（ZCode getMode 语义）。
  let mode = "plan";
  const requests = [];
  const gate = createApprovalGate(() => mode, {
    request: async (req) => {
      requests.push(req.toolName);
      return "allow";
    },
    isAlwaysAllowed: () => false,
    allowAlways: () => {},
  });
  const writeCtx = (id) => ({ toolCall: { name: "write_file", id, args: { path: "a.ts" } } });

  // plan 阶段：exit_plan_mode 放行、write 拦截
  assert.equal(await gate(ctx("live-1")), undefined, "plan 应放行 exit_plan_mode");
  assert.ok((await gate(writeCtx("live-2")))?.block, "plan 应拦截 write_file");

  // 中途切换（等价于计划卡批准：先 updateTaskApprovalMode("ask") 再 resolve）
  mode = "ask";
  assert.ok((await gate(ctx("live-3")))?.block, "切到 ask 后同一门的 exit_plan_mode 应改为拦截");
  assert.equal(await gate(writeCtx("live-4")), undefined, "切到 ask 后 write 改走审批（allow → 放行）");
  assert.deepEqual(requests, ["write_file"], "切换后 write 恰好发一次审批请求；plan 阶段零请求");
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
