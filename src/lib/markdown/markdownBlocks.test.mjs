/**
 * markdownBlocks 的自动化验证（S6 性能优化的正确性基石）。
 *
 * 重点：
 *   (a) 无损性：splitBlocks(t).join("") === t（全语料）。
 *   (b) 语义透明性：render(整篇) === render(逐块拼接)（全语料，仅归一化 <!-- -->）。
 *   (c) 结构：渲染预算的边界行为。
 *   (d) 前缀稳定性：text 增长时除最后一块外其余块逐字节相同（memo 命中前提）。
 *
 * 运行：node --test src/lib/markdown/markdownBlocks.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { splitBlocks, windowBlocks, MarkdownBlocks, hasDocumentScopedConstructs } from "./markdownBlocks.js";

const PLUGINS = [remarkGfm];

function renderWhole(text) {
  return renderToStaticMarkup(createElement(Markdown, { remarkPlugins: PLUGINS }, text));
}

/**
 * 渲染**真实组件** `MarkdownBlocks`，并剥掉其外层 `<div class="md-blocks">` 包裹，
 * 得到「逐块拼接」的 HTML。语料都很小（默认预算内不截断），故不会有展开按钮。
 */
function renderComponent(text) {
  const html = renderToStaticMarkup(createElement(MarkdownBlocks, { text }));
  // React 19 会把 <link rel="preload"> 之类提升到最前（如含图片时），md-blocks 包裹 div 紧随其后，
  // 故不能锚定 `^<div …>`。剥离包裹 div、保留其前置的提升内容，以便与整篇渲染逐字节比较。
  const m = /<div class="md-blocks">([\s\S]*)<\/div>/.exec(html);
  return m ? html.slice(0, m.index) + m[1] : html;
}

/** 唯一允许的归一化：去掉 React 在相邻文本节点间插入的注释分隔符。 */
function normalize(html) {
  return html.replace(/<!--\s*-->/g, "");
}

/** 混成长文：段落 + 列表 + ts 代码块 + GFM 表格 + 引用块（循环）。 */
function buildMixed(repeat) {
  const unit = [
    "## 小节标题",
    "",
    "这是一个段落，包含 `行内代码` 与 **粗体**，用于检验块切分与渲染一致性。",
    "",
    "- 列表项一",
    "- 列表项二",
    "",
    "```ts",
    "const answer = 42;",
    "function f() {",
    "  return answer;",
    "}",
    "```",
    "",
    "> 引用一句，用于检验引用块切分。",
    "",
    "| 列 A | 列 B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
  ].join("\n");
  return Array(repeat).fill(unit).join("\n");
}

/**
 * 容器内的文档作用域构造（修 5 补强）：定义写在**容器块内部**（引用块 `>`、列表项
 * `- ` `* ` `1.`），但作用域仍是整篇。全部必须整篇单块，语义透明性才成立。
 */
const CONTAINER_SCOPED_CASES = [
  { name: "引用块内引用定义", text: "> [a]: https://x\n\n[a]" },
  { name: "引用块内引用定义(紧贴>)", text: ">[a]: https://x\n\n[a]" },
  { name: "引用块内引用定义(>后2空格)", text: ">  [a]: https://x\n\n[a]" },
  { name: "嵌套引用块内引用定义", text: "> > [a]: https://x\n\n[a]" },
  { name: "引用块内脚注定义", text: "> [^1]: note\n\na[^1]" },
  { name: "引用块内引用定义+中间段落", text: "> [a]: https://x\n\n前言段落\n\n[a]" },
  { name: "无序列表内引用定义", text: "- [a]: https://x\n\n段落\n\n[a]" },
  { name: "有序列表内引用定义", text: "1. [a]: https://x\n\n段落\n\n[a]" },
  { name: "星号列表内引用定义", text: "* [a]: https://x\n\n段落\n\n[a]" },
  { name: "列表内脚注定义", text: "- [^1]: note\n\n段落\n\na[^1]" },
];

/**
 * 修 6：**列表项续行**的定义（无容器标记、行首缩进 ≥4，CommonMark 视为该列表项内容、
 * 作用域整篇）与**标签边界**（含转义 `\]`、标签恰为 `^`）。全部必须整篇单块。
 */
