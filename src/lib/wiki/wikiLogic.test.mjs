/**
 * Wiki 纯逻辑验证（node:test）。
 * 运行：node --test src/lib/wiki/wikiLogic.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseWikiPlan,
  fallbackPlanFromModules,
  sanitizeWikiContent,
  needsContinuation,
  buildPlanPrompt,
  buildPagePrompt,
  buildOverviewPrompt,
  WIKI_MAX_PAGES,
} from "./wikiLogic.ts";

test("parseWikiPlan：标准 JSON / 围栏 / 杂质三态 + 章节页归位", () => {
  const plan = {
    chapters: [
      { title: "架构", pages: [{ title: "总体架构", brief: "b1", covers: ["src/"] }] },
      { title: "模块", pages: [{ title: "命令执行", brief: "", covers: "src/cmd.ts src/exec" }] },
    ],
  };
  const json = JSON.stringify(plan);
  assert.equal(parseWikiPlan(json)?.length, 2);
  assert.equal(parseWikiPlan(`好的：\n\`\`\`json\n${json}\n\`\`\``)?.[0].chapter, "架构");
  assert.deepEqual(parseWikiPlan(`前缀 ${json} 后缀`)?.[1].covers, ["src/cmd.ts", "src/exec"]);
});

test("parseWikiPlan：无 chapters 只有顶层 pages 也能解析；总览类标题剔除", () => {
  const flat = JSON.stringify({ pages: [{ title: "总览" }, { title: "真页面" }] });
  const parsed = parseWikiPlan(flat);
  assert.equal(parsed?.length, 1);
  assert.equal(parsed?.[0].title, "真页面");
});

test("parseWikiPlan：破碎输出走正则抢救；彻底失败返回 null", () => {
  const salvaged = parseWikiPlan('糟糕的输出 {"chapters": [{"title":"a" "pages": [ {"title":"页面一"}, {"title":"页面二"');
  assert.ok(salvaged && salvaged.length >= 2);
  assert.equal(parseWikiPlan("完全不是 JSON 也没有标题"), null);
  assert.equal(parseWikiPlan('{"chapters":[{"title":"a","pages":[]}]}'), null);
});

test("parseWikiPlan：页数上限截断到 16 并重排序号", () => {
  const pages = Array.from({ length: 30 }, (_, i) => ({ title: `页面 ${i}` }));
  const parsed = parseWikiPlan(JSON.stringify({ chapters: [{ title: "c", pages }] }));
  assert.equal(parsed?.length, WIKI_MAX_PAGES);
  assert.equal(parsed?.[parsed.length - 1].index, WIKI_MAX_PAGES - 1);
});

test("fallbackPlanFromModules：模块拆页上限 6、空模块回落概览", () => {
  const plans = fallbackPlanFromModules(["src", "docs", "(root)", "tests", "ci", "web", "extra"]);
  assert.equal(plans.length, 6);
  assert.ok(plans[0].title.includes("src"));
  assert.equal(fallbackPlanFromModules([]).length, 1);
  assert.equal(fallbackPlanFromModules(["(root)"])[0].title.includes("项目概览"), true);
});

test("sanitizeWikiContent：粘连标题断行 + 元对话行删除 + 围栏内不动", () => {
  const dirty = [
    "先说结论。## 架构",
    "好的，下面是正文内容",           // 元对话（无 markdown 结构）→ 删
    "好的，**这不是元对话**",          // 含 ** → 保留
    "```text",
    "好的，这行在代码块里不删",
    "```",
    "现在整理成最终的 Markdown",
    "",
  ].join("\n");
  const clean = sanitizeWikiContent(dirty);
  assert.ok(clean.includes("。\n## 架构"));
  const lines = clean.split("\n");
  assert.ok(!lines.some((l) => l.trim() === "好的，下面是正文内容"));
  assert.ok(lines.some((l) => l.includes("好的，**这不是元对话**")));
  assert.ok(lines.some((l) => l.includes("好的，这行在代码块里不删")));
  assert.ok(!lines.some((l) => l.includes("现在整理成最终")));
});

test("needsContinuation：length 或奇数围栏触发", () => {
  assert.equal(needsContinuation("length", "完整```"), true);
  assert.equal(needsContinuation("stop", "停在```代码块内"), true);
  assert.equal(needsContinuation("stop", "正常```closed```"), false);
  assert.equal(needsContinuation("stop", "无围栏"), false);
});

test("prompts：规划/页面/总览各自包含关键约束", () => {
  const material = { baseContext: "DOC", tree: "TREE", sources: "SRC", topLevelModules: [] };
  const plan = buildPlanPrompt("Demo", material);
  assert.ok(plan.includes("3-6 个章节") && plan.includes("8-16 个"));
  assert.ok(plan.includes("DOC") && plan.includes("TREE"));
  const page = buildPagePrompt({
    projectName: "Demo",
    plan: { index: 0, chapter: "c", title: "t", brief: "b", covers: ["src/"] },
    siblingTitles: ["a", "b"],
    material,
    coveredContext: "EXTRA",
  });
  assert.ok(page.includes("本页主题") && page.includes("EXTRA") && page.includes("mermaid"));
  const overview = buildOverviewPrompt({
    projectName: "Demo",
    material,
    generatedPages: [{ chapter: "c", title: "t", brief: "" }],
  });
  assert.ok(overview.includes("总体架构") && overview.includes("文档导航"));
});
