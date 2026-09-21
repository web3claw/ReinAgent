/**
 * markdownBlocks —— Markdown 渲染的**块级切分 + 渲染预算 + 记忆化组装**（核心性能层）。
 *
 * 为什么要这个模块（S6 性能优化）：
 *   原 `MarkdownText` 每个 delta 都把**整篇** Markdown 交给 react-markdown 全量重解析。
 *   流式下 text 每个 delta 都变 → N 个 delta = N 次全量解析，成本 ≈ O(N × 全文长度)：
 *   一条 20KB 的回答在流式过程中会累计烧掉 ≈40s CPU（团队实测 43.7s / 1000 delta）。
 *
 * 本模块的收益来自**记忆化**（不是节流/debounce）：
 *   1. `splitBlocks` 把整篇切成**顶层块**（代码围栏 / 列表 / 表格 / 引用 / 缩进代码等
 *      语义边界安全），且**无损**（`splitBlocks(t).join("") === t`）；
 *   2. `MarkdownBlocks` 每个块渲染成**独立的 memo 子组件**。流式时只有**最后一块**在变，
 *      于是每个 delta 只重解析最后一块 → 从 O(N × 全文) 降到 O(每块长度之和)。
 *
 * 本文件是**纯模块**（`.js` + `React.createElement`，不用 JSX），与 conversationModel /
 * stateBridge 同属「纯逻辑 + 可无头驱动」的模式：测试与基准脚本能直接 import 真实代码。
 *
 * 安全（硬要求，勿动）：只启用 `remark-gfm`；**绝不启用 `rehype-raw` 或任何 rehype HTML 插件**。
 *
 * 类型声明见同目录 `markdownBlocks.d.ts`。
 */

import { createElement, memo, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** 首次渲染的字符预算（约 60KB）：应对「200KB 一巴掌拍上来」时首帧卡死。 */
export const INITIAL_RENDER_CHAR_BUDGET = 60000;

const REMARK_PLUGINS = [remarkGfm];

/** 顶层列表标记：缩进 ≤3 的 `-` `+` `*` 或 `1.` `1)`（标记后须为空白或行尾）。 */
const TOP_LIST_RE = /^ {0,3}([-+*]|\d{1,9}[.)])(\s|$)/;
/** 围栏开始：缩进 ≤3 的 ``` 或 ~~~，后接可选 info string。 */
const FENCE_OPEN_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
/** 围栏结束：缩进 ≤3、同字符、长度 ≥ 开始围栏、其后仅空白。 */
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

function stripEol(line) {
  return line.replace(/\r?\n$/, "");
}

function leadingWs(line) {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0].length : 0;
}

/** 若该行开启一个代码围栏，返回 { ch, len }；否则 null。 */
function matchFenceOpen(line) {
  const m = FENCE_OPEN_RE.exec(line);
  if (m === null) return null;
  const marker = m[2];
  const ch = marker[0];
  const info = m[3] ?? "";
  // 反引号围栏的 info string 不得含反引号。
  if (ch === "`" && info.includes("`")) return null;
  return { ch, len: marker.length };
}

/** 该行是否关闭当前围栏。 */
function isFenceClose(line, fence) {
  const m = FENCE_CLOSE_RE.exec(line);
  if (m === null) return false;
  const marker = m[1];
  return marker[0] === fence.ch && marker.length >= fence.len;
}