const FIX6_CASES = [
  { name: "D1 列表续行定义(10.)", text: "[a]\n\n10. x\n\n    [a]: https://y" },
  { name: "D2 列表续行脚注(10.)", text: "[^1]\n\n10. x\n\n    [^1]: note" },
  { name: "D3 列表续行定义(-)", text: "[a]\n\n- foo\n\n    [a]: https://y" },
  { name: "D4 列表续行定义(100.)", text: "[a]\n\n100. x\n\n     [a]: https://y" },
  { name: "D5 图片引用续行定义", text: "![x][img]\n\n10. y\n\n    [img]: https://z/i.png" },
  { name: "D6 列表续行定义+分隔段落", text: "10. x\n\n    [a]: https://y\n\n分隔段落\n\n[a]" },
  { name: "D7 列表续行脚注+分隔段落", text: "10. x\n\n    [^1]: note\n\n分隔段落\n\na[^1]" },
  { name: "D8 列表续行定义(-)+分隔段落", text: "- foo\n\n    [a]: https://y\n\n分隔段落\n\n[a]" },
  { name: "D9 嵌套列表续行定义", text: "- 10. foo\n\n      [a]: https://y\n\n分隔段落\n\n[a]" },
  { name: "D10 引用块内列表续行定义", text: "[a]\n\n> 10. x\n>\n>     [a]: https://y" },
  { name: "D11 列表续行多定义", text: "[a][b]\n\n10. x\n\n    [a]: https://y\n    [b]: https://z" },
  { name: "F1 转义标签定义(后置)", text: "[a\\]b]\n\n[a\\]b]: https://x" },
  { name: "F2 转义标签定义(前置)", text: "[a\\]b]: https://x\n\n[a\\]b]" },
  { name: "F3 容器内转义标签定义", text: "> [a\\]b]: https://x\n\n[a\\]b]" },
  { name: "F4 转义标签脚注定义", text: "a[^x\\]y]\n\n[^x\\]y]: note" },
  { name: "F5 标签恰为^的链接定义", text: "[^]: x\n\na[^]" },
  // 修 6 补强：**重复 / 交替的容器标记**（上一版 CONTAINER_PREFIX 用 `*` 本已覆盖，勿再丢）
  { name: "R1 重复标记 - - 定义", text: "[a]\n\n- - [a]: https://x" },
  { name: "R2 重复标记 - - - 定义", text: "[a]\n\n- - - [a]: https://x" },
  { name: "R3 重复标记 - - - - 定义", text: "[a]\n\n- - - - [a]: https://x" },
  { name: "R4 重复有序标记 1. 1. 定义", text: "[a]\n\n1. 1. [a]: https://x" },
  { name: "R5 交替标记 > - - 定义", text: "[a]\n\n> - - [a]: https://x" },
  { name: "R6 交替标记 - > - 定义", text: "[a]\n\n- > - [a]: https://x" },
  { name: "R7 重复标记脚注 - -", text: "a[^1]\n\n- - [^1]: note" },
];

