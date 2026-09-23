/**
 * tools —— ReinAgent 的工具注册表与硬闸（S7-3）。
 * =====================================================================
 * 本模块提供 A1 决策定的 **两个零副作用工具**（`get_current_time` / `calculate`），
 * 以及「工具结果 8KB 限长」这一安全边界（规格 §6）与 `DEFAULT_MAX_STEPS` 步数上限。
 *
 * 与库的分工（务必遵守，别重复实现）：
 *   工具名白名单判断、参数 schema 校验、把错误塞进 content 的兜底、abort 处理
 *   —— **全部由 pi-agent-core 完成**（`agent-loop.js:444-501/522-528`）。
 *   库原话（`types.d.ts:366`）：execute 失败请 `Throw on failure instead of encoding
 *   errors in content`。⇒ 本模块的 `execute` **直接抛错就是正确做法**：
 *     - 未注册工具名 → 库 `createErrorToolResult("Tool X not found")`（isError:true）；
 *     - 参数不合 schema → 库 `validateToolArguments` 抛 → isError toolResult；
 *     - execute 抛异常 → 库 catch → isError toolResult，**循环继续**；
 *     - 执行中被打断 → 库产出 isError toolResult("Operation aborted")。
 *   ⇒ 因此本文件**不写**名字白名单、schema 校验、错误兜底。**绝不** `eval`/`new Function`。
 *
 * 运行时导入纪律（本项目硬性 #2）：
 *   `Type` **只从顶层包 `"typebox"` 导入**（显式依赖，精确锁 1.3.27）。
 *   绝不从 `@earendil-works/pi-ai` 桶文件做**运行时**导入 —— 那会拖入
 *   `node:fs/promises`，Vite 打包失败且报错指向 aws-sdk，极难定位。
 *   `typebox` 本身零依赖、ESM、可安全进浏览器 bundle。
 *
 * 性能纪律：`calculate` 的求值器是**手写递归下降**（单趟线性、无回溯正则），
 *   并用「长度上限 256 + 括号深度上限 32」双重硬闸保证绝不栈溢出、耗时毫秒级。
 *
 * 类型声明见同目录 `tools.d.ts`；编译期形状证明见 `tools.types.ts`；
 * 自动化验证见 `tools.test.mjs`。
 */

import { Type } from "typebox";
import { resolveWorkspacePath, resolveWorkspaceRoot } from "./workspace";

/**
 * 工具硬闸上限（导出供测试与上层消费）。
 * - `maxResultBytes`：工具**返回给模型的文本内容**的 UTF-8 字节上限（安全边界 §6）。
 * - `maxExpressionLength`：`calculate` 表达式字符数上限（超长直接抛错，**不进求值器**）。
 * - `maxParenDepth`：`calculate` 括号嵌套深度上限（超深直接抛错）。
 */
export const TOOL_LIMITS = Object.freeze({
  maxResultBytes: 8192,
  maxExpressionLength: 256,
  maxParenDepth: 32,
});

/**
 * 单次运行的默认步数上限（决策 D）。S7-5 会把它作为 `runTurn` 的 `maxSteps` 传入。
 */
export const DEFAULT_MAX_STEPS = 8;

// ---------------------------------------------------------------------------
// 结果限长（安全边界 §6）：UTF-8 字节级截断，绝不切断多字节字符
// ---------------------------------------------------------------------------

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

/**
 * 计算字符串的 UTF-8 字节长度。
 * @param {string} text 待测文本。
 * @returns {number} UTF-8 字节数。
 */
function utf8ByteLength(text) {
  return utf8Encoder.encode(text).length;
}

/**
 * 取 UTF-8 字节序列的前 `maxBytes` 字节，并**保证不切断多字节字符**。
 *
 * 做法：先取到 `maxBytes`，若切点落在某个多字节字符中间（即第 `maxBytes` 个字节
 * 是 UTF-8 续字节 `0b10xxxxxx`），则向左回退到该字符的起始字节，从而整段是合法
 * UTF-8，`decode` 不会产生替换字符 U+FFFD。
 *
 * @param {Uint8Array} bytes 原始 UTF-8 字节序列。
 * @param {number} maxBytes 允许的最大字节数。
 * @returns {string} 解码后的安全前缀（字节长度 ≤ maxBytes）。
 */