/**
 * 定义行探测：**不锚定缩进**，允许任意空白、任意层级/任意个数的引用块 `>` 与列表标记。
 *
 * 为什么放宽（修 6）：CommonMark 允许定义是**列表项的续行** —— 此时定义行**没有容器标记**、
 *   行首缩进可 ≥4（如 `10. x` 标记宽 4，其续行 `    [a]: url` 缩进 4 仍是该列表项内容，
 *   作用域仍是整篇）。行正则**无法**区分「顶层 4 空格缩进代码块里的 [a]: x」与
 *   「列表项续行的定义」，故按本模块既定取舍（宁可误报只损失性能，绝不漏报损失正确性）一律命中。
 *
 * 覆盖：顶层 / 容器内（`>`、`-`、`1.`、`> -`、`- >`）的显式标记写法；**可重复/交替的容器标记**
 *   （`- - - [a]:`、`1. 1. [a]:`、`> - - [a]:`、`- > - [a]:`）；列表项续行的无标记缩进写法
 *   （含 `100.`、嵌套 `- 10.` 等宽标记）；标签含转义 `\]`（`[a\]b]: url`）；标签恰为 `^`
 *   （`[^]: x` 是链接定义而非脚注）→ 与 GFM 脚注定义一并命中。
 * 不匹配：普通段落、`[a]` 这类**引用**（无 `]:`）、以 `|` 开头的表格行、`- [x] 待办`（无冒号）。
 *
 * ⚠ 线性安全（勿改结构）：`[ \t>]*(?:(?:[-+*]|\d{1,9}[.)])[ \t>]*)*\[` 中，外层 `[ \t>]*`
 *   与组内 `[ \t>]*` **不会**产生同字符类的可选切分 —— 因为组的每一轮**必须先消费一个非空标记**
 *   B（`-`/`+`/`*`/数字），B 与 A=`[ \t>]` **不相交**，故轮次由 B 的个数唯一确定。
 *   切勿写成「可选标记 + 外层紧邻 `[ \t>]*`」的兄弟写法（`(?:B)?[ \t>]*`）—— 那会让两个
 *   `[ \t>]*` 在标记为空时相邻，在纯空格 / 纯 `>` 行上 O(n²) 回溯（实测 n=16k 已 186ms、
 *   n=50k 逾秒）。本写法标记组用 `*`（保留重复/交替容器标记覆盖），实测线性：`- > `×128k
 *   仅 2.3ms、`- - `×128k 仅 2.4ms（best-of-5，每翻倍 ≈2×）。
 */
const DEFINITION_LINE_RE = /^[ \t>]*(?:(?:[-+*]|\d{1,9}[.)])[ \t>]*)*\[(?:\\.|[^\]\\])+\]:/m;

/**
 * 「文档作用域」构造的探测正则。命中任一 → 该文档**不按块切分**（整篇单块渲染）。
 *
 * 为什么：有三类 Markdown 构造**不是块局部的**，按空行切开会让它们在跨块解析时丢失语义：
 *   1. 链接引用定义 `[label]: dest "title"` —— 文档作用域：块 A 的 `[a]` 要解析到块 B 的定义；
 *      切开 → 链接退化为纯文本（**可见降级**）。定义可位于容器块内、或作为列表项续行（见上）。
 *   2. GFM 脚注定义 `[^label]: …` —— 同样文档作用域；切开 → 脚注消失。
 *   3. HTML type 1/2（`<script|pre|style|textarea`、`<!-- -->`）—— CommonMark 允许其**含空行**，
 *      仅遇配对结束标记才结束；切开 → 中段被重新解析成段落。
 *   另附 type 3/4/5（`<?`、`<!`+字母、`<![CDATA[`）——同为可跨空行的 HTML 块。
 *
 * ⚠ 刻意的不对称取舍：这里**不考虑**「定义/标签出现在代码围栏内」「顶层 4 空格缩进代码块内的
 *   `[a]: x`」这类**误判** —— 误判只会让该文档**失去优化**（退回整篇解析），**不损失正确性**。
 *   宁可多报。
 */
