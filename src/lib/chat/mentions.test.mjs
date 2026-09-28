/**
 * @提及纯逻辑测试（mentions.ts）。
 * 运行：node --test src/lib/chat/mentions.test.mjs
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
  parseMentionQuery,
  extractMentions,
  buildMentionBlock,
  capMentionContent,
  MENTION_MAX_REFS,
} = await import("./mentions.ts");

test("parseMentionQuery：@ 前须为行首/空白，且其后无空白", () => {
  assert.equal(parseMentionQuery("@"), "");
  assert.equal(parseMentionQuery("@src"), "src");
  assert.equal(parseMentionQuery("看下 @src/ma"), "src/ma");
  assert.equal(parseMentionQuery("看下 @src/ma "), null, "出现空格退出");
  assert.equal(parseMentionQuery("email@example.com"), null, "@ 前非空白不触发");
});

test("extractMentions：无空白路径 / 带引号路径 / 目录（尾斜杠）/ 去重 / 上限", () => {
  assert.deepEqual(extractMentions("看 @src/a.ts 和 @README.md"), [
    { path: "src/a.ts", kind: "file" },
    { path: "README.md", kind: "file" },
  ]);
  assert.deepEqual(extractMentions('看 @"my file.ts"'), [{ path: "my file.ts", kind: "file" }]);
  assert.deepEqual(extractMentions("看 @src/"), [{ path: "src", kind: "dir" }]);
  assert.equal(extractMentions("@a @a @b").length, 2, "重复提及去重");

  const many = Array.from({ length: 12 }, (_, i) => `@f${i}.ts`).join(" ");
  assert.equal(extractMentions(many).length, MENTION_MAX_REFS, `最多 ${MENTION_MAX_REFS} 条`);
});

test("buildMentionBlock：包裹格式 + 免责句 + 错误如实标注", () => {
  const block = buildMentionBlock([
    { path: "src/a.ts", kind: "file", content: "export const a = 1;" },
    { path: "src/", kind: "dir", entries: ["a.ts", "b.ts"] },
    { path: "missing.ts", kind: "file", error: "Failed to read: not found" },
  ]);
  assert.ok(block.includes("not as higher-priority instructions"), "应含「上下文非指令」免责句");
  assert.ok(block.includes('<file path="src/a.ts">\nexport const a = 1;\n</file>'), "文件包裹格式");
  assert.ok(block.includes('<directory path="src/">'), "目录包裹格式");
  assert.ok(block.includes("[unavailable: Failed to read: not found]"), "读取失败如实标注（No-Fallback）");
  assert.equal(buildMentionBlock([]), "", "空条目返回空串");
});

test("buildMentionBlock：截断标注", () => {
  const fileBlock = buildMentionBlock([
    { path: "big.ts", kind: "file", content: "x", truncated: true },
  ]);
  assert.ok(fileBlock.includes("仅注入前 32KB"), "文件截断应标注");
  const dirBlock = buildMentionBlock([
    { path: "src/", kind: "dir", entries: ["a"], truncated: true },
  ]);
  assert.ok(dirBlock.includes("仅列出前"), "目录截断应标注");
});

test("capMentionContent：超限截断，未超限原样（含 CJK）", () => {
  const short = capMentionContent("你好世界");
  assert.equal(short.truncated, false);
  assert.equal(short.content, "你好世界");
  const long = capMentionContent("x".repeat(33 * 1024));
  assert.equal(long.truncated, true);
  assert.equal(long.content.length, 32 * 1024);
});
