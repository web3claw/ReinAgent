/**
 * hooksRuntime 纯逻辑验证（P2-G2）。
 * 运行：bun test src/lib/hooks/hooksRuntime.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { parseHooksConfig, extractJsonLoose } = await import("./hooksRuntime.ts");

test("parseHooksConfig：合法条目保留、缺 command/event 的丢弃、坏 JSON → null", () => {
  const good = JSON.stringify({
    hooks: [
      { event: "PreToolUse", matcher: "exec_command", command: "echo check" },
      { event: "Stop", command: "  node done.js  ", timeoutMs: 5000 },
      { event: "Stop" }, // 缺 command → 丢弃
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

test("extractJsonLoose：容忍前后噪声行、取首个..末个大括号", () => {
  assert.deepEqual(extractJsonLoose('log line\n{"decision":"block","reason":"no"}\nbye'), {
    decision: "block",
    reason: "no",
  });
  assert.equal(extractJsonLoose("no json here"), null);
  assert.equal(extractJsonLoose("{ broken"), null);
});
