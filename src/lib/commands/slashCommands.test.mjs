/**
 * 斜杠命令纯逻辑测试（slashCommands.ts）。
 * 运行：node --test src/lib/commands/slashCommands.test.mjs
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

const {
  BUILTIN_COMMANDS,
  parseSlashQuery,
  filterCommands,
  expandCommandTemplate,
  toCustomCommands,
  matchBuiltinCommand,
} = await import("./slashCommands.ts");

test("parseSlashQuery：仅以 / 开头且未出现空格时进入命令态", () => {
  assert.equal(parseSlashQuery("/"), "", "刚输入 /");
  assert.equal(parseSlashQuery("/comp"), "comp", "输入命令名");
  assert.equal(parseSlashQuery("/compact 参数"), null, "出现空格后退出命令态");
  assert.equal(parseSlashQuery("你好 /x"), null, "非行首 / 不触发");
  assert.equal(parseSlashQuery("普通文本"), null);
  assert.equal(parseSlashQuery("/a/b"), null, "第二个斜杠退出（避免路径误触发）");
});

test("filterCommands：名称前缀优先，其次名称/描述包含", () => {
  const commands = [
    { name: "compact", label: "compact", description: "压缩上下文", kind: "builtin" },
    { name: "clear", label: "clear", description: "清空对话", kind: "builtin" },
    { name: "review", label: "review", description: "代码审查 compact 相关", kind: "custom" },
  ];
  assert.equal(filterCommands(commands, "").length, 3, "空查询返回全部");
  const comp = filterCommands(commands, "comp");
  assert.equal(comp[0].name, "compact", "前缀命中排前");
  const byDesc = filterCommands(commands, "审查");
  assert.deepEqual(byDesc.map((c) => c.name), ["review"], "描述命中");
});

test("expandCommandTemplate：$ARGUMENTS 替换；无占位符时参数追加末行（不静默丢弃）", () => {
  assert.equal(expandCommandTemplate("审查 $ARGUMENTS 的改动", "src/a.ts"), "审查 src/a.ts 的改动");
  assert.equal(expandCommandTemplate("审查 $ARGUMENTS", ""), "审查 ", "无参时占位符替换为空");
  assert.equal(
    expandCommandTemplate("固定提示词", "补充参数"),
    "固定提示词\n\n补充参数",
    "无占位符时参数应追加（否则用户输入被静默吞掉）",
  );
  assert.equal(expandCommandTemplate("固定提示词", "  "), "固定提示词", "空白参数不追加");
});

test("toCustomCommands：防御性解析（脏数据不崩、非法名丢弃）", () => {
  const out = toCustomCommands([
    { name: "review", description: "代码审查", body: "审查 $ARGUMENTS" },
    { name: "/leading-slash", description: "", body: "x" },
    { name: "has space", description: "非法", body: "x" },
    { description: "无名字", body: "x" },
    null,
    { name: "ok", body: 123 },
  ]);
  assert.deepEqual(out.map((c) => c.name), ["review", "leading-slash", "ok"], "非法名（空白）丢弃、前导斜杠剥除");
  assert.equal(out[0].description, "代码审查");
  assert.equal(out[1].description, "自定义命令", "空描述回退");
  assert.equal(out[2].body, "", "非字符串 body 归一为空串");
});

test("BUILTIN_COMMANDS：内置命令清单稳定（clear/compact/help）", () => {
  assert.deepEqual(BUILTIN_COMMANDS.map((c) => c.name).sort(), ["clear", "compact", "help"]);
  assert.ok(BUILTIN_COMMANDS.every((c) => c.kind === "builtin"));
});

test("matchBuiltinCommand：整串精确命中内置命令才执行；路径/未注册/普通文本一律放行", () => {
  assert.equal(matchBuiltinCommand("/compact")?.command.name, "compact");
  assert.equal(matchBuiltinCommand("  /clear  ")?.command.name, "clear", "trim 后命中");
  assert.deepEqual(matchBuiltinCommand("/compact 额外参数"), {
    command: BUILTIN_COMMANDS.find((c) => c.name === "compact"),
    args: "额外参数",
  });
  assert.equal(matchBuiltinCommand("/help")?.command.name, "help");
  assert.equal(matchBuiltinCommand("/unknown"), null, "未注册命令绝不吞掉（交回普通发送）");
  assert.equal(matchBuiltinCommand("/home/user/file"), null, "路径不误判");
  assert.equal(matchBuiltinCommand("请执行 /compact"), null, "非整串不触发");
  assert.equal(matchBuiltinCommand("普通文本"), null);
});