const CORPUS = [
  { name: "空串", text: "" },
  { name: "纯空白", text: "   \n\n\t\n  " },
  { name: "单块文本", text: "只有一个段落。" },
  { name: "两段", text: "第一段。\n\n第二段。" },
  { name: "三段", text: "A\n\nB\n\nC\n" },
  { name: "紧凑列表", text: "- 一\n- 二\n- 三\n" },
  { name: "松散列表(空行分隔)", text: "- 一\n\n- 二\n\n- 三\n" },
  { name: "嵌套列表", text: "- 一\n  - 一.a\n  - 一.b\n- 二\n" },
  { name: "有序列表", text: "1. 一\n2. 二\n3. 三\n" },
  { name: "列表后段落", text: "- 一\n- 二\n\n列表后的段落。\n" },
  { name: "两列表间夹段落", text: "- 一\n\n段落\n\n- 二\n" },
  { name: "反引号围栏", text: "前言\n\n```ts\nconst a = 1;\n```\n\n后记\n" },
  { name: "波浪围栏", text: "前言\n\n~~~\ncode line\n~~~\n\n后记\n" },
  { name: "未闭合围栏", text: "前面\n\n```ts\nfunction f() {\n  return 1;\n" },
  { name: "围栏内含空行与井号", text: "a\n\n```\n\n# 不是标题\n\nb\n```\n\nc\n" },
  { name: "围栏带缩进", text: "顶\n\n   ```\n   x\n   ```\n\n底\n" },
  { name: "GFM表格", text: "| a | b |\n|---|---|\n| 1 | 2 |\n\n表后段落。\n" },
  { name: "表格后紧跟段落", text: "| a | b |\n| - | - |\n| 1 | 2 |\n后续段落\n" },
  { name: "setext标题", text: "这是标题\n===\n\n正文。\n" },
  { name: "atx标题", text: "# 标题一\n\n## 标题二\n\n正文\n" },
  { name: "引用块", text: "> 引用一\n> 引用二\n\n普通段落\n" },
  { name: "缩进代码块", text: "前言\n\n    这是缩进代码\n    第二行\n\n后记\n" },
  { name: "缩进代码块含空行", text: "    代码一\n\n    代码二\n" },
  { name: "行内代码含反引号", text: "这是 `a` 和 ``b`c`` 和普通 `x`。\n\n下一段。\n" },
  { name: "CRLF", text: "第一段\r\n\r\n第二段\r\n" },
  { name: "分隔线", text: "段一\n\n---\n\n段二\n" },
  { name: "混成长文", text: buildMixed(3) },

  // —— 文档作用域构造（S6 修复 5）：这些必须整篇单块，语义透明性才成立 ——
  { name: "跨块引用定义(后置)", text: "[a]\n\n[a]: https://x\n" },
  { name: "引用定义大小写不敏感", text: "[A] u\n\n[a]: https://x\n" },
  { name: "引用定义带标题", text: "[a]\n\n[a]: https://x \"t\"\n" },
  { name: "多定义同块", text: "[a] [b]\n\n[a]: https://x\n[b]: https://y\n" },
  { name: "脚注定义在后", text: "a[^1]\n\n[^1]: 脚注内容\n" },
  { name: "脚注定义在前", text: "[^1]: 脚注内容\n\na[^1]\n" },
  { name: "HTML script 含空行", text: "<script>\n\nx\n\n</script>\n" },
  { name: "HTML pre 含空行", text: "<pre>\n\nx\n\n</pre>\n" },
  { name: "HTML style 含空行", text: "<style>\n\nx\n\n</style>\n" },
  { name: "HTML textarea 含空行", text: "<textarea>\n\nx\n\n</textarea>\n" },
  { name: "HTML 注释含空行", text: "<!--\n\nx\n\n-->\n" },
  { name: "HTML 处理指令(type3)", text: "<?\n\nx\n\n?>\n" },
  { name: "HTML 声明(type4)", text: "<!DECL\n\nx\n\n>\n" },
  { name: "HTML CDATA(type5)", text: "<![CDATA[\n\nx\n\n]]>\n" },
  // —— 容器内的文档作用域构造（修 5 补强）：定义写在引用块/列表项内，作用域仍是整篇 ——
  ...CONTAINER_SCOPED_CASES,
  // —— 列表续行定义 + 标签边界（修 6）：无标记缩进 ≥4 的定义、转义标签、`^` 标签 ——
  ...FIX6_CASES,
  // 对照：type 6 的 <div> 遇空行即结束 → 合法切分，语义仍透明（本应通过）。
  { name: "对照: HTML div(type6)", text: "<div>\nx\n\ny\n</div>\n" },
  // 对照：顶层 4 空格缩进 = 缩进代码块（**非**定义）。修 6 后放宽缩进锚定 → **会被命中**
  //（预期误报：整篇渲染仍正确，只是失去优化）。留在语义透明性语料中自然通过（单块 = 整篇）。
  { name: "对照: 4空格缩进引用定义(缩进代码块·预期误报)", text: "    [a]: https://x\n\n[a]\n" },
  // 对照：容器内普通文本（无 `]:`）→ 不命中。
  { name: "对照: 容器内普通文本(引用)", text: "> 普通引用文本\n\n段落\n" },
];

// ---------------------------------------------------------------------------
// (a) 无损性
// ---------------------------------------------------------------------------

