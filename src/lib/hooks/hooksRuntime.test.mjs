/**
 * hooksRuntime 纯逻辑验证（P2-G2）。
 * 运行：bun test src/lib/hooks/hooksRuntime.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { parseHooksConfig, extractJsonLoose, isLifecycleHookEvent } = await import("./hooksRuntime.ts");

test("parseHooksConfig：合法条目保留、缺 command/event 的丢弃、坏 JSON → null", () => {
  const good = JSON.stringify({
    hooks: [
      { event: "PreToolUse", matcher: "exec_command", command: "echo check" },
      { event: "Stop", command: "  node done.js  ", timeoutMs: 5000 },
      { event: "Stop" }, // 缺 command 且无 requests → 丢弃
      { command: "echo x" }, // 缺 event → 丢弃
      null,
    ],
  });
  const entries = parseHooksConfig(good);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].matcher, "exec_command");
  assert.equal(entries[1].command, "node done.js");
  assert.equal(entries[1].timeoutMs, 5000);
  assert.equal(parseHooksConfig("{ not json"), null);
  assert.deepEqual(parseHooksConfig(JSON.stringify({})), []);
});

test("parseHooksConfig：新格式（id/name/type/requests/enabled）全保留；http 条目无 command 也合法", () => {
  const raw = JSON.stringify({
    hooks: [
      {
        id: "h1",
        event: "agent_end",
        name: "通知机器人",
        description: "构建完成上报",
        enabled: false,
        type: "http",
        requests: [{ id: "r1", url: "https://example.com/hook", method: "POST", body: { ok: 1 } }],
      },
      { event: "turn_start", type: "command", command: "echo hi", enabled: true },
    ],
  });
  const entries = parseHooksConfig(raw);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, "h1");
  assert.equal(entries[0].name, "通知机器人");
  assert.equal(entries[0].enabled, false);
  assert.equal(entries[0].type, "http");
  assert.equal(entries[0].requests[0].url, "https://example.com/hook");
  assert.equal(entries[1].enabled, true);
});

test("事件体系：8 生命周期事件判定 + 经典事件不误判", () => {
  for (const e of [
    "agent_start", "turn_start", "message_start", "message_end",
    "tool_execution_start", "tool_execution_end", "turn_end", "agent_end",
  ]) {
    assert.equal(isLifecycleHookEvent(e), true, e);
  }
  for (const e of ["PreToolUse", "UserPromptSubmit", "PostToolUse", "PermissionRequest", "SessionStart", "Stop", "unknown", ""]) {
    assert.equal(isLifecycleHookEvent(e), false, e);
  }
});

test("extractJsonLoose：容忍前后噪声行、取首个..末个大括号", () => {
  assert.deepEqual(extractJsonLoose('log line\n{"decision":"block","reason":"no"}\nbye'), {
    decision: "block",
    reason: "no",
  });
  assert.equal(extractJsonLoose("no json here"), null);
  assert.equal(extractJsonLoose("{ broken"), null);
});
