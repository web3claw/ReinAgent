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
  toSkillCommands,
  toMcpCommands,
  toMcpFallbackCommands,
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

test("BUILTIN_COMMANDS：内置命令清单稳定（clear/compact/compress/init/plan/goal/help）", () => {
  assert.deepEqual(BUILTIN_COMMANDS.map((c) => c.name).sort(), [
    "clear",
    "compact",
    "compress",
    "goal",
    "help",
    "init",
    "plan",
  ]);
  assert.ok(BUILTIN_COMMANDS.every((c) => c.kind === "builtin"));
});

test("matchBuiltinCommand：整串精确命中内置命令才执行；路径/未注册/普通文本一律放行", () => {
  assert.equal(matchBuiltinCommand("/compact")?.command.name, "compact");
  assert.equal(matchBuiltinCommand("/compress")?.command.name, "compress");
  assert.equal(matchBuiltinCommand("  /clear  ")?.command.name, "clear", "trim 后命中");
  assert.deepEqual(matchBuiltinCommand("/compact 额外参数"), {
    command: BUILTIN_COMMANDS.find((c) => c.name === "compact"),
    args: "额外参数",
  });
  assert.equal(matchBuiltinCommand("/help")?.command.name, "help");
  assert.deepEqual(matchBuiltinCommand("/init 重点写构建命令"), {
    command: BUILTIN_COMMANDS.find((c) => c.name === "init"),
    args: "重点写构建命令",
  });
  assert.deepEqual(matchBuiltinCommand("/plan"), {
    command: BUILTIN_COMMANDS.find((c) => c.name === "plan"),
    args: "",
  });
  assert.deepEqual(matchBuiltinCommand("/plan 重构登录流程"), {
    command: BUILTIN_COMMANDS.find((c) => c.name === "plan"),
    args: "重构登录流程",
  });
  assert.deepEqual(matchBuiltinCommand("/goal"), {
    command: BUILTIN_COMMANDS.find((c) => c.name === "goal"),
    args: "",
  });
  assert.deepEqual(matchBuiltinCommand("/goal pause"), {
    command: BUILTIN_COMMANDS.find((c) => c.name === "goal"),
    args: "pause",
  });
  assert.equal(matchBuiltinCommand("/unknown"), null, "未注册命令绝不吞掉（交回普通发送）");
  assert.equal(matchBuiltinCommand("/home/user/file"), null, "路径不误判");
  assert.equal(matchBuiltinCommand("请执行 /compact"), null, "非整串不触发");
  assert.equal(matchBuiltinCommand("普通文本"), null);
});

test("toSkillCommands：防御性解析技能、去重、剥除前导斜杠、生成 kind=skill", () => {
  const out = toSkillCommands([
    { name: "find-skills", description: "在 ClawHub 搜索技能" },
    { name: "/grill-me", description: "需求访谈与对齐" },
    { name: "find-skills", description: "重复技能应被去重" },
    { name: "has space", description: "含空格非法" },
    null,
    { name: "no-desc" },
  ]);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((c) => c.name), ["find-skills", "grill-me", "no-desc"]);
  assert.ok(out.every((c) => c.kind === "skill"));
  assert.equal(out[0].description, "在 ClawHub 搜索技能");
  assert.equal(out[1].description, "需求访谈与对齐");
  assert.equal(out[2].description, "已启用的技能", "无描述时回退兜底");
});

test("toMcpCommands：防御性解析 MCP 工具、去重、提取服务标签、生成 kind=mcp", () => {
  const out = toMcpCommands([
    { serverId: "fs", serverLabel: "Filesystem", name: "read_file", description: "读取指定文件内容" },
    { serverId: "db", name: "query_database", description: "执行 SQL 查询" },
    { serverId: "fs", serverLabel: "Filesystem", name: "read_file", description: "重复工具去重" },
    { serverId: "invalid", name: "has space" },
    null,
    { serverId: "tools", name: "do_something" },
  ]);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((c) => c.name), ["read_file", "query_database", "do_something"]);
  assert.ok(out.every((c) => c.kind === "mcp"));
  assert.equal(out[0].sourceLabel, "Filesystem");
  assert.equal(out[1].sourceLabel, "db");
  assert.equal(out[0].description, "读取指定文件内容");
  assert.equal(out[2].description, "MCP 工具 (tools)");
});

test("toMcpFallbackCommands：为离线/失败服务生成保底项，提取错误原因并标记 offline", () => {
  const rustErr =
    "所有已启用的 MCP server 都不可用：\njadx-mcp-server: MCP server exited unexpectedly: status=exit status: 2\nother-server: connection refused";

  const out = toMcpFallbackCommands(
    [
      { id: "jadx-mcp-server", description: "JADX 反编译工具" },
      { id: "offline-server", description: "本地离线服务" },
      { id: "jadx-mcp-server", description: "重复服务去重" },
      { id: "/leading-slash-server" },
      { id: "has space" },
      null,
    ],
    rustErr,
  );

  assert.equal(out.length, 3);
  assert.deepEqual(out.map((c) => c.name), [
    "jadx-mcp-server",
    "offline-server",
    "leading-slash-server",
  ]);
  assert.ok(out.every((c) => c.kind === "mcp"));
  assert.ok(out.every((c) => c.offline === true));

  // 精准提取单项错误原因
  assert.ok(
    out[0].description.includes("status=exit status: 2"),
    "应提取包含 jadx-mcp-server 的具体失败行",
  );
  // 未在错误串命中时回退首行或服务自身的描述
  assert.ok(
    out[1].description.includes("所有已启用的 MCP server 都不可用") ||
      out[1].description.includes("本地离线服务"),
  );
  assert.equal(out[0].sourceLabel, "jadx-mcp-server");
});