test("(a) 无损性：splitBlocks(t).join('') === t（全语料）", () => {
  for (const sample of CORPUS) {
    const chunks = splitBlocks(sample.text);
    assert.equal(
      chunks.join(""),
      sample.text,
      `样本「${sample.name}」切分后拼接应逐字节等于原文`,
    );
  }
});

// ---------------------------------------------------------------------------
// (b) 语义透明性（最重要）
// ---------------------------------------------------------------------------

test("(b) 语义透明：render(整篇) === render(逐块拼接)（全语料，仅归一化 <!-- -->）", () => {
  for (const sample of CORPUS) {
    const chunks = splitBlocks(sample.text);
    const whole = normalize(renderWhole(sample.text));
    const parts = normalize(renderComponent(sample.text));
    assert.equal(
      parts,
      whole,
      `样本「${sample.name}」：逐块渲染必须等于整篇渲染（blocks=${chunks.length}）`,
    );
  }
});

// ---------------------------------------------------------------------------
// (c) 渲染预算结构
// ---------------------------------------------------------------------------

test("(c) 渲染预算：预算足够不截断；不足则截断；预算 0/负数仍至少返回第一块", () => {
  const blocks = ["aaaa", "bbbb", "cccc", "dddd"];

  const enough = windowBlocks(blocks, { budget: 1000 });
  assert.deepEqual(enough.visible, blocks);
  assert.equal(enough.truncated, false);
  assert.equal(enough.hiddenChars, 0);
  assert.equal(enough.hiddenBlocks, 0);

  const two = windowBlocks(blocks, { budget: 8 });
  assert.deepEqual(two.visible, ["aaaa", "bbbb"]);
  assert.equal(two.hiddenChars, 8);
  assert.equal(two.hiddenBlocks, 2);
  assert.equal(two.truncated, true);
  assert.ok(two.visible.length <= blocks.length);

  const zero = windowBlocks(blocks, { budget: 0 });
  assert.deepEqual(zero.visible, ["aaaa"], "预算为 0 仍至少返回第一块");
  assert.equal(zero.hiddenBlocks, 3);

  const negative = windowBlocks(blocks, { budget: -5 });
  assert.deepEqual(negative.visible, ["aaaa"], "负预算仍至少返回第一块");

  const empty = windowBlocks([]);
  assert.deepEqual(empty.visible, []);
  assert.equal(empty.truncated, false);
  assert.equal(empty.hiddenChars, 0);

  const dflt = windowBlocks(blocks);
  assert.equal(dflt.visible.length, 4, "默认预算下应全部可见");
});

// ---------------------------------------------------------------------------
// (d) 前缀稳定性（memo 命中的前提）
// ---------------------------------------------------------------------------

test("(d) 前缀稳定性：text 增长时，除最后一块外其余块逐字节相同", () => {
  const doc = buildMixed(6);
  let checked = 0;
  for (let k = 0; k < doc.length; k += 1) {
    const a = splitBlocks(doc.slice(0, k));
    const b = splitBlocks(doc.slice(0, k + 1));
    const stable = Math.min(a.length, b.length) - 1;
    if (stable > 0) {
      assert.deepEqual(
        a.slice(0, stable),
        b.slice(0, stable),
        `k=${k}：公共前缀块应逐字节相同（否则 memo 无法命中）`,
      );
      checked += 1;
    }
  }
  assert.ok(checked > 0, "应至少校验到若干非平凡前缀");
});

// ---------------------------------------------------------------------------
// (e) hasDocumentScopedConstructs：正例逐类 + 反例（含刻意误报）
// ---------------------------------------------------------------------------

test("(e) hasDocumentScopedConstructs：逐类正例命中", () => {
  const positives = [
    ["链接引用定义", "[a]: https://x\n\n正文 [a]\n"],
    ["GFM 脚注定义", "正文[^1]\n\n[^1]: 说明\n"],
    ["HTML type1 script", "<script>\nx\n</script>\n"],
    ["HTML type1 pre", "<pre>\nx\n</pre>\n"],
    ["HTML type1 style", "<style>\nx\n</style>\n"],
    ["HTML type1 textarea", "<textarea>\nx\n</textarea>\n"],
    ["HTML type2 注释", "<!-- x -->\n"],
    ["HTML type3 处理指令", "<?php echo 1; ?>\n"],
    ["HTML type4 声明", "<!DOCTYPE html>\n"],
    ["HTML type5 CDATA", "<![CDATA[x]]>\n"],
  ];
  for (const [name, text] of positives) {
    assert.equal(hasDocumentScopedConstructs(text), true, `应命中：${name}`);
  }
});