const DOCUMENT_SCOPED_RES = [
  DEFINITION_LINE_RE, // 链接引用定义 / GFM 脚注定义（含容器内、列表续行、转义标签）
  /^ {0,3}<(script|pre|style|textarea)(\s|>|$)/im, // HTML type 1
  /^ {0,3}<!--/m, // HTML type 2
  /^ {0,3}<\?/m, // HTML type 3
  /^ {0,3}<![A-Za-z]/m, // HTML type 4
  /^ {0,3}<!\[CDATA\[/m, // HTML type 5
];

/**
 * 文本是否含**文档作用域**构造（含则不应按块切分）。
 * 保守实现：宁可误报（只损失性能）也不漏报（会损失正确性）。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasDocumentScopedConstructs(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  for (const re of DOCUMENT_SCOPED_RES) {
    if (re.test(text)) return true;
  }
  return false;
}

/**
 * 把 Markdown 文本切成**顶层块**数组。
 *
 * 切分点：代码围栏之外的**顶层块边界**（空行分隔），且**不切断**列表 / 缩进代码块
 * （否则松散列表会退化为多个紧凑列表、缩进代码块会被拆成多块，语义与 DOM 都变）。
 *
 * **无损保证**：`splitBlocks(t).join("") === t`（含所有换行、含 CRLF）。
 *
 * 边界：空串 → `[]`；纯空白 → 原样一块；单块 → 长度 1 的数组。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitBlocks(text) {
  if (typeof text !== "string" || text.length === 0) return [];

  // 含文档作用域构造（链接引用定义 / GFM 脚注 / 可跨空行的 HTML 块）→ 整篇单块，
  // 退回整篇解析路径（可证明正确；代价只是这些文档失去优化）。
  if (hasDocumentScopedConstructs(text)) return [text];

  /** 各顶层块**起始偏移**（按行首对齐）。 */
  const starts = [];
  let offset = 0; // 当前行起始偏移
  let fence = null; // 打开的围栏 { ch, len } 或 null
  let listActive = false; // 当前是否处于某个列表块内
  let indentedCode = false; // 当前是否处于缩进代码块内
  let seenBlock = false; // 是否已经历首个块
  let blankRun = 0; // 自上个非空行以来的连续空行数

  const len = text.length;
  let i = 0;
  while (i < len) {
    let j = text.indexOf("\n", i);
    j = j === -1 ? len : j + 1; // 行含结尾 \n（若有）
    const raw = text.slice(i, j);
    const stripped = stripEol(raw);
    const isBlank = /^[ \t]*$/.test(stripped);

    // —— 围栏内：直到出现关闭围栏，全部作为同一块内容 ——
    if (fence !== null) {
      if (isFenceClose(stripped, fence)) fence = null;
      blankRun = isBlank ? blankRun + 1 : 0;
      offset = j;
      i = j;
      continue;
    }

    // —— 空行：暂记为可能的边界，等下一个非空行再决定 ——
    if (isBlank) {
      blankRun += 1;
      offset = j;
      i = j;
      continue;
    }

    const indent = leadingWs(stripped);
    const isListM = TOP_LIST_RE.test(stripped);
    const fenceOpen = matchFenceOpen(stripped);
    const isIndentedCodeLine = indent >= 4;

    let blockStart;
    if (!seenBlock) {
      blockStart = true;
    } else if (blankRun === 0) {
      // 无空行 → 上一块的延续（段落续行 / 列表项续行 / 懒续行）。
      blockStart = false;
    } else if (listActive) {
      // 处于列表内：判断是否仍属同一列表。是 → 不切；否（列表结束）→ 保守地**也不切**，
      // 因为「列表尾部的空行」会影响该列表的松散/紧凑语义，切开会导致渲染不一致。
      const continuesList = isListM || indent >= 2;
      if (continuesList) {
        blockStart = false;
      } else {
        listActive = false;
        blockStart = false;
      }
    } else if (indentedCode) {
      // 处于缩进代码块内：后续仍缩进 → 同一代码块（空行也是其内容）；否则代码块结束。
      if (isIndentedCodeLine) {
        blockStart = false;
      } else {
        indentedCode = false;
        blockStart = true;
      }
    } else {
      // 普通空行分隔的两个顶层块 → 安全的切分点。
      blockStart = true;
    }

    if (blockStart) starts.push(offset);

    if (fenceOpen !== null) {
      fence = fenceOpen;
    }
    if (isListM) {
      listActive = true;
      indentedCode = false;
    } else if (!listActive && fenceOpen === null && isIndentedCodeLine) {
      indentedCode = true;
    }

    seenBlock = true;
    blankRun = 0;
    offset = j;
    i = j;
  }

  // 纯空白（无任何非空行）→ 原样一块。
  if (starts.length === 0) return [text];

  const chunks = [];
  for (let k = 0; k < starts.length; k += 1) {
    const from = k === 0 ? 0 : starts[k]; // 首块从 0 起（含前导空白），后续从块首起
    const to = k + 1 < starts.length ? starts[k + 1] : text.length;
    chunks.push(text.slice(from, to));
  }
  return chunks;
}

/**
 * 渲染预算：给定块数组与字符预算，返回可见部分与隐藏统计。
 * 按顺序累计到预算即截断；**至少渲染第一块**（避免「什么都没有」）。
 * 纯函数，无 React。
 *
 * @param {string[]} blocks
 * @param {{ budget?: number }} [options]
 * @returns {{ visible: string[], hiddenChars: number, hiddenBlocks: number, truncated: boolean }}
 */
export function windowBlocks(blocks, options) {
  const budget =
    options && typeof options.budget === "number" ? options.budget : INITIAL_RENDER_CHAR_BUDGET;

  if (!Array.isArray(blocks) || blocks.length === 0) {
    return { visible: [], hiddenChars: 0, hiddenBlocks: 0, truncated: false };
  }

  const visible = [];
  let used = 0;
  for (let i = 0; i < blocks.length; i += 1) {
    // i === 0 时无条件纳入（至少渲染第一块）。
    if (i > 0 && used + blocks[i].length > budget) break;
    visible.push(blocks[i]);
    used += blocks[i].length;
  }

  let hiddenChars = 0;
  for (let i = visible.length; i < blocks.length; i += 1) hiddenChars += blocks[i].length;
  const hiddenBlocks = blocks.length - visible.length;
  return { visible, hiddenChars, hiddenBlocks, truncated: hiddenBlocks > 0 };
}

/**
 * 单个块的渲染（memo）：**只有当 `text` 变化时才重新解析**。
 * 这是「流式只重解析最后一块」的关键。
 */
const MarkdownBlock = memo(
  function MarkdownBlock(props) {
    return createElement(Markdown, { remarkPlugins: REMARK_PLUGINS }, props.text);
  },
  function areBlockPropsEqual(prev, next) {
    return prev.text === next.text;
  },
);

/**
 * 块级 Markdown 渲染组件（`React.createElement`，不用 JSX）。
 *
 * @param {{ text: string, budget?: number }} props
 */
export function MarkdownBlocks(props) {
  const text = typeof props.text === "string" ? props.text : "";
  const baseBudget =
    typeof props.budget === "number" ? props.budget : INITIAL_RENDER_CHAR_BUDGET;

  const [expanded, setExpanded] = useState(false);

  // ★ 记忆化切分与预算：splitBlocks / windowBlocks 均为 O(全文)，若每次渲染都重跑，
  //   流式下每个 delta 仍会扫全文（含 hasDocumentScopedConstructs 的多个正则）——
  //   S6 想省的 O(N × 全文) 会被切分本身吃回去。text / budget 不变即复用上次结果。
  const blocks = useMemo(() => splitBlocks(text), [text]);
  const base = useMemo(() => windowBlocks(blocks, { budget: baseBudget }), [blocks, baseBudget]);
  const showAll = expanded && base.truncated;
  const visible = showAll ? blocks : base.visible;

  // 用 "\n" 文本节点分隔各块：react-markdown 渲染整篇时会在顶层块之间插入 "\n"
  // 分隔符；逐块渲染要与之**逐字节一致**（见测试 (b) 的语义透明性断言），
  // 因此在块之间补回同样的分隔符（HTML 中块间的空白不产生视觉影响）。
  const children = [];
  for (let index = 0; index < visible.length; index += 1) {
    if (index > 0) children.push("\n");
    children.push(createElement(props.renderBlock || MarkdownBlock, { key: index, text: visible[index] }));
  }

  if (base.truncated) {
    children.push(
      createElement(
        "button",
        {
          key: "__md-blocks-toggle__",
          type: "button",
          className: "btn md-blocks-toggle",
          onClick: () => setExpanded((value) => !value),
        },
        showAll
          ? "收起"
          : `展开全文（还有 ${base.hiddenChars} 字符 / ${base.hiddenBlocks} 段）`,
      ),
    );
  }

  return createElement("div", { className: "md-blocks" }, children);
}