function utf8SafeSlice(bytes, maxBytes) {
  let end = Math.min(maxBytes, bytes.length);
  if (end < bytes.length) {
    // 回退跨越续字节，直到落在某个字符的首字节之前。
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
      end -= 1;
    }
  }
  return utf8Decoder.decode(bytes.subarray(0, end));
}

/**
 * 构造一个「文本类」工具结果，并在**出口**按 `maxResultBytes` 做 UTF-8 字节截断。
 *
 * 返回的 `content[0].text` **一定 ≤ maxResultBytes 字节**（截断标记也计入预算），
 * 且 `details` 里带上 `{ length, originalLength, truncated }` 真值供 UI / 日志消费。
 *
 * ⚠️ 边界说明：截断只保护「工具返回给模型的内容」。工具**入参不做截断** ——
 *    改动入参会破坏 toolCall 与 toolResult 的配对语义；入参保护由各工具自己的
 *    限额承担（如 `calculate` 的 `maxExpressionLength`）。
 *
 * @param {string} text 原始结果文本。
 * @param {Record<string, unknown>} [details] 追加到 `details` 的业务字段。
 * @returns {import("./tools.js").TextToolResult} 工具结果（content + details）。
 */
export function buildTextToolResult(text, details = {}) {
  const originalLength = utf8ByteLength(text);

  if (originalLength <= TOOL_LIMITS.maxResultBytes) {
    return {
      content: [{ type: "text", text }],
      details: { ...details, length: originalLength, originalLength, truncated: false },
    };
  }

  const marker = `\n…[truncated: 原 ${originalLength} 字节，已截断至 ${TOOL_LIMITS.maxResultBytes}]`;
  const markerBytes = utf8ByteLength(marker);
  // 预留标记的字节预算，保证「前缀 + 标记」整体不超上限。
  const budget = Math.max(0, TOOL_LIMITS.maxResultBytes - markerBytes);
  const head = utf8SafeSlice(utf8Encoder.encode(text), budget);
  const finalText = head + marker;

  return {
    content: [{ type: "text", text: finalText }],
    details: {
      ...details,
      length: utf8ByteLength(finalText),
      originalLength,
      truncated: true,
    },
  };
}

// ---------------------------------------------------------------------------
// 表达式求值器（手写递归下降，线性、无 eval）
// ---------------------------------------------------------------------------

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

/**
 * 对一个受限算术表达式求值（手写递归下降，**禁止** `eval` / `new Function`）。
 *
 * 文法（只允许这些，其它任何字符一律抛错）：
 *   expr    := term (('+' | '-') term)*
 *   term    := factor (('*' | '/') factor)*
 *   factor  := '-' factor | primary
 *   primary := number | '(' expr ')'
 *   number  := digit+ ('.' digit+)?
 *
 * 特性：单趟线性扫描（无回溯正则），`(maxExpressionLength, maxParenDepth)` 双重硬闸
 * 保证不会栈溢出；除零或非有限结果均抛错（绝不返回 `Infinity` / `NaN`）。
 *
 * @param {unknown} expression 待求值表达式（应为字符串）。
 * @returns {number} 求值结果（有限数）。
 * @throws {TypeError} `expression` 非字符串时。
 * @throws {Error} 超长 / 超深 / 非法字符 / 括号不配对 / 除零 / 非有限结果时。
 */
