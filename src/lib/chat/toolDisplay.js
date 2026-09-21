/**
 * toolDisplay —— 工具调用参数的显示格式化（纯函数，无 React / 无 DOM）。
 *
 * 为什么把这段逻辑单独抽出来：
 *   本项目的教训是「用复刻语义的探针去测 React hook，测到的其实是探针自己的模型」。
 *   因此凡是能从不纯的组件里剥出来的判断，一律剥成纯 `.js`（package.json 是
 *   `type: "module"`，Node 可直接 `node --test`），让「参数怎么显示」这件事可自动化断言。
 *   UI 里唯一真正有分支的逻辑就是它 —— 其余都是直白的 JSX 与 CSS。
 *
 * 设计约束：
 *   - **绝不抛错**：参数来自模型，形态完全不可控（循环引用、BigInt、奇异 getter…）。
 *     这里任何一条异常路径都必须退化成可读文本，而不能把界面打崩。
 *   - **截断按 Unicode 码点**：`String.prototype.slice` 按 UTF-16 code unit 切，
 *     切到代理对中间会产出**孤立代理**（如把 `🀄` 劈成半个）。必须 `Array.from` 后切码点。
 *
 * 类型声明见同目录 `toolDisplay.d.ts`。
 */

/** 默认截断上限（Unicode 码点数量；省略号不计入额度）。 */
const DEFAULT_MAX_LENGTH = 120;

/**
 * 把「库解析好的参数对象」格式化成一行可读文本。
 *
 * 语义：
 *   - `undefined` / `null` → `""`（时间类工具没有参数，标题行不该拖一个空括号）；
 *   - 空对象 `{}` → `""`（同上）；
 *   - 其它对象 → `key=value`，以 `, ` 连接，顺序取 `Object.keys` 的自然顺序；
 *   - 非对象（数组 / 标量 / 函数 / symbol）→ 按**单值**渲染（复用同一套值渲染规则），不抛。
 *
 * @param {unknown} args 库解析好的参数（可能是任意值）
 * @param {{ maxLength?: number }=} options 选项；`maxLength` 默认 120
 * @returns {string}
 */
export function formatToolArgs(args, options) {
  // 空参数：直接返回空串，交由 UI 决定「不渲染参数行」。
  if (args === undefined || args === null) return "";

  const isPlainObject = typeof args === "object" && !Array.isArray(args);
  if (isPlainObject) {
    // ★ `Object.keys` 本身也可能抛（例如 Proxy 的 `ownKeys` trap 故意 throw）。
    //   模块承诺「绝不抛错」，这里单独兜住：拿不到键就退化为空串（与「空对象」同构）。
    let keys;
    try {
      keys = Object.keys(args);
    } catch {
      return "";
    }
    if (keys.length === 0) return "";
    const parts = [];
    for (const key of keys) {
      parts.push(`${key}=${readValueSafely(args, key)}`);
    }
    return truncateByCodePoint(parts.join(", "), options);
  }

  // 非对象（数组 / 标量…）：按单值渲染，且绝不抛。
  return truncateByCodePoint(renderValue(args), options);
}

/**
 * 安全读取一个属性并渲染：某些「奇异 getter」会在**读取时**抛错，
 * 若不兜住就会穿透整个 `formatToolArgs`。
 *
 * ⚠ 这是**纵深防御**，不是日常路径：工具参数来自模型的 JSON，
 *   JSON 反序列化**不可能**产生 getter（只有 `Object.defineProperty` 之类才会）。
 *   但本模块存在的唯一目的就是「参数形态不可控也不能把界面打崩」，
 *   所以即便这条路径几乎走不到，也照样兜住 —— 读取失败退化为 `…`，绝不让异常穿透。
 *
 * @param {object} holder
 * @param {string} key
 * @returns {string}
 */
function readValueSafely(holder, key) {
  try {
    return renderValue(holder[key]);
  } catch {
    return "…";
  }
}

/**
 * 渲染单个值。
 * 规则：string 双引号包裹并转义；number/boolean/bigint 用 `String`；
 * null → "null"；undefined → "undefined"；数组 / 嵌套对象 → JSON（失败则退化）。
 * @param {unknown} value
 * @returns {string}
 */
function renderValue(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return `"${escapeString(value)}"`;
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    case "undefined":
      return "undefined";
    default:
      // 数组 / 普通对象 / 函数 / symbol 等：交给安全 JSON。
      return safeJson(value);
  }
}

/**
 * 转义字符串字面量里的反斜杠、控制字符与双引号。
 *
 * 顺序**敏感**：
 *   1. 先转义反斜杠（否则后面插入的 `\` 会被二次转义）；
 *   2. 再把真实控制字符转成**可见**的 `\r` / `\n` / `\t` 序列 —— 否则值里的换行/回车/制表
 *      会把 `ToolCallCard` 的单行参数行（以及其 `title`）撑坏；
 *   3. 最后转义双引号。
 * @param {string} s
 * @returns {string}
 */
function escapeString(s) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/"/g, '\\"');
}

/**
 * 安全 `JSON.stringify`：捕获循环引用 / BigInt 等抛错，退化为占位符。
 * 绝不抛错 —— 畸形参数不能让 UI 白屏。
 * @param {unknown} value
 * @returns {string}
 */
function safeJson(value) {
  try {
    const s = JSON.stringify(value);
    // JSON.stringify 对函数 / symbol 返回 undefined（不是抛错）。
    return s === undefined ? "undefined" : s;
  } catch {
    return Array.isArray(value) ? "[…]" : "{…}";
  }
}

/**
 * 按 **Unicode 码点** 截断：超过上限时截前 `maxLength` 个码点并补 `…`。
 * 省略号不计入额度；`maxLength` 为负数 / NaN / 非数字时按 0 处理。
 * @param {string} text
 * @param {{ maxLength?: number }=} options
 * @returns {string}
 */
function truncateByCodePoint(text, options) {
  let maxLength =
    options && typeof options.maxLength === "number" ? options.maxLength : DEFAULT_MAX_LENGTH;
  if (!Number.isFinite(maxLength) || maxLength < 0) maxLength = 0;
  maxLength = Math.floor(maxLength);

  // ★ 关键：先 Array.from 拆成码点数组，再切 —— 直接 slice 会劈开代理对。
  const chars = Array.from(text);
  if (chars.length <= maxLength) return text;
  return chars.slice(0, maxLength).join("") + "…";
}
