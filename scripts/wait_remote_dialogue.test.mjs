import assert from "node:assert/strict";
import test from "node:test";

// We import/test the detection functions
function extractMessagesSummary(messages, maxCount = 3) {
  if (!messages || messages.length === 0) return "（无消息记录）";
  const slice = messages.slice(-maxCount);
  let summary = "";
  for (const msg of slice) {
    summary += `\n[Role: ${msg.role}]\n`;
    for (const p of msg.parts || []) {
      try {
        const pData = JSON.parse(p.payload);
        if (pData.text) summary += `  文本: ${pData.text.slice(0, 300)}...\n`;
        if (pData.thinking) summary += `  思考片段: ${pData.thinking.slice(0, 200)}...\n`;
        if (pData.toolName) summary += `  调用工具: ${pData.toolName}(${JSON.stringify(pData.args || {}).slice(0, 100)})\n`;
        if (pData.error) summary += `  ⚠️ 工具报错: ${pData.error.slice(0, 200)}\n`;
      } catch (_) {
        summary += `  ${p.type}: ${(p.payload || "").slice(0, 150)}...\n`;
      }
    }
  }
  return summary;
}

function checkDeadLoop(messages) {
  if (!messages || messages.length < 3) return null;
  const recentCalls = [];
  for (const m of messages.slice(-10)) {
    for (const p of m.parts || []) {
      try {
        const pData = JSON.parse(p.payload);
        if (pData.toolName) {
          recentCalls.push({
            name: pData.toolName,
            args: JSON.stringify(pData.args || {}),
            error: pData.error,
          });
        }
      } catch (_) {}
    }
  }
  if (recentCalls.length >= 3) {
    const tail3 = recentCalls.slice(-3);
    const allSameName = tail3.every((c) => c.name === tail3[0].name);
    const allSameArgs = tail3.every((c) => c.args === tail3[0].args);
    if (allSameName && allSameArgs) {
      return `连续 3 次调用相同工具与参数: ${tail3[0].name} (${tail3[0].args.slice(0, 80)})`;
    }
    const allErrors = tail3.every((c) => !!c.error);
    if (allErrors && allSameName) {
      return `连续 3 次工具执行失败: ${tail3[0].name}`;
    }
  }
  return null;
}

test("checkDeadLoop detects consecutive identical tool calls", () => {
  const normalMessages = [
    { role: "assistant", parts: [{ payload: JSON.stringify({ toolName: "toolA", args: { a: 1 } }) }] },
    { role: "assistant", parts: [{ payload: JSON.stringify({ toolName: "toolB", args: { b: 2 } }) }] },
    { role: "assistant", parts: [{ payload: JSON.stringify({ toolName: "toolC", args: { c: 3 } }) }] },
  ];
  assert.equal(checkDeadLoop(normalMessages), null);

  const deadLoopMessages = [
    { role: "assistant", parts: [{ payload: JSON.stringify({ toolName: "exec", args: { cmd: "ls" } }) }] },
    { role: "assistant", parts: [{ payload: JSON.stringify({ toolName: "exec", args: { cmd: "ls" } }) }] },
    { role: "assistant", parts: [{ payload: JSON.stringify({ toolName: "exec", args: { cmd: "ls" } }) }] },
  ];
  const detected = checkDeadLoop(deadLoopMessages);
  assert.ok(detected !== null);
  assert.match(detected, /连续 3 次调用相同工具与参数/);
});

test("checkDeadLoop detects 3 consecutive errors of same tool", () => {
  const errorMessages = [
    { role: "assistant", parts: [{ payload: JSON.stringify({ toolName: "fetch", args: { url: "a" }, error: "timeout" }) }] },
    { role: "assistant", parts: [{ payload: JSON.stringify({ toolName: "fetch", args: { url: "b" }, error: "timeout" }) }] },
    { role: "assistant", parts: [{ payload: JSON.stringify({ toolName: "fetch", args: { url: "c" }, error: "timeout" }) }] },
  ];
  const detected = checkDeadLoop(errorMessages);
  assert.ok(detected !== null);
  assert.match(detected, /连续 3 次工具执行失败/);
});

test("extractMessagesSummary handles thinking, toolName and text", () => {
  const msgs = [
    {
      role: "assistant",
      parts: [
        { payload: JSON.stringify({ thinking: "正在逆向 field7 结构..." }) },
        { payload: JSON.stringify({ toolName: "frida_call", args: { address: "0x2a280" } }) },
        { payload: JSON.stringify({ text: "逆向分析完成，nonce 算法已确定。" }) },
      ],
    },
  ];
  const summary = extractMessagesSummary(msgs);
  assert.ok(summary.includes("正在逆向 field7 结构"));
  assert.ok(summary.includes("frida_call"));
  assert.ok(summary.includes("逆向分析完成"));
});