function evaluateExpression(expression) {
  if (typeof expression !== "string") {
    throw new TypeError("calculate: expression 必须是字符串。");
  }
  if (expression.length > TOOL_LIMITS.maxExpressionLength) {
    throw new Error(
      `calculate: 表达式过长（${expression.length} 字符，上限 ${TOOL_LIMITS.maxExpressionLength}）。`,
    );
  }

  const src = expression;
  let pos = 0;
  let parenDepth = 0;

  /** 跳过空白字符（不改动非空白字符的语义）。 */
  function skipWhitespace() {
    while (pos < src.length && WHITESPACE.has(src[pos])) {
      pos += 1;
    }
  }

  /** 解析数值字面量 `digit+ ('.' digit+)?`。 */
  function parseNumber() {
    const start = pos;
    let sawDigit = false;
    let sawDot = false;
    while (pos < src.length) {
      const ch = src[pos];
      if (ch >= "0" && ch <= "9") {
        sawDigit = true;
        pos += 1;
        continue;
      }
      if (ch === ".") {
        if (sawDot) {
          break; // 第二个小数点 → 结束本字面量，交由上层报「意外字符」。
        }
        const next = src[pos + 1];
        if (!(next >= "0" && next <= "9")) {
          break; // 孤立的小数点不构成字面量。
        }
        sawDot = true;
        pos += 1;
        continue;
      }
      break;
    }
    if (!sawDigit) {
      const bad = pos < src.length ? JSON.stringify(src[pos]) : "<表达式末尾>";
      throw new Error(`calculate: 位置 ${start} 处期望数字字面量，实际 ${bad}。`);
    }
    const token = src.slice(start, pos);
    const value = Number(token);
    if (!Number.isFinite(value)) {
      throw new Error(`calculate: 数值字面量 "${token}" 不是有限数。`);
    }
    return value;
  }

  /** primary := number | '(' expr ')' */
  function parsePrimary() {
    skipWhitespace();
    if (pos >= src.length) {
      throw new Error("calculate: 表达式意外结束。");
    }
    const ch = src[pos];
    if (ch === "(") {
      parenDepth += 1;
      if (parenDepth > TOOL_LIMITS.maxParenDepth) {
        throw new Error(`calculate: 括号嵌套过深（超过 ${TOOL_LIMITS.maxParenDepth} 层）。`);
      }
      pos += 1;
      const value = parseExpr();
      skipWhitespace();
      if (src[pos] !== ")") {
        throw new Error(`calculate: 位置 ${pos} 处缺少右括号 ")"。`);
      }
      pos += 1;
      parenDepth -= 1;
      return value;
    }
    if (ch >= "0" && ch <= "9") {
      return parseNumber();
    }
    throw new Error(`calculate: 位置 ${pos} 处出现非法字符 ${JSON.stringify(ch)}。`);
  }

  /** factor := '-' factor | primary （仅一元负号，不含一元正号）。 */
  function parseFactor() {
    skipWhitespace();
    if (src[pos] === "-") {
      pos += 1;
      return -parseFactor();
    }
    return parsePrimary();
  }

  /** term := factor (('*' | '/') factor)* */
  function parseTerm() {
    let value = parseFactor();
    for (; ;) {
      skipWhitespace();
      const ch = src[pos];
      if (ch === "*") {
        pos += 1;
        value *= parseFactor();
      } else if (ch === "/") {
        pos += 1;
        const divisor = parseFactor();
        if (divisor === 0) {
          throw new Error("calculate: 除以零。");
        }
        value /= divisor;
      } else {
        break;
      }
    }
    return value;
  }

  /** expr := term (('+' | '-') term)* */
  function parseExpr() {
    let value = parseTerm();
    for (; ;) {
      skipWhitespace();
      const ch = src[pos];
      if (ch === "+") {
        pos += 1;
        value += parseTerm();
      } else if (ch === "-") {
        pos += 1;
        value -= parseTerm();
      } else {
        break;
      }
    }
    return value;
  }

  skipWhitespace();
  if (pos >= src.length) {
    throw new Error("calculate: 表达式为空。");
  }
  const value = parseExpr();
  skipWhitespace();
  if (pos < src.length) {
    throw new Error(`calculate: 位置 ${pos} 处出现意外字符 ${JSON.stringify(src[pos])}。`);
  }
  if (!Number.isFinite(value)) {
    throw new Error("calculate: 结果不是有限数（溢出或未定义）。");
  }
  return value;
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

/**
 * 创建工具集。时钟可注入，保证测试**绝不依赖真实当前时间**。
 *
 * @param {{ now?: () => Date }} [options] 工厂入参。
 * @param {() => Date} [options.now] 时钟函数，默认 `() => new Date()`（每轮取一次）。
 * @returns {import("./tools.js").ToolList} 工具数组（每次调用返回**新**数组与新对象）。
 */
export function createTools(options) {
  // 单一兜底：`?? {}` 同时兼顾 undefined 与显式 null（参数默认值只挡 undefined）。
  const opts = options ?? {};
  const now = typeof opts.now === "function" ? opts.now : () => new Date();
  const getWorkspace = typeof opts.getWorkspaceRoot === "function"
    ? opts.getWorkspaceRoot
    : () => resolveWorkspaceRoot(opts.workspaceRoot);

  const getCurrentTime = {
    name: "get_current_time",
    label: "获取当前时间",
    description:
      "获取当前的本地日期与时间。无参数。返回人类可读的本地时间、ISO 8601 时间以及时区偏移。",
    parameters: Type.Object({}),
    /**
     * @param {string} _toolCallId 调用 id（本例不使用）。
     * @returns {Promise<import("./tools.js").TextToolResult>}
     */
    execute: async (_toolCallId) => {
      const date = now();
      const iso = date.toISOString();
      const pad2 = (n) => String(n).padStart(2, "0");
      const local =
        `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
        `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
      // getTimezoneOffset() 返回「UTC - 本地」的分钟数（西为负），取反得到「本地位于 UTC 东侧」的分钟数。
      const timeZoneOffsetMinutes = -date.getTimezoneOffset();
      const sign = timeZoneOffsetMinutes >= 0 ? "+" : "-";
      const absOffset = Math.abs(timeZoneOffsetMinutes);
      const offsetText = `${sign}${pad2(Math.floor(absOffset / 60))}:${pad2(absOffset % 60)}`;
      const text = `当前本地时间：${local}（UTC${offsetText}）\nISO 时间：${iso}`;

      return buildTextToolResult(text, {
        iso,
        local,
        timeZoneOffsetMinutes,
      });
    },
  };

  const calculate = {
    name: "calculate",
    label: "计算表达式",
    description:
      "对一个算术表达式精确求值。只支持十进制数值、四则运算 + - * /、圆括号与一元负号；" +
      "不支持变量、函数或其它字符。除以零会报错。",
    parameters: Type.Object(
      {
        expression: Type.String({
          description: '要计算的算术表达式，例如 "(3+4)*5" 或 "1234 * 5678"。',
        }),
      },
      { required: ["expression"] },
    ),
    /**
     * @param {string} _toolCallId 调用 id（本例不使用）。
     * @param {{ expression: string }} params 参数对象（已通过 TypeBox 校验）。
     * @returns {Promise<import("./tools.js").TextToolResult>}
     */
    execute: async (_toolCallId, params) => {
      // 库会把 params 按 schema 塞进来，这里做防御性取值。
      const expr = String(params?.expression ?? "");
      const value = evaluateExpression(expr);
      const resultText = String(value);
      return buildTextToolResult(resultText, {
        expression: expr,
        result: value,
      });
    },
  };

  const readFile = {
    name: "read_file",
    label: "读取文件",
    description: "读取指定路径的文件内容（支持绝对路径或相对于项目工作区的相对路径）。",
    parameters: Type.Object(
      {
        path: Type.String({ description: "文件的路径（相对路径将自动相对于当前工作区根目录解析）" }),
      },
      { required: ["path"] },
    ),
    execute: async (_toolCallId, params) => {
      const { invoke } = await import("@tauri-apps/api/core");
      const targetPath = resolveWorkspacePath(params.path, getWorkspace());
      const content = await invoke("fs_read_file", { path: targetPath });
      return buildTextToolResult(content, { path: targetPath, requestedPath: params.path });
    },
  };

  const writeFile = {
    name: "write_file",
    label: "写入文件",
    description: "将内容写入指定文件（全量覆盖，父目录若不存在会自动创建。支持绝对路径或相对于项目工作区的相对路径）。",
    parameters: Type.Object(
      {
        path: Type.String({ description: "文件的路径（相对路径将自动相对于当前工作区根目录解析）" }),
        content: Type.String({ description: "要写入的文件完整文本内容" }),
      },
      { required: ["path", "content"] },
    ),
    execute: async (_toolCallId, params) => {
      const { invoke } = await import("@tauri-apps/api/core");
      const targetPath = resolveWorkspacePath(params.path, getWorkspace());
      await invoke("fs_write_file", { path: targetPath, content: params.content });
      return buildTextToolResult(`Successfully written to ${targetPath}`, { path: targetPath, requestedPath: params.path });
    },
  };

  const editFile = {
    name: "edit_file",
    label: "编辑文件块",
    description: "精准替换文件中的特定代码或文本块（target 必须精确匹配文件中的现有片段。支持绝对路径或相对于工作区的相对路径）。",
    parameters: Type.Object(
      {
        path: Type.String({ description: "文件路径（相对路径将自动相对于当前工作区根目录解析）" }),
        target: Type.String({ description: "待替换的原目标文本块（必须在文件中精确唯一出现）" }),
        replacement: Type.String({ description: "替换后的新文本内容" }),
      },
      { required: ["path", "target", "replacement"] },
    ),
    execute: async (_toolCallId, params) => {
      const { invoke } = await import("@tauri-apps/api/core");
      const targetPath = resolveWorkspacePath(params.path, getWorkspace());
      const oldContent = await invoke("fs_read_file", { path: targetPath });
      const occurrences = oldContent.split(params.target).length - 1;
      if (occurrences === 0) {
        throw new Error(`edit_file: target text not found in ${targetPath}`);
      }
      if (occurrences > 1) {
        throw new Error(`edit_file: target text appears ${occurrences} times in ${targetPath}, must be unique`);
      }
      const newContent = oldContent.replace(params.target, params.replacement);
      await invoke("fs_write_file", { path: targetPath, content: newContent });
      return buildTextToolResult(`Successfully modified ${targetPath}`, { path: targetPath, requestedPath: params.path });
    },
  };

  const listDir = {
    name: "list_dir",
    label: "列出目录",
    description: "列出指定目录下的文件和子目录列表（支持绝对路径或相对于工作区的相对路径，默认当前工作区）。",
    parameters: Type.Object(
      {
        path: Type.String({ description: "目录路径，默认为当前工作区目录 ." }),
      },
      { required: ["path"] },
    ),
    execute: async (_toolCallId, params) => {
      const { invoke } = await import("@tauri-apps/api/core");
      const targetPath = resolveWorkspacePath(params.path || ".", getWorkspace());
      const entries = await invoke("fs_list_dir", { path: targetPath });
      return buildTextToolResult(JSON.stringify(entries, null, 2), { path: targetPath, entries, requestedPath: params.path });
    },
  };

  const execCommand = {
    name: "exec_command",
    label: "执行终端命令",
    description: "在系统终端中执行 shell 命令行（支持 bash / sh 语法，例如 git status, ls 等）。默认在当前项目工作区根目录下执行。",
    parameters: Type.Object(
      {
        command: Type.String({ description: "要执行的命令行内容" }),
        cwd: Type.Optional(Type.String({ description: "执行命令的工作目录（未指定时默认使用当前项目工作区根目录）" })),
      },
      { required: ["command"] },
    ),
    execute: async (_toolCallId, params) => {
      const { invoke } = await import("@tauri-apps/api/core");
      const targetCwd = params.cwd ? resolveWorkspacePath(params.cwd, getWorkspace()) : getWorkspace();
      const output = await invoke("fs_execute", { command: params.command, cwd: targetCwd });
      return buildTextToolResult(output, { command: params.command, cwd: targetCwd });
    },
  };

  return [getCurrentTime, calculate, readFile, writeFile, editFile, listDir, execCommand];
}

/**
 * 默认工具实例（模块加载时创建一次；时钟为真实系统时钟）。
 */
export const TOOLS = createTools();

/**
 * 返回工具集的**浅拷贝**（防止外部改动内部注册表数组）。
 * 若传入 options（如绑定了特定 workspaceRoot），则通过 createTools(options) 创建专属工具集。
 * @param {import("./tools.d.ts").CreateToolsOptions} [options] 工具集配置
 * @returns {import("./tools.js").ToolList} 新数组，元素为工具对象引用。
 */
export function getTools(options) {
  if (options && (options.now || options.workspaceRoot || options.getWorkspaceRoot)) {
    return createTools(options);
  }
  return TOOLS.slice();
}
