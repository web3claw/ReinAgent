/**
 * 工具级策略测试（createApprovalGate 的 toolPolicies 参数）。
 * 运行：node --test src/lib/providers/toolPolicy.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Node 直跑需 resolve 钩子补扩展名；bun 原生支持 .ts 且 1.4.x 无 registerHooks —— 动态导入 + 能力检测。
const { registerHooks } = await import("node:module");
if (typeof registerHooks === "function") registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
      const url = new URL(specifier, context.parentURL);
      if (!/\.[a-z0-9]+$/i.test(url.pathname)) {
        for (const ext of [".js", ".ts", ".mjs", ".json"]) {
          const candidate = new URL(url.href + ext);
          if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const { createApprovalGate } = await import("./runAgentTurn.ts");

function ctx(name) {
  return { toolCall: { type: "toolCall", id: `call-${name}`, name, arguments: {} }, args: {} };
}
/** 恒 allow 的协调器（测试里不触发挂起） */
const coordinator = {
  request: () => new Promise(() => {}), // 挂起不返回（测 ask 时只用「是否走到挂起」前置路径）
  isAlwaysAllowed: () => false,
  allowAlways: () => {},
};

test("P1-1 · toolPolicies allow：full 模式下也直通", async () => {
  const gate = createApprovalGate("full", coordinator, { write_file: "allow" });
  const result = await gate(ctx("write_file"));
  assert.equal(result, undefined, "allow 策略在 full 模式下放行");
});

test("P1-1 · toolPolicies deny：full 模式下也拦截（显式用户意图优先于模式）", async () => {
  const gate = createApprovalGate("full", coordinator, { write_file: "deny" });
  const result = await gate(ctx("write_file"));
  assert.ok(result?.block, "deny 应拦截");
  assert.ok(result.reason.includes("deny"), "拦截理由应说明是策略 deny");
});

test("P1-1 · toolPolicies deny：read 类工具也被拦（策略优先于 read 直通）", async () => {
  const gate = createApprovalGate("ask", coordinator, { read_file: "deny" });
  const result = await gate(ctx("read_file"));
  assert.ok(result?.block, "read 工具的 deny 策略应生效");
});

test("P1-1 · toolPolicies ask：edit 模式下 write 工具从自动放行变为挂起审批", async () => {
  const gate = createApprovalGate("edit", coordinator, { write_file: "ask" });
  // 挂起不返回——用 200ms 竞速判断「进入了挂起」
  const raced = await Promise.race([
    gate(ctx("write_file")).then(() => "resolved"),
    new Promise((r) => setTimeout(() => r("pending"), 200)),
  ]);
  assert.equal(raced, "pending", "ask 策略应走挂起审批（不自动放行）");
});

test("P1-1 · 未配置策略的工具不受影响（edit 模式 write 仍自动放行）", async () => {
  const gate = createApprovalGate("edit", coordinator, {});
  const result = await gate(ctx("write_file"));
  assert.equal(result, undefined, "未配置策略时 edit 模式 write 自动放行");
});
