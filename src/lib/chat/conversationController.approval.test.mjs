/**
 * conversationController 审批回路的自动化验证。
 *
 * 覆盖控制器新增的审批编排：
 * - getOptions 提供的 approvalMode / approval 会被透传给 runAgentTurn；
 * - 协调器 request → controller.requestApproval：状态出现 pendingApproval（渲染审批卡）；
 * - resolveApproval 决策回执给挂起的钩子，状态清除；
 * - stop() 在审批挂起时以 reject 收场并收敛「已停止」。
 *
 * 假 runAgentTurn 不跑库循环，只按脚本消费 approval（被测对象是控制器的编排，
 * 审批门本身的裁决矩阵见 approvalGate.test.mjs）。
 *
 * 运行：node --test src/lib/chat/conversationController.approval.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { initialState } from "./conversationModel.js";
import { createConversationController } from "./conversationController.js";

/** 构造被测编排器；假 runAgentTurn 的行为由 opts.onTurn(params) 定制。 */
function makeHarness(onTurn) {
  let state = initialState();
  const captured = [];
  const runAgentTurn = async (params) => {
    captured.push(params);
    return onTurn(params);
  };
  const ctrl = createConversationController({
    getState: () => state,
    setState: (updater) => {
      state = updater(state);
    },
    runAgentTurn,
    getOptions: () => ({
      source: "faux",
      config: {},
      systemPrompt: "sys",
      approvalMode: "ask",
      approval: {
        request: (req) => ctrl.requestApproval(req),
        isAlwaysAllowed: () => false,
        allowAlways: () => undefined,
      },
    }),
  });
  return { ctrl, getState: () => state, captured };
}

test("1 · 审批透传：approvalMode/approval 随 runAgentTurn 参数下发", async () => {
  const { ctrl, captured } = makeHarness(async () => ({ reachedAgentEnd: true }));
  assert.equal(ctrl.send("你好"), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(captured.length, 1);
  assert.equal(captured[0].approvalMode, "ask", "approvalMode 应透传");
  assert.ok(captured[0].approval, "approval 协调器应透传");
  assert.equal(typeof captured[0].approval.request, "function");
});

test("2 · 挂起与决策：request 后状态带 pendingApproval，resolveApproval 回执并清除", async () => {
  let decisionSeen;
  const { ctrl, getState } = makeHarness(async (params) => {
    decisionSeen = await params.approval.request({
      toolName: "write_file",
      toolCallId: "call-1",
      args: { path: "a.ts" },
    });
    return { reachedAgentEnd: false, decision: decisionSeen };
  });

  assert.equal(ctrl.send("写入"), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(getState().pendingApproval, "挂起期间状态应带 pendingApproval");
  assert.equal(getState().pendingApproval.toolName, "write_file");
  assert.equal(getState().status, "streaming", "挂起期间轮次仍在进行");

  ctrl.resolveApproval("reject");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(decisionSeen, "reject", "决策应回执给挂起的钩子");
  assert.equal(getState().pendingApproval, null, "决策后审批卡应清除");
  assert.equal(getState().status, "idle", "轮次应正常收敛");

  // resolveApproval 无挂起时静默（不抛错）。
  ctrl.resolveApproval("allow");
});

test("3 · stop() 解除审批挂起：钩子收到 reject、状态收敛为已停止", async () => {
  let decisionSeen;
  const { ctrl, getState } = makeHarness(async (params) => {
    decisionSeen = await params.approval.request({
      toolName: "exec_command",
      toolCallId: "call-2",
      args: {},
    });
    return { reachedAgentEnd: false, aborted: true, stopReason: "aborted" };
  });

  assert.equal(ctrl.send("跑命令"), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(getState().pendingApproval, "停止前应处于审批挂起");

  ctrl.stop();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(decisionSeen, "reject", "stop 应以 reject 回执挂起的审批");
  assert.equal(getState().pendingApproval, null, "stop 应清除审批挂起");
  assert.equal(getState().status, "idle", "stop 后应收敛为 idle（条目标注已停止）");
});