test("(e) hasDocumentScopedConstructs：反例不误报；围栏内定义属刻意误报（只损失性能）", () => {
  // 正常文档：不应命中。
  assert.equal(hasDocumentScopedConstructs(buildMixed(1)), false);
  assert.equal(hasDocumentScopedConstructs("普通段落\n\n- 列表\n- 项\n"), false);
  assert.equal(hasDocumentScopedConstructs(""), false);
  // 锚文本/脚注“引用”而非“定义”：不命中（定义才带 `]:`）。
  assert.equal(hasDocumentScopedConstructs("这是 [链接](https://x) 与 [^1] 引用。\n"), false);

  // 刻意误报：定义出现在**代码围栏内**也会命中 → 预期为 true，只损失性能、不损失正确性。
  const insideFence = "```\n[a]: https://x\n```\n\n普通段落\n";
  assert.equal(
    hasDocumentScopedConstructs(insideFence),
    true,
    "围栏内的引用定义会误报为 true（预期行为：只损失性能）",
  );
  // 对应的完整文档此时应整体退回单块渲染。
  assert.deepEqual(splitBlocks(insideFence), [insideFence]);
});

// ---------------------------------------------------------------------------
// (f) 优化未被整体关闭：正常长文档必须切成多块
// ---------------------------------------------------------------------------

test("(f) 优化未被整体关闭：正常长文档仍切成多块（不是退化为 [text]）", () => {
  const normal = buildMixed(3);
  const blocks = splitBlocks(normal);
  assert.ok(blocks.length > 1, `正常长文档必须多块，实际 blocks=${blocks.length}`);
  assert.ok(blocks.length >= 10, `正常长文档块数应显著大于 1，实际 blocks=${blocks.length}`);
  assert.equal(hasDocumentScopedConstructs(normal), false, "正常语料不应命中文档作用域构造");

  // 更大的混成长文块数应随之增长（数十~数百量级）。
  const baseCount = blocks.length;
  const biggerBlocks = splitBlocks([normal, normal, normal].join("\n"));
  assert.ok(
    biggerBlocks.length >= baseCount,
    `更大文档块数应不少于更小文档（${biggerBlocks.length} vs ${baseCount}）`,
  );
});

// ---------------------------------------------------------------------------
// (g) 容器内的文档作用域构造：识别 + 整篇单块（修 5 补强）
// ---------------------------------------------------------------------------

test("(g) 容器内的文档作用域构造：hasDocumentScopedConstructs=true 且 splitBlocks 返回单块", () => {
  for (const sample of CONTAINER_SCOPED_CASES) {
    assert.equal(
      hasDocumentScopedConstructs(sample.text),
      true,
      `应识别为文档作用域构造：${sample.name}`,
    );
    assert.equal(splitBlocks(sample.text).length, 1, `应整篇单块：${sample.name}`);
  }
});

// ---------------------------------------------------------------------------
// (h) 优化未被整体禁用（补强）：30 份普通文档拼接仍切成大量块
// ---------------------------------------------------------------------------

test("(h) 普通文档不被整体禁用优化：30 份普通文档拼接仍切成 ≥100 块", () => {
  const NORMAL_DOC = [
    "# 标题",
    "",
    "正文段落，含 `行内代码` 与 **强调**。",
    "",
    "```ts",
    "const x = 1;",
    "```",
    "",
    "> 引用一句。",
    "",
    "| 列 A | 列 B |",
    "| --- | --- |",
    "| 1 | 2 |",
  ].join("\n");
  const joined = Array(30).fill(NORMAL_DOC).join("\n\n");
  assert.equal(hasDocumentScopedConstructs(joined), false, "普通文档不应命中文档作用域构造");
  const blocks = splitBlocks(joined);
  assert.ok(blocks.length >= 100, `30 份普通文档应切成 ≥100 块，实际 blocks=${blocks.length}`);
});

