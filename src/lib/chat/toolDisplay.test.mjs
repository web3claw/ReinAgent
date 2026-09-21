/**
 * toolDisplay 的自动化验证（纯逻辑，node --test 直跑）。
 *
 * 运行：node --test src/lib/chat/toolDisplay.test.mjs
 *
 * 重点（对应本项目栽过的坑）：
 *   - 截断必须按 **Unicode 码点**，不能按 UTF-16 code unit。若用 `slice()`，
 *     会在代理对中间切开、产出孤立代理。为此：
 *       1. 输入覆盖 `ASCII 前缀长度 × 字符字节宽度` 的**笛卡尔积**
 *          （0–4 个 ASCII 前缀 × é(2B) / 中(3B) / 🀄(4B)）；
 *       2. 对每个组合**扫描全部截断边界**，断言输出无孤立代理、且是原串合法前缀；
 *       3. 额外用「UTF-16 slice 版错误实现」做对照，证明本夹具具备**判别力**
 *          （错误实现在这些输入上确实会产出孤立代理）。
 *   - 值里的真实控制字符（\r / \n / \t）必须转义为可见序列，不得撑坏单行参数行（见 2b）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatToolArgs } from "./toolDisplay.js";

/** 孤立代理检测：命中即说明 UTF-16 代理对被切坏。 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ---------------------------------------------------------------------------
// 1 · 空 / 缺省
// ---------------------------------------------------------------------------
test("空参数：undefined / null / {} 一律返回空串（标题行不拖空括号）", () => {
  assert.equal(formatToolArgs(), "");
  assert.equal(formatToolArgs(undefined), "");
  assert.equal(formatToolArgs(null), "");
  assert.equal(formatToolArgs({}), "");
});

// ---------------------------------------------------------------------------
// 2 · 值渲染规则
// ---------------------------------------------------------------------------
test("值渲染：string 双引号 + 转义；number/boolean/bigint/ null/undefined；数组 / 嵌套对象 → JSON", () => {
  assert.equal(formatToolArgs({ a: "hi" }), 'a="hi"');
  // 内部双引号被转义。
  assert.equal(formatToolArgs({ a: 'he said "hi"' }), 'a="he said \\"hi\\""');
  // 内部反斜杠被转义（先转义反斜杠，再转义引号）。
  assert.equal(formatToolArgs({ a: "c:\\x" }), 'a="c:\\\\x"');
  assert.equal(formatToolArgs({ a: 42 }), "a=42");
  assert.equal(formatToolArgs({ a: -3.5 }), "a=-3.5");
  assert.equal(formatToolArgs({ a: true, b: false }), "a=true, b=false");
  assert.equal(formatToolArgs({ a: 10n }), "a=10");
  assert.equal(formatToolArgs({ a: null }), "a=null");
  assert.equal(formatToolArgs({ a: undefined }), "a=undefined");
  assert.equal(formatToolArgs({ a: [1, 2, 3] }), "a=[1,2,3]");
  assert.equal(formatToolArgs({ a: { b: 1 } }), 'a={"b":1}');
  // 嵌套数组 + 对象混合。
  assert.equal(formatToolArgs({ a: [{ b: 1 }, 2] }), 'a=[{"b":1},2]');
});

// ---------------------------------------------------------------------------
// 2b · ★ 控制字符转义：值里含真实换行/回车/制表时不得撑坏单行参数行
// ---------------------------------------------------------------------------
test("★ 控制字符转义：CRLF / 孤立 CR / 孤立 LF / TAB 输出不含任何真实控制字符；反斜杠与引号行为未回归", () => {
  const CR = "\r";
  const LF = "\n";
  const TAB = "\t";

  const cases = [
    { label: "CRLF", value: `a${CR}${LF}b` },
    { label: "孤立 CR", value: `a${CR}b` },
    { label: "孤立 LF", value: `a${LF}b` },
    { label: "TAB", value: `a${TAB}b` },
    { label: "混合 + 反斜杠 + 引号", value: `x${CR}${LF}${TAB}\\z"y` },
  ];
  for (const { label, value } of cases) {
    const out = formatToolArgs({ a: value });
    // ★ 核心：输出里绝不含任何真实控制字符（U+0000–U+001F）。
    assert.equal(
      /[\u0000-\u001f]/.test(out),
      false,
      `[${label}] 输出不得含真实控制字符：${JSON.stringify(out)}`,
    );
  }

  // 转义为**可见**的 \r / \n / \t 序列（而非直接删除）。
  assert.equal(formatToolArgs({ a: `a${CR}${LF}b` }), 'a="a\\r\\nb"');
  assert.equal(formatToolArgs({ a: `a${CR}b` }), 'a="a\\rb"');
  assert.equal(formatToolArgs({ a: `a${LF}b` }), 'a="a\\nb"');
  assert.equal(formatToolArgs({ a: `a${TAB}b` }), 'a="a\\tb"');

  // 既有行为未回归：反斜杠先转义、双引号转义，顺序正确（不二次转义）。
  assert.equal(formatToolArgs({ a: "c:\\x" }), 'a="c:\\\\x"');
  assert.equal(formatToolArgs({ a: 'he said "hi"' }), 'a="he said \\"hi\\""');
  assert.equal(formatToolArgs({ a: `a${CR}` }), 'a="a\\r"');
  // 反斜杠 + 字母 r（两个普通字符，**非**控制字符）不得被误当作 CR：应输出 \\r。
  assert.equal(formatToolArgs({ a: "a\\rb" }), 'a="a\\\\rb"');
});

// ---------------------------------------------------------------------------
// 3 · 顶层非对象：按单值渲染（复用同一套值规则），绝不抛
// ---------------------------------------------------------------------------
test("顶层非对象：按单值渲染，不抛", () => {
  assert.equal(formatToolArgs(42), "42");
  assert.equal(formatToolArgs(true), "true");
  assert.equal(formatToolArgs(false), "false");
  assert.equal(formatToolArgs(10n), "10");
  // 顶层字符串按值规则 → 仍带双引号（单值渲染与 key=value 里的值同规则）。
  assert.equal(formatToolArgs("hi"), '"hi"');
  assert.equal(formatToolArgs([1, 2]), "[1,2]");
});

// ---------------------------------------------------------------------------
// 4 · 多键顺序与连接符
// ---------------------------------------------------------------------------
test("多键：按 Object.keys 自然顺序、以 ', ' 连接", () => {
  assert.equal(formatToolArgs({ b: 2, a: 1, m: 3 }), "b=2, a=1, m=3");
});

// ---------------------------------------------------------------------------
// 5 · 循环引用 / 嵌套 BigInt：JSON.stringify 抛错必须被兜住
// ---------------------------------------------------------------------------
test("循环引用：不抛，退化为 {…} / […]（绝不让 UI 因参数畸形白屏）", () => {
  const obj = {};
  obj.self = obj;
  assert.doesNotThrow(() => formatToolArgs(obj));
  assert.equal(formatToolArgs(obj), "self={…}");
  assert.equal(formatToolArgs({ a: obj }), "a={…}");

  const arr = [];
  arr.push(arr);
  assert.equal(formatToolArgs({ a: arr }), "a=[…]");
  assert.equal(formatToolArgs(arr), "[…]");
});

test("嵌套 BigInt：JSON.stringify 抛 TypeError → 被兜住为 {…}", () => {
  assert.doesNotThrow(() => formatToolArgs({ a: { b: 10n } }));
  assert.equal(formatToolArgs({ a: { b: 10n } }), "a={…}");
});

test("抛错的 ownKeys Proxy：Object.keys 抛错 → 不抛，退化为空串", () => {
  // Proxy 的 ownKeys trap 故意 throw：Object.keys(args) 会在模块的 try/catch 之外抛穿。
  // 模块承诺「绝不抛错」，此处必须兜住（退化为空串，与「空对象」同构）。
  const boom = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("ownKeys boom");
      },
    },
  );
  assert.doesNotThrow(() => formatToolArgs(boom));
  assert.equal(formatToolArgs(boom), "");
});

// ---------------------------------------------------------------------------
// 6 · 默认截断上限 120
// ---------------------------------------------------------------------------
test("默认 maxLength=120：短串不动；长串按码点截断为 120 码点 + 省略号", () => {
  assert.equal(formatToolArgs({ a: 1 }), "a=1");

  const long = formatToolArgs({ a: "x".repeat(200) });
  assert.ok(long.endsWith("…"), "超长应补省略号");
  // 截断体 120 个码点 + 1 个省略号 = 121。
  assert.equal(Array.from(long).length, 121);
  assert.ok(long.startsWith('a="'), "截断结果应是原串前缀");
});

// ---------------------------------------------------------------------------
// 7 · maxLength 边界
// ---------------------------------------------------------------------------
test("maxLength 边界：0 → 只留省略号；1 → 首码点 + 省略号；负数 / NaN → 视作 0", () => {
  assert.equal(formatToolArgs({ a: 1 }, { maxLength: 0 }), "…");
  assert.equal(formatToolArgs({ a: 1 }, { maxLength: 1 }), "a…");
  // 空串 + maxLength 0：无内容可截，保持空串（不加省略号）。
  assert.equal(formatToolArgs({}, { maxLength: 0 }), "");
  // 负数 / NaN / 非数字 → 按 0 处理。
  assert.equal(formatToolArgs({ a: 1 }, { maxLength: -5 }), "…");
  assert.equal(formatToolArgs({ a: 1 }, { maxLength: Number.NaN }), "…");
  // 恰好等于长度：不截断、不加省略号。
  assert.equal(formatToolArgs({ a: 1 }, { maxLength: 3 }), "a=1");
  assert.equal(formatToolArgs({ a: 1 }, { maxLength: 2 }), "a=…");
});

// ---------------------------------------------------------------------------
// 8 · ★ 截断码点安全：前缀长度 × 字符字节宽度 笛卡尔积（本步最重要的一条）
// ---------------------------------------------------------------------------
test("★ 截断按 Unicode 码点：前缀长度 × 字符字节宽度 笛卡尔积，扫描全部边界无孤立代理且为合法前缀", () => {
  const WIDE = [
    { name: "é(2B)", ch: "é" }, // U+00E9：1 个 UTF-16 code unit，2 字节
    { name: "中(3B)", ch: "中" }, // U+4E2D：1 个 code unit，3 字节
    { name: "🀄(4B)", ch: "🀄" }, // U+1F004：2 个 code unit（代理对），4 字节
  ];

  let cases = 0;
  for (let prefixLen = 0; prefixLen <= 4; prefixLen += 1) {
    for (const { name, ch } of WIDE) {
      const content = "a".repeat(prefixLen) + ch; // 顶层字符串 → 渲染后形如 "…"
      const original = `"${content}"`;
      const cpTotal = Array.from(original).length;

      // 扫描全部截断边界（含切在代理对正中间的 maxLength）。
      for (let maxLength = 0; maxLength <= original.length + 2; maxLength += 1) {
        const out = formatToolArgs(content, { maxLength });
        cases += 1;
        const label = `[${name} · prefix=${prefixLen} · max=${maxLength}]`;

        // (1) 绝不出现孤立代理。
        assert.ok(!LONE_SURROGATE.test(out), `${label} 输出含孤立代理：${JSON.stringify(out)}`);

        const cpMax = Math.max(0, Math.floor(maxLength));
        if (cpTotal <= cpMax) {
          // (2a) 未达上限 → 原样返回。
          assert.equal(out, original, `${label} 未达上限时应原样返回`);
        } else {
          // (2b) 达上限 → 截断体是原串的合法前缀，且长度恰为 maxLength 个码点。
          assert.ok(out.endsWith("…"), `${label} 达上限时应补省略号`);
          const body = out.slice(0, -1);
          assert.ok(original.startsWith(body), `${label} 截断结果不是原串前缀：${JSON.stringify(body)}`);
          assert.equal(Array.from(body).length, cpMax, `${label} 截断体码点数应恰为 ${cpMax}`);
        }
      }
    }
  }

  assert.ok(cases > 100, `应覆盖足量用例（实际 ${cases}）`);
});

test("判别力对照：若按 UTF-16 code unit 截断（错误实现），在这些输入上必然产出孤立代理", () => {
  // 错误实现：直接按 code unit slice 后补省略号（与 formatToolArgs 的差异就在这一步）。
  const buggyTruncate = (text, maxLength) => {
    const m = !Number.isFinite(maxLength) || maxLength < 0 ? 0 : Math.floor(maxLength);
    return text.length <= m ? text : text.slice(0, m) + "…";
  };

  let caught = 0;
  for (let prefixLen = 0; prefixLen <= 4; prefixLen += 1) {
    const content = "a".repeat(prefixLen) + "🀄";
    const original = `"${content}"`;
    for (let maxLength = 0; maxLength <= original.length + 2; maxLength += 1) {
      const out = buggyTruncate(original, maxLength);
      if (out.endsWith("…") && LONE_SURROGATE.test(out)) caught += 1;
    }
  }

  // 证明夹具具备判别力：错误实现确实会在某些边界上产出孤立代理 —— 本测试能抓住它。
  assert.ok(caught > 0, "UTF-16 截断的错误实现应当在代理对边界上产出孤立代理（否则夹具无判别力）");
});

// ---------------------------------------------------------------------------
// 8b · 奇异 getter：读取属性时抛错也必须被兜住（兑现模块头「绝不抛错」的承诺）
// ---------------------------------------------------------------------------
test("奇异 getter：读取时抛错 → 不抛、退化为 …；同批正常键不受影响", () => {
  const obj = {};
  Object.defineProperty(obj, "x", {
    enumerable: true,
    get() {
      throw new Error("boom");
    },
  });

  let out;
  assert.doesNotThrow(() => {
    out = formatToolArgs(obj);
  }, "读取会抛错的 getter 不得让 formatToolArgs 抛出");
  assert.equal(out, "x=…");

  // 同批里正常键照常渲染，只有坏键退化（顺序按 Object.keys 自然顺序）。
  const mixed = { ok: 1 };
  Object.defineProperty(mixed, "bad", {
    enumerable: true,
    get() {
      throw new Error("boom");
    },
  });
  assert.equal(formatToolArgs(mixed), "ok=1, bad=…");
});

// ---------------------------------------------------------------------------
// 9 · 异构 / 奇异输入：一律不抛、一律返回字符串
// ---------------------------------------------------------------------------
test("异构输入一律不抛，且返回 string", () => {
  const weird = [0, -1, Number.POSITIVE_INFINITY, Number.NaN, true, false, "", "x", 1n, Symbol("s"), () => {}, [], {}, null, undefined];
  for (const v of weird) {
    assert.doesNotThrow(() => formatToolArgs(v), `输入 ${String(v)} 不应抛`);
    assert.equal(typeof formatToolArgs(v), "string");
  }
});
