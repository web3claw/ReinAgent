/**
 * /goal 目标状态纯逻辑测试（goalState.ts，ZCode session goal 语义 v1）。
 * 运行：node --test src/lib/goals/goalState.test.mjs
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

const { parseGoalCommand, escapeGoalPromptText, formatGoalStateForModel } = await import(
  "./goalState.ts"
);

test("parseGoalCommand：无参 = show；空串/空白同样 show", () => {
  assert.deepEqual(parseGoalCommand(""), { action: "show" });
  assert.deepEqual(parseGoalCommand("   "), { action: "show" });
});

test("parseGoalCommand：整串精确命中子命令（大小写不敏感）", () => {
  assert.deepEqual(parseGoalCommand("pause"), { action: "pause" });
  assert.deepEqual(parseGoalCommand("PAUSE"), { action: "pause" });
  assert.deepEqual(parseGoalCommand(" resume "), { action: "resume" });
  assert.deepEqual(parseGoalCommand("Clear"), { action: "clear" });
});

test("parseGoalCommand：子命令词开头的正常文本不被误吞（适配：整串匹配而非首 token）", () => {
  assert.deepEqual(parseGoalCommand("clear the build cache"), {
    action: "set",
    objective: "clear the build cache",
  });
  assert.deepEqual(parseGoalCommand("pause the music"), {
    action: "set",
    objective: "pause the music",
  });
});

test("parseGoalCommand：replace 显式别名剥前缀；裸 replace = 空目标（上层校验拒绝）", () => {
  assert.deepEqual(parseGoalCommand("replace 把温度改成华氏度"), {
    action: "set",
    objective: "把温度改成华氏度",
  });
  assert.deepEqual(parseGoalCommand("replace"), { action: "set", objective: "" });
  assert.deepEqual(parseGoalCommand("replace  pause"), { action: "set", objective: "pause" });
});

test("parseGoalCommand：其余文本整体作为目标（含多行/空格保留）", () => {
  assert.deepEqual(parseGoalCommand("把温度从摄氏度改成华氏度显示"), {
    action: "set",
    objective: "把温度从摄氏度改成华氏度显示",
  });
  assert.deepEqual(parseGoalCommand("第一行  \n第二行"), {
    action: "set",
    objective: "第一行  \n第二行",
  });
});

test("escapeGoalPromptText：& < > 转义（ZCode 同款，防包装逃逸）", () => {
  assert.equal(escapeGoalPromptText("<script>a & b</script>"), "&lt;script&gt;a &amp; b&lt;/script&gt;");
  assert.equal(escapeGoalPromptText("普通文本"), "普通文本");
});

test("formatGoalStateForModel：无目标/空目标 → 空串（不进 meta 块）", () => {
  assert.equal(formatGoalStateForModel(null), "");
  assert.equal(formatGoalStateForModel(undefined), "");
  assert.equal(
    formatGoalStateForModel({ objective: "  ", status: "active", updatedAt: 0 }),
    "",
  );
});

test("formatGoalStateForModel：active → 权威状态块 + untrusted 包装，无暂停句", () => {
  const text = formatGoalStateForModel({
    objective: "把温度改成华氏度",
    status: "active",
    updatedAt: 1,
  });
  assert.ok(text.includes("# Session goal"), "节标题");
  assert.ok(text.includes("Current session goal state (authoritative):"), "ZCode 同款权威行");
  assert.ok(text.includes("Status: active"), "状态行");
  assert.ok(text.includes("<untrusted_objective>\n把温度改成华氏度\n</untrusted_objective>"), "utrusted 包装");
  assert.ok(!text.includes("paused"), "active 无暂停句");
  // No-Fallback：本应用不跟踪 token 用量/预算/时长，这些行不得出现（不捏造）
  assert.ok(!text.includes("Tokens used") && !text.includes("Token budget") && !text.includes("Time used"));
});

test("formatGoalStateForModel：paused → 附 ZCode 暂停语义句；目标文本被转义", () => {
  const text = formatGoalStateForModel({
    objective: "<目标> & 注释",
    status: "paused",
    updatedAt: 1,
  });
  assert.ok(text.includes("Status: paused"));
  assert.ok(text.includes("&lt;目标&gt; &amp; 注释"), "转义应用");
  assert.ok(
    text.includes("The goal is paused. Do not continue pursuing it unless the user resumes or replaces the goal."),
    "ZCode paused 提醒原文",
  );
});