// ---------------------------------------------------------------------------
// (i) 列表续行定义 / 标签边界（修 6）：识别 + 整篇单块
// ---------------------------------------------------------------------------

test("(i) 列表续行定义与标签边界：hasDocumentScopedConstructs=true 且 splitBlocks 返回单块", () => {
  for (const sample of FIX6_CASES) {
    assert.equal(
      hasDocumentScopedConstructs(sample.text),
      true,
      `应识别为文档作用域构造：${sample.name}`,
    );
    assert.equal(splitBlocks(sample.text).length, 1, `应整篇单块：${sample.name}`);
  }
});

// ---------------------------------------------------------------------------
// (j) ReDoS 哨兵：敌意输入下 hasDocumentScopedConstructs 必须 < 50ms（线性）
// ---------------------------------------------------------------------------

test("(j) ReDoS 哨兵：敌意输入 < 50ms，且随 n 近似线性（无持续 ~4× / O(n²) 增长）", () => {
  const best = (text, reps) => {
    let b = Infinity;
    for (let i = 0; i < reps; i += 1) {
      const start = performance.now();
      hasDocumentScopedConstructs(text);
      b = Math.min(b, performance.now() - start);
    }
    return b;
  };

  // 绝对上界：大体积敌意输入必须 < 50ms。
  const hostile = [
    " ".repeat(50000),
    ">".repeat(50000),
    "[a".repeat(20000),
    "[a]".repeat(20000),
    "- ".repeat(20000),
    "- > ".repeat(20000),
  ];
  for (const text of hostile) {
    const ms = best(text, 3);
    assert.ok(
      ms < 50,
      `敌意输入（前 8 字符 ${JSON.stringify(text.slice(0, 8))}，长度 ${text.length}）耗时 ${ms.toFixed(1)}ms 应 < 50ms`,
    );
  }

  // 标度：n 翻倍（8000→32000 为 4×）耗时不得出现 O(n²)（4× n 若二次 ≈16×，线性 ≈4×，阈值 10）。
  const gens = {
    "纯空格行": (n) => " ".repeat(n),
    "纯>行": (n) => ">".repeat(n),
    "[a 重复": (n) => "[a".repeat(n),
    "[a] 重复": (n) => "[a]".repeat(n),
    "'- ' 重复": (n) => "- ".repeat(n),
    "'- - ' 重复": (n) => "- - ".repeat(n),
    "'1. ' 重复": (n) => "1. ".repeat(n),
    "'- > ' 重复": (n) => "- > ".repeat(n),
    "' [ ' 交替": (n) => " [ ".repeat(n),
    "长标签无冒号": (n) => "[" + "a".repeat(n) + "]",
    "混合 ' - - - '": (n) => "- - - ".repeat(n),
  };
  const NS = [4000, 8000, 16000, 32000];
  for (const [name, gen] of Object.entries(gens)) {
    const t = NS.map((n) => best(gen(n), 3));
    assert.ok(t[2] < 50, `${name} n=16000 耗时 ${t[2].toFixed(1)}ms 应 < 50ms`);
    assert.ok(t[3] < 50, `${name} n=32000 耗时 ${t[3].toFixed(1)}ms 应 < 50ms`);
    const grow = t[3] / Math.max(t[1], 0.3); // 8000→32000 = 4× n；线性≈4×、二次≈16×
    assert.ok(grow < 10, `${name} 8000→32000 倍率 ${grow.toFixed(2)} 应 < 10（排除 O(n²)）`);
  }
});

test("(k) 夹具完整性：D5 整篇与逐块渲染都含被 React 提升的 <link rel=preload>", () => {
  const d5 = FIX6_CASES.find((c) => c.name.startsWith("D5"));
  assert.ok(d5, "FIX6_CASES 应含 D5");
  const whole = renderWhole(d5.text);
  const parts = renderComponent(d5.text);
  assert.ok(/rel="preload"/.test(whole), "整篇渲染应含被提升的 rel=preload（夹具不得整段吞掉）");
  assert.ok(/rel="preload"/.test(parts), "逐块渲染应含被提升的 rel=preload（否则比较强度被静默放宽）");
});
