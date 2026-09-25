/**
 * tools —— ReinAgent 的工具注册表与硬闸（S7-3）。
 * =====================================================================
 * 本模块提供文件与命令类工具（`read_file` / `write_file` / `edit_file` / `list_dir` / `exec_command`）。
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
 *   并用「长度上限 256 + 括号深度上限 32」双重硬闸保证绝不栈溢出、耗时毫秒级。
 *
 * 类型声明见同目录 `tools.d.ts`；编译期形状证明见 `tools.types.ts`；
 * 自动化验证见 `tools.test.mjs`。
 */

import { Type } from "typebox";
import { resolveWorkspacePath, resolveWorkspaceRoot } from "./workspace.ts";

/**
 * 工具硬闸上限（导出供测试与上层消费）。
 * - `maxResultBytes`：工具**返回给模型的文本内容**的 UTF-8 字节上限（安全边界 §6）。
 */
export const TOOL_LIMITS = Object.freeze({
  maxResultBytes: 8192,
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
 *    校验逻辑承担（如 edit_file 的 target 唯一性检查）。
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

  return [readFile, writeFile, editFile, listDir, execCommand];
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

/**
 * 工具权限分级（审批模式的裁决依据，对齐 ZCode 的 permission kind）：
 * - "read"：只读（read_file / list_dir）—— 任何模式都直接放行；
 * - "write"：写入/修改文件（write_file / edit_file）—— ask 模式需批准，plan 模式拦截；
 * - "exec"：命令执行（exec_command）—— ask / edit 模式需批准，plan 模式拦截。
 *
 * 未知工具名一律视为 "write"（保守默认：审批从紧，绝不静默放权）。
 * @param {string} name 工具名
 * @returns {"read" | "write" | "exec"} 权限分级
 */
export function resolveToolPermissionKind(name) {
  switch (name) {
    case "read_file":
    case "list_dir":
      return "read";
    case "exec_command":
      return "exec";
    default:
      return "write";
  }
}
