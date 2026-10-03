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
 * 工具硬闸上限（导出供测试与上层消费）——**按工具分设**（对齐 ZCode
 * `contracts/tools/read.ts` 与 `handlers/bash.ts` 的口径，修复"85KB 文件读不全"
 * 的分段磨步问题）：
 * - `readFileBytes`：read_file 单次返回给模型的 UTF-8 字节上限（ZCode `READ_MAX_FILE_SIZE_BYTES` = 256KB）；
 * - `readMaxLines`：read_file 默认行数闸（ZCode `READ_DEFAULT_MAX_LINES` = 2000）；
 * - `execBytes`：exec_command 内联输出上限（ZCode `MAX_INLINE_OUTPUT_BYTES` = 30KB）；
 * - `listDirBytes`：list_dir JSON 列表上限（沿用既有 8KB）。
 */
export const TOOL_LIMITS = Object.freeze({
  readFileBytes: 256 * 1024,
  readMaxLines: 2000,
  execBytes: 30_000,
  listDirBytes: 8192,
  webFetchBytes: 30_000,
  webSearchBytes: 16_000,
});

// ---- WebFetch 抓取缓存（模块级：跨工具集实例共享，对齐 ZCode 进程级缓存）----
const WEBFETCH_CACHE_TTL_MS = 15 * 60 * 1000;
const WEBFETCH_CACHE_MAX = 50;
const webFetchCache = new Map();

/** 命中且未过期返回缓存结果（LRU touch）；过期/不存在返回 null。 */
function webCacheGet(url) {
  const hit = webFetchCache.get(url);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    webFetchCache.delete(url);
    return null;
  }
  webFetchCache.delete(url);
  webFetchCache.set(url, hit);
  return hit.result;
}

/** 写入缓存并按 FIFO 上限修剪（LRU touch 已在 get 中把热点挪到队尾）。 */
function webCacheSet(url, result) {
  webFetchCache.set(url, { expiresAt: Date.now() + WEBFETCH_CACHE_TTL_MS, result });
  while (webFetchCache.size > WEBFETCH_CACHE_MAX) {
    webFetchCache.delete(webFetchCache.keys().next().value);
  }
}

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
 * 构造一个「文本类」工具结果，并在**出口**按 `maxBytes` 做 UTF-8 字节截断。
 *
 * 返回的 `content[0].text` **一定 ≤ maxBytes 字节**（截断标记也计入预算），
 * 且 `details` 里带上 `{ length, originalLength, truncated }` 真值供 UI / 日志消费。
 * `maxBytes` 按工具传入（`TOOL_LIMITS` 的对应字段；缺省 `listDirBytes`）。
 *
 * ⚠️ 边界说明：截断只保护「工具返回给模型的内容」。工具**入参不做截断** ——
 *    改动入参会破坏 toolCall 与 toolResult 的配对语义；入参保护由各工具自己的
 *    校验逻辑承担（如 edit_file 的 target 唯一性检查）。
 *
 * @param {string} text 原始结果文本。
 * @param {Record<string, unknown>} [details] 追加到 `details` 的业务字段。
 * @param {number} [maxBytes] 本工具的返回字节上限（缺省 listDirBytes）。
 * @returns {import("./tools.js").TextToolResult} 工具结果（content + details）。
 */
export function buildTextToolResult(text, details = {}, maxBytes = TOOL_LIMITS.listDirBytes) {
  const originalLength = utf8ByteLength(text);

  if (originalLength <= maxBytes) {
    return {
      content: [{ type: "text", text }],
      details: { ...details, length: originalLength, originalLength, truncated: false },
    };
  }

  const marker = `\n…[truncated: 原 ${originalLength} 字节，已截断至 ${maxBytes}]`;
  const markerBytes = utf8ByteLength(marker);
  // 预留标记的字节预算，保证「前缀 + 标记」整体不超上限。
  const budget = Math.max(0, maxBytes - markerBytes);
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

/**
 * read_file 行数闸（对齐 ZCode `READ_DEFAULT_MAX_LINES` = 2000）：超限文件只保留
 * 前 `maxLines` 行并附截断标记注明总行数；字节级截断仍由 `buildTextToolResult`
 * 按 `readFileBytes` 二次兜底（两个闸独立生效，哪个先到算哪个）。
 * 纯函数（导出供单测）。
 * @param {string} text 文件全文。
 * @param {number} [maxLines] 行数上限（缺省 TOOL_LIMITS.readMaxLines）。
 * @returns {{ text: string, totalLines: number, truncated: boolean }}
 */
export function applyReadLineCap(text, maxLines = TOOL_LIMITS.readMaxLines) {
  if (!text.includes("\n")) {
    return { text, totalLines: text.length === 0 ? 0 : 1, truncated: false };
  }
  const lines = text.split("\n");
  // 结尾换行产生的尾部空串是噪声：真实行数不计它（与 turnActivity.splitDiffLines 同口径）。
  const totalLines =
    lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  if (totalLines <= maxLines) {
    return { text, totalLines, truncated: false };
  }
  const marker = `\n…[truncated: 显示前 ${maxLines} 行，文件共 ${totalLines} 行]`;
  return { text: lines.slice(0, maxLines).join("\n") + marker, totalLines, truncated: true };
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
  // 检查点上下文（对齐 LiveAgent）：提供时 write_file 落盘前捕获被改文件的前像，
  // 供「回退本轮代码改动」把工作区恢复到本轮开始前的状态。
  const checkpoint = opts.checkpoint && typeof opts.checkpoint === "object"
    ? opts.checkpoint
    : undefined;

  // 本会话内已 Read 过的文件（edit_file 的 read-before-edit 前置校验依据，对齐 ZCode）。
  const readPaths = new Set();

  /** 文件不存在时的相似文件名建议（对齐 ZCode：Levenshtein 距离最近的兄弟文件）。 */
  async function suggestSimilarFile(targetPath) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const idx = Math.max(targetPath.lastIndexOf("/"), targetPath.lastIndexOf("\\"));
      if (idx <= 0) return undefined;
      const parent = targetPath.slice(0, idx);
      const base = targetPath.slice(idx + 1);
      const entries = await invoke("fs_list_dir", { path: parent });
      const names = (Array.isArray(entries) ? entries : [])
        .map((e) => (typeof e === "string" ? e : e?.name))
        .filter((n) => typeof n === "string");
      function lev(a, b) {
        const m = a.length;
        const n = b.length;
        if (!m || !n) return Math.max(m, n);
        const prev = new Array(n + 1);
        const curr = new Array(n + 1);
        for (let j = 0; j <= n; j++) prev[j] = j;
        for (let i = 1; i <= m; i++) {
          curr[0] = i;
          for (let j = 1; j <= n; j++) {
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
          }
        }
        return curr[n];
      }
      const lower = base.toLowerCase();
      let best;
      let bestDist = Infinity;
      for (const name of names) {
        if (name === base) continue;
        const d = lev(lower, name.toLowerCase());
        if (d < bestDist) {
          bestDist = d;
          best = name;
        }
      }
      // 只有足够接近才建议（距离 > 长度一半视为无关文件）
      return best && bestDist <= Math.max(3, Math.ceil(lower.length / 2))
        ? parent + "/" + best
        : undefined;
    } catch {
      return undefined;
    }
  }

  function isNotFoundMessage(message) {
    return /not found|no such|does not exist/i.test(message);
  }

  const readFile = {
    name: "read_file",
    label: "读取文件",
    description:
      "读取指定路径的文件内容（支持绝对路径或相对于项目工作区的相对路径）。\n" +
      "- Reads up to 2000 lines / 256KB by default; longer output is truncated with an explicit marker (page through the rest with exec_command if needed).\n" +
      "- Do NOT re-read a file you just edited to verify — edit_file/write_file would have errored if the change failed.\n" +
      "- 空文件会如实返回空内容警告；文件不存在时会给出行内相似文件名建议。",
    parameters: Type.Object(
      {
        path: Type.String({ description: "文件的路径（相对路径将自动相对于当前工作区根目录解析）" }),
      },
      { required: ["path"] },
    ),
    execute: async (_toolCallId, params) => {
      const { invoke } = await import("@tauri-apps/api/core");
      const targetPath = resolveWorkspacePath(params.path, getWorkspace());
      let content;
      try {
        content = await invoke("fs_read_file", { path: targetPath });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isNotFoundMessage(message)) {
          const suggestion = await suggestSimilarFile(targetPath);
          throw new Error(
            `File does not exist: ${targetPath}. Note: the working directory is ${getWorkspace()}.` +
              (suggestion ? ` Did you mean ${suggestion}?` : ""),
          );
        }
        throw err;
      }
      readPaths.add(targetPath);
      // 行数闸（对齐 ZCode READ_DEFAULT_MAX_LINES=2000）先生效并注明总行数，
      // 字节闸（readFileBytes=256KB）在 buildTextToolResult 出口二次兜底。
      const capped = applyReadLineCap(
        content.length === 0 ? "Warning: the file exists but the contents are empty." : content,
      );
      return buildTextToolResult(
        capped.text,
        {
          path: targetPath,
          requestedPath: params.path,
          totalLines: capped.totalLines,
          linesTruncated: capped.truncated,
        },
        TOOL_LIMITS.readFileBytes,
      );
    },
  };

  const writeFile = {
    name: "write_file",
    label: "写入文件",
    description: "将内容写入指定文件（全量覆盖，父目录若不存在会自动创建。支持绝对路径或相对于项目工作区的相对路径）。\n- For partial changes, prefer edit_file over rewriting the whole file.",
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
      await invoke("fs_write_file", {
        path: targetPath,
        content: params.content,
        ...(checkpoint ? { checkpoint: { ...checkpoint, root: getWorkspace() } } : {}),
      });
      readPaths.add(targetPath);
      return buildTextToolResult(`Successfully written to ${targetPath}`, { path: targetPath, requestedPath: params.path });
    },
  };

  const editFile = {
    name: "edit_file",
    label: "编辑文件块",
    description:
      "精准替换文件中的特定代码或文本块。\n" +
      "- You must read_file the file in this conversation before editing, or the call will fail.\n" +
      "- target 必须精确匹配文件中的现有片段（含缩进与空白）且唯一出现，否则编辑失败。\n" +
      "- 支持绝对路径或相对于工作区的相对路径。",
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
      if (!readPaths.has(targetPath)) {
        throw new Error(`File has not been read yet. Read it first before writing to it: ${targetPath}`);
      }
      let oldContent;
      try {
        oldContent = await invoke("fs_read_file", { path: targetPath });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isNotFoundMessage(message)) {
          const suggestion = await suggestSimilarFile(targetPath);
          throw new Error(
            `File does not exist: ${targetPath}.` +
              (suggestion ? ` Did you mean ${suggestion}?` : ""),
          );
        }
        throw err;
      }
      const occurrences = oldContent.split(params.target).length - 1;
      if (occurrences === 0) {
        throw new Error(
          `edit_file: target text not found in ${targetPath}. The target must match the file exactly, including indentation and whitespace — copy it from the read output.`,
        );
      }
      if (occurrences > 1) {
        throw new Error(
          `Found ${occurrences} matches of the target string in ${targetPath}. Provide a longer, more specific target that is unique in the file.`,
        );
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
      return buildTextToolResult(JSON.stringify(entries, null, 2), { path: targetPath, entries, requestedPath: params.path }, TOOL_LIMITS.listDirBytes);
    },
  };

  const execCommand = {
    name: "exec_command",
    label: "执行终端命令",
    description: "在系统终端中执行 shell 命令行（支持 bash / sh 语法，例如 git status, ls 等）。默认在当前项目工作区根目录下执行。输出上限 30KB，超出会被截断并附标记。",
    parameters: Type.Object(
      {
        command: Type.Optional(Type.String({ description: "要执行的命令行内容" })),
        // 兼容别名：部分模型会把参数名写成 cmd；schema 放行后在 execute 里归一化
        cmd: Type.Optional(Type.String({ description: "Alias of `command` (accepted for compatibility; normalized before execution)" })),
        cwd: Type.Optional(Type.String({ description: "执行命令的工作目录（未指定时默认使用当前项目工作区根目录）" })),
      },
      { required: [] },
    ),
    execute: async (_toolCallId, params) => {
      const command = typeof params.command === "string" && params.command.length > 0
        ? params.command
        : typeof params.cmd === "string" && params.cmd.length > 0
          ? params.cmd
          : undefined;
      if (command === undefined) {
        const received = Object.keys(params).filter((k) => k !== "cwd").join(", ") || "none";
        throw new Error(`exec_command: missing required parameter "command" (received: ${received})`);
      }
      const { invoke } = await import("@tauri-apps/api/core");
      const targetCwd = params.cwd ? resolveWorkspacePath(params.cwd, getWorkspace()) : getWorkspace();
      // 终端配置所选 shell（P2-G2）：exec 与终端面板/环境段提示保持一致
      let shell;
      try {
        const { getTerminalSettings } = await import("../terminal/terminalSettings");
        shell = getTerminalSettings().shell || undefined;
      } catch {
        shell = undefined; // 设置模块不可用时回退平台默认
      }
      const output = await invoke("fs_execute", { command, cwd: targetCwd, shell: shell ?? null });
      return buildTextToolResult(output, { command, cwd: targetCwd }, TOOL_LIMITS.execBytes);
    },
  };

  // ---- Glob：按模式匹配文件路径（对齐 ZCode handlers/glob.ts）----
  const globTool = {
    name: "glob",
    label: "匹配文件",
    description:
      "按 glob 模式匹配工作区内的文件路径（如 `src/**/*.tsx`、`**/*.md`）。\n" +
      "- 语义：`*` 不跨目录、`**` 跨目录、`?` 单字符；不支持字符类 [ ] 与花括号（会如实报错）。\n" +
      "- 自动跳过 .git / node_modules / target / dist 等目录；结果按路径排序，默认最多 500 条。\n" +
      "- 查找文件内容请用 grep（比 exec_command 里拼 findstr/grep 更快更稳）。",
    parameters: Type.Object(
      {
        pattern: Type.String({ description: "glob 模式（相对工作区根，如 src/**/*.ts）" }),
        path: Type.Optional(Type.String({ description: "搜索根目录（默认当前工作区）" })),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 5000, description: "返回条数上限（默认 500）" }),
        ),
      },
      { required: ["pattern"] },
    ),
    execute: async (_toolCallId, params) => {
      const { invoke } = await import("@tauri-apps/api/core");
      const root = params.path ? resolveWorkspacePath(params.path, getWorkspace()) : getWorkspace();
      const result = await invoke("fs_glob", {
        root,
        pattern: params.pattern,
        limit: params.limit,
      });
      const lines = result.entries.map((e) => (e.is_dir ? e.path + "/" : e.path));
      const text =
        lines.length === 0
          ? "No files matched."
          : lines.join("\n") +
            (result.truncated ? "\n…[truncated: 结果超出上限，请收窄模式]" : "");
      return buildTextToolResult(
        text,
        {
          root: result.root,
          pattern: params.pattern,
          matched: result.entries.length,
          truncated: result.truncated,
          entries: result.entries,
        },
        TOOL_LIMITS.listDirBytes,
      );
    },
  };

  // ---- Grep：按正则搜索文件内容（对齐 ZCode handlers/grep.ts）----
  const grepTool = {
    name: "grep",
    label: "搜索内容",
    description:
      "按正则表达式搜索工作区文件内容，返回 `文件:行号: 内容`。\n" +
      "- 自动跳过二进制文件、.git / node_modules 等目录、超过 2MB 的大文件（跳过数量如实回报）。\n" +
      "- 默认大小写敏感；用 ignore_case 开启不敏感。include 可按 glob 限定文件（如 `src/**/*.ts`）。\n" +
      "- 查找文件本身用 glob；不要用 exec_command 拼 findstr/grep。",
    parameters: Type.Object(
      {
        pattern: Type.String({ description: "正则表达式（如 function \\w+）" }),
        path: Type.Optional(Type.String({ description: "搜索根目录（默认当前工作区）" })),
        include: Type.Optional(
          Type.String({ description: "文件 glob 过滤（相对工作区根，如 src/**/*.ts）" }),
        ),
        ignore_case: Type.Optional(
          Type.Boolean({ description: "是否忽略大小写（默认 false）" }),
        ),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 2000, description: "命中条数上限（默认 200）" }),
        ),
      },
      { required: ["pattern"] },
    ),
    execute: async (_toolCallId, params) => {
      const { invoke } = await import("@tauri-apps/api/core");
      const root = params.path ? resolveWorkspacePath(params.path, getWorkspace()) : getWorkspace();
      const result = await invoke("fs_grep", {
        root,
        pattern: params.pattern,
        include: params.include,
        ignoreCase: params.ignore_case,
        limit: params.limit,
      });
      const lines = result.hits.map((h) => `${h.path}:${h.line}: ${h.text}`);
      const skipped =
        result.skipped_files > 0
          ? `\n…[skipped ${result.skipped_files} file(s): binary or too large]`
          : "";
      const text =
        lines.length === 0
          ? `No matches found for /${params.pattern}/`
          : lines.join("\n") +
            (result.truncated ? "\n…[truncated: 命中超上限，请收窄模式或 include]" : "") +
            skipped;
      return buildTextToolResult(
        text,
        {
          root: result.root,
          pattern: params.pattern,
          hits: result.hits.length,
          truncated: result.truncated,
          skippedFiles: result.skipped_files,
        },
        TOOL_LIMITS.listDirBytes,
      );
    },
  };

  // ---- 删除文件（对齐 LiveAgent fsTools Delete）----
  const deleteFile = {
    name: "delete_file",
    label: "删除文件",
    description:
      "删除工作区内的一个普通文件。\n" +
      "- You must read_file the file first — deleting what you have not read is refused by design.\n" +
      "- 拒绝删除目录与符号链接；删除前的文件内容会进入本轮的代码检查点，用户可「回退本轮代码改动」恢复。\n" +
      "- 批量/目录清理请用 exec_command。",
    parameters: Type.Object(
      {
        path: Type.String({ description: "要删除的文件路径" }),
      },
      { required: ["path"] },
    ),
    execute: async (_toolCallId, params) => {
      const { invoke } = await import("@tauri-apps/api/core");
      const targetPath = resolveWorkspacePath(params.path, getWorkspace());
      if (!readPaths.has(targetPath)) {
        throw new Error(
          `File has not been read yet. Read it first before deleting it: ${targetPath}`,
        );
      }
      await invoke("fs_delete_file", {
        path: targetPath,
        ...(checkpoint ? { checkpoint: { ...checkpoint, root: getWorkspace() } } : {}),
      });
      readPaths.delete(targetPath);
      return buildTextToolResult(`Deleted ${targetPath}`, {
        path: targetPath,
        requestedPath: params.path,
        deleted: true,
      });
    },
  };

  // ---- Todo：任务清单（对齐 ZCode handlers/todo.ts；随轮次落库，无需新持久化字段）----
  const todoWrite = {
    name: "todo_write",
    label: "任务清单",
    description:
      "创建或更新本次会话的任务清单（**全量覆盖**语义：每次传入完整清单）。\n" +
      "- 用于让用户看到你的计划与进度；复杂多步任务开始时先建清单，之后随进展更新状态。\n" +
      "- 状态取值：pending（待办）/ in_progress（进行中，同一时刻最多一项）/ completed（已完成）。\n" +
      "- 简单问答不要滥用清单。",
    parameters: Type.Object(
      {
        todos: Type.Array(
          Type.Object({
            content: Type.String({ description: "任务描述（简短、可验证）" }),
            status: Type.Union(
              [Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")],
              { description: "状态" },
            ),
          }),
          { description: "完整清单（覆盖式更新）" },
        ),
      },
      { required: ["todos"] },
    ),
    execute: async (_toolCallId, params) => {
      const todos = Array.isArray(params.todos) ? params.todos : [];
      const done = todos.filter((t) => t.status === "completed").length;
      const current = todos.find((t) => t.status === "in_progress");
      const lines = todos.map(
        (t) =>
          `${t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]"} ${t.content}`,
      );
      const text = [
        `清单已更新（${done}/${todos.length} 已完成${current ? `，当前：${current.content}` : ""}）`,
        ...lines,
      ].join("\n");
      return buildTextToolResult(text, {
        todos,
        completed: done,
        total: todos.length,
      });
    },
  };

  // ---- 后台 Bash（P1-4，对齐 ZCode bash-background-*）：启动驻留进程立即返回 taskId；
  //      输出经 task_output 增量读取；task_stop 终止进程树。任务列表经 bg_list 刷新。----
  const backgroundBash = {
    name: "background_bash",
    label: "后台命令",
    description:
      "Start a long-running background process (dev servers, watchers, long builds) and return immediately with a task ID. " +
      "The process keeps running; read its output later with task_output. " +
      "Use ONLY for processes that should keep running (npm run dev, watch modes) — for one-shot commands use exec_command.",
    parameters: Type.Object(
      {
        command: Type.String({ description: "要后台执行的命令行（如 npm run dev）" }),
        cwd: Type.Optional(Type.String({ description: "工作目录（默认当前工作区根）" })),
      },
      { required: ["command"] },
    ),
    execute: async (_toolCallId, params) => {
      const { invoke } = await import("@tauri-apps/api/core");
      const cwd = params.cwd ? resolveWorkspacePath(params.cwd, getWorkspace()) : getWorkspace();
      const result = await invoke("bg_spawn", { command: params.command, cwd });
      return buildTextToolResult(
        `Background task started: ${result.taskId}
` +
          `Read output with task_output(taskId="${result.taskId}"). Stop with task_stop(taskId="${result.taskId}").`,
        { taskId: result.taskId, command: params.command, cwd },
      );
    },
  };

  const taskOutput = {
    name: "task_output",
    label: "任务输出",
    description:
      "Read the output of a background task started with background_bash. " +
      "Pass offset from the previous call to get only new output. status=running means the process is still alive.",
    parameters: Type.Object(
      {
        task_id: Type.String({ description: "后台任务 ID（background_bash 返回的 taskId）" }),
        offset: Type.Optional(
          Type.Integer({ minimum: 0, description: "上次读到的总字节数（增量读取）" }),
        ),
      },
      { required: ["task_id"] },
    ),
    execute: async (_toolCallId, params) => {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke("bg_output", { taskId: params.task_id, offset: params.offset });
      // Rust 侧 BgOutput 为 serde camelCase（exitCode/newOutput/totalBytes/droppedBytes）
      const lines = [
        `task: ${result.taskId} · status: ${result.status}`,
        result.exitCode !== null && result.exitCode !== undefined ? `exit: ${result.exitCode}` : null,
        `output bytes: ${result.totalBytes}${result.droppedBytes > 0 ? ` (dropped ${result.droppedBytes} head bytes over cap)` : ""}`,
        "",
        result.newOutput || "(no new output)",
      ];
      return buildTextToolResult(lines.filter((l) => l !== null).join("\n"), {
        taskId: result.taskId,
        status: result.status,
        totalBytes: result.totalBytes,
      }, TOOL_LIMITS.execBytes);
    },
  };

  const taskStop = {
    name: "task_stop",
    label: "停止任务",
    description: "Stop a background task started with background_bash (kills the whole process tree).",
    parameters: Type.Object(
      {
        task_id: Type.String({ description: "要停止的后台任务 ID" }),
      },
      { required: ["task_id"] },
    ),
    execute: async (_toolCallId, params) => {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke("bg_stop", { taskId: params.task_id });
      const text = result.stopped
        ? `Task ${params.task_id} stopped.`
        : `Task ${params.task_id} not found (already stopped or removed).`;
      return buildTextToolResult(text, { taskId: params.task_id, stopped: result.stopped });
    },
  };

  // ---- WebFetch / WebSearch（P1-5，思路对齐 ZCode WebFetch 客户端实现；
  //      Rust 侧 web_tools.rs 出网：ureq + SSRF 防护 + DDG 搜索端点。----
  const webFetchTool = {
    name: "webfetch",
    label: "网页抓取",
    description:
      "Fetch a URL from the web, convert HTML to readable text, and return the page content. " +
      "HTTP is upgraded to HTTPS. Local/private network addresses and non-text content types are rejected. " +
      "Results are cached for 15 minutes (repeat fetches of the same URL are instant).",
    parameters: Type.Object(
      {
        url: Type.String({ description: "要抓取的完整 URL（http/https）" }),
        prompt: Type.Optional(
          Type.String({ description: "关注点：希望从页面内容中回答的问题（内容会原样返回，由你自行提炼）" }),
        ),
      },
      { required: ["url"] },
    ),
    execute: async (_toolCallId, params) => {
      const { invoke } = await import("@tauri-apps/api/core");
      const requested = params.url.trim();
      const cached = webCacheGet(requested);
      if (cached) {
        const text = [
          `${cached.finalUrl} · HTTP ${cached.status} · ${cached.contentType || "content-type 未提供"} · 原始 ${cached.bytes} 字节 · 缓存命中（15 分钟内有效）`,
          params.prompt ? `关注点: ${params.prompt}` : null,
          "",
          cached.text || "(页面无文本内容)",
        ];
        return buildTextToolResult(text.filter((l) => l !== null).join("\n"), {
          url: cached.finalUrl,
          status: cached.status,
          bytes: cached.bytes,
          cacheHit: true,
          prompt: params.prompt ?? null,
        }, TOOL_LIMITS.webFetchBytes);
      }
      const result = await invoke("web_fetch", { url: requested });
      webCacheSet(requested, result);
      const text = [
        `${result.finalUrl} · HTTP ${result.status} · ${result.contentType || "content-type 未提供"} · 原始 ${result.bytes} 字节`,
        params.prompt ? `关注点: ${params.prompt}` : null,
        "",
        result.text || "(页面无文本内容)",
      ];
      return buildTextToolResult(text.filter((l) => l !== null).join("\n"), {
        url: result.finalUrl,
        status: result.status,
        contentType: result.contentType,
        bytes: result.bytes,
        cacheHit: false,
        prompt: params.prompt ?? null,
      }, TOOL_LIMITS.webFetchBytes);
    },
  };

  const webSearchTool = {
    name: "websearch",
    label: "联网搜索",
    description:
      "Search the web and return result blocks with titles, URLs and snippets. " +
      "You may pass allowed_domains or blocked_domains (never both) to filter results by domain suffix. " +
      "After answering using results, end with a \"Sources:\" list of the URLs you used as markdown links.",
    parameters: Type.Object(
      {
        query: Type.String({ minLength: 2, description: "搜索查询词" }),
        allowed_domains: Type.Optional(
          Type.Array(Type.String(), { description: "仅保留这些域名（后缀匹配）" }),
        ),
        blocked_domains: Type.Optional(
          Type.Array(Type.String(), { description: "剔除这些域名（后缀匹配）" }),
        ),
      },
      { required: ["query"] },
    ),
    execute: async (_toolCallId, params) => {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke("web_search", {
        query: params.query,
        allowedDomains: params.allowed_domains,
        blockedDomains: params.blocked_domains,
      });
      const lines = [
        `${params.query} · ${result.results.length} 条结果（端点共 ${result.totalFound} 条，用时 ${result.durationMs}ms）`,
        "",
        ...result.results.map(
          (r, i) =>
            `${i + 1}. ${r.title || "(无标题)"}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`,
        ),
        "",
        "REMINDER: 回答引用上述结果后，必须以 \"Sources:\" 列表给出所用 URL 的 markdown 链接。",
      ];
      return buildTextToolResult(lines.join("\n"), {
        query: params.query,
        resultCount: result.results.length,
        totalFound: result.totalFound,
        durationMs: result.durationMs,
        sources: result.results.map((r) => ({ url: r.url, title: r.title })),
      }, TOOL_LIMITS.webSearchBytes);
    },
  };

  // ---- Browser（内嵌浏览器面板的工具面；Rust browser.rs WebView2 子控件 + CDP）----
  // 拆两个工具以对齐审批矩阵：browser_view=read（navigate/snapshot）、
  // browser_act=write（click/fill/evaluate）。前置条件：右侧浏览器面板已打开。
  const browserError = (message) => ({
    content: [{ type: "text", text: message }],
    isError: true,
  });

  // 在内嵌浏览器里执行 JS 并取回字符串结果（Rust 一次性 HTTP 回读通道）
  const evalInBrowser = async (expression) => {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke("browser_read_page", { js: expression });
  };
  /** 面板未开时自动打开（模型自服务，无需用户手动点开）；返回错误文案或 null */
  const ensureBrowserPane = async () => {
    const { invoke: inv } = await import("@tauri-apps/api/core");
    const isOpen = await inv("browser_is_open").catch(() => false);
    if (isOpen === true) return null;
    const { useAppStore } = await import("../../store/useAppStore");
    useAppStore.getState().openCodeViewer({ type: "browser", title: "浏览器" });
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if ((await inv("browser_is_open").catch(() => false)) === true) return null;
    }
    return "浏览器面板打开超时（10s）";
  };

  const cdp = evalInBrowser;

  const browserViewTool = {
    name: "browser_view",
    label: "浏览器查看",
    description:
      "Interact with the embedded browser panel (right dock). Actions:\n" +
      "- navigate: open a URL in the embedded browser, then return a page snapshot.\n" +
      "- snapshot: return the current page URL, title and visible text (first 6000 chars).\n" +
      "- screenshot: capture the page as an image and return it visually (use when layout/visuals matter; you receive the actual picture).\n" +
      "- elements: list interactive elements (buttons/links/inputs) with generated CSS selectors — use the returned selectors with browser_act click/fill.\n" +
      "The panel auto-opens on first use.",
    parameters: Type.Object(
      {
        action: Type.Union(
          [
            Type.Literal("navigate"),
            Type.Literal("snapshot"),
            Type.Literal("screenshot"),
            Type.Literal("elements"),
          ],
          {
            description:
              "navigate = 打开 URL；snapshot = 读取文本；screenshot = 截图（多模态查看页面）；elements = 列举可交互元素及其选择器",
          },
        ),
        url: Type.Optional(Type.String({ description: "navigate 的目标 URL（含协议）" })),
      },
      { required: ["action"] },
    ),
    execute: async (_toolCallId, params) => {
      try {
        const paneErr = await ensureBrowserPane();
        if (paneErr) return browserError(paneErr);
        const { invoke } = await import("@tauri-apps/api/core");
        if (params.action === "screenshot") {
          const shot = await invoke("browser_screenshot");
          // Windows 返回裸 base64（JPEG，CDP 截图）；Linux 返回 data URL（PNG，
          // WebKitGTK 原生 snapshot）——两种返回格式都兼容。
          if (typeof shot === "string" && shot.startsWith("data:image/")) {
            const mime = shot.slice(5, shot.indexOf(";"));
            const data = shot.slice(shot.indexOf(",") + 1);
            return {
              content: [
                { type: "text", text: `已截取当前页面图像（内嵌浏览器视口，${mime}）。` },
                { type: "image", data, mimeType: mime },
              ],
              details: { kind: "browser", action: "screenshot" },
            };
          }
          return {
            content: [
              { type: "text", text: "已截取当前页面图像（内嵌浏览器视口，JPEG）。" },
              { type: "image", data: shot, mimeType: "image/jpeg" },
            ],
            details: { kind: "browser", action: "screenshot" },
          };
        }
        if (params.action === "elements") {
          const script =
            "(function(){const els=[...document.querySelectorAll('a,button,input,select,textarea,[role=button],[role=link],[onclick]')]" +
            ".filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&r.top>=0&&r.top<innerHeight;}).slice(0,40);" +
            "function sel(el){if(el.id)return '#'+CSS.escape(el.id);const parts=[];let cur=el;for(let i=0;i<3&&cur&&cur!==document.body;i++){let p=cur.tagName.toLowerCase();" +
            "if(cur.id){p+='#'+CSS.escape(cur.id);parts.unshift(p);break}let idx=1;let sib=cur;while((sib=sib.previousElementSibling))idx++;p+=(':nth-of-type('+idx+')');parts.unshift(p);cur=cur.parentElement}return parts.join('>')}" +
            "const out=els.map((el)=>{const s=sel(el);const label=(el.innerText||el.placeholder||el.value||el.getAttribute('aria-label')||'').trim().replace(/\\s+/g,' ').slice(0,50);" +
            "return {tag: el.tagName.toLowerCase(), type: el.type||null, selector: s, label}});return JSON.stringify({count: out.length, elements: out})})()";
          const raw = await cdp(script);
          const parsed = JSON.parse(raw);
          const lines = parsed.elements.map(
            (el) =>
              "[" + el.tag + (el.type ? ":" + el.type : "") + "] " + (el.label || "(无文本)") + " → " + el.selector,
          );
          return buildTextToolResult(
            "可交互元素（视口内，前 40 个）——selector 可直接用于 browser_act 的 click/fill：\n\n" + lines.join("\n"),
            { count: parsed.count },
            TOOL_LIMITS.webFetchBytes,
          );
        }
        if (params.action === "navigate") {
          if (!params.url?.trim()) {
            return browserError("ERROR: navigate 需要 url 参数。");
          }
          await invoke("browser_navigate", { url: params.url.trim() });
          await new Promise((r) => setTimeout(r, 800)); // 等首帧渲染
        }
        const raw = await cdp(
          "(function(){return JSON.stringify({url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 6000)})})()",
        );
        const page = JSON.parse(raw);
        const head = params.action === "navigate" ? `已导航：${page.url}` : `当前页面：${page.url}`;
        return buildTextToolResult(
          `${head}\n标题：${page.title || "(无标题)"}\n\n${page.text || "(页面无可见文本)"}\n\n提示：需要看视觉布局用 action="screenshot"；需要精确操作用 action="elements" 列举选择器。`,
          { url: page.url, title: page.title },
          TOOL_LIMITS.webFetchBytes,
        );
      } catch (err) {
        return browserError(
          `浏览器不可用：${String(err).slice(0, 200)}\n（请先在右侧面板打开「浏览器」，再重试本工具）`,
        );
      }
    },
  };

  const browserActTool = {
    name: "browser_act",
    label: "浏览器操作",
    description:
      "Act on the embedded browser panel page (right dock). Actions:\n" +
      "- click: click an element by CSS selector (recommended, from browser_view elements), or at viewport coordinates (x, y).\n" +
      "- fill: set the value of a CSS-selector target and fire input/change events.\n" +
      "- evaluate: run JavaScript in the page and return its string result.\n" +
      "The panel auto-opens on first use. Write-level permission (approval may apply).",
    parameters: Type.Object(
      {
        action: Type.Union(
          [Type.Literal("click"), Type.Literal("fill"), Type.Literal("evaluate")],
          { description: "click = 点击；fill = 选择器填值；evaluate = 执行 JS" },
        ),
        selector: Type.Optional(
          Type.String({ description: "click/fill：目标元素 CSS 选择器（click 推荐用选择器而非坐标）" }),
        ),
        x: Type.Optional(Type.Integer({ description: "click（坐标模式）：视口 X 坐标" })),
        y: Type.Optional(Type.Integer({ description: "click（坐标模式）：视口 Y 坐标" })),
        text: Type.Optional(Type.String({ description: "fill：要填入的文本" })),
        expression: Type.Optional(Type.String({ description: "evaluate：要执行的 JS 表达式" })),
      },
      { required: ["action"] },
    ),
    execute: async (_toolCallId, params) => {
      try {
        const paneErr = await ensureBrowserPane();
        if (paneErr) return browserError(paneErr);
        if (params.action === "click") {
          if (params.selector?.trim()) {
            // 选择器模式：滚动到元素 → 取视口中心 → 派发完整鼠标事件序列
            const script =
              "(function(){const el=document.querySelector(" + JSON.stringify(params.selector.trim()) + ");" +
              'if(!el) return "ERROR: element not found"; el.scrollIntoView({block:"center"});' +
              "const r=el.getBoundingClientRect();const cx=r.left+r.width/2, cy=r.top+r.height/2;" +
              'for(const t of ["pointerdown","mousedown","pointerup","mouseup","click"]){el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:cx,clientY:cy}))}' +
              'return JSON.stringify({ok:true, tag: el.tagName.toLowerCase(), cx: Math.round(cx), cy: Math.round(cy)})})()';
            const out = await cdp(script);
            let parsed;
            try {
              parsed = JSON.parse(out);
            } catch {
              return browserError(`点击失败：${String(out).slice(0, 200)}`);
            }
            return buildTextToolResult(
              `已点击 ${parsed.tag}（视口中心 ${parsed.cx}, ${parsed.cy}）。`,
              { selector: params.selector, x: parsed.cx, y: parsed.cy },
            );
          }
          if (!Number.isFinite(params.x) || !Number.isFinite(params.y)) {
            return browserError("ERROR: click 需要 selector 或 x/y 视口坐标。");
          }
          await cdp(`(function(){const el=document.elementFromPoint(${params.x},${params.y});if(!el)return "ERROR: no element at point";for(const t of ["pointerdown","mousedown","pointerup","mouseup","click"]){el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:${params.x},clientY:${params.y}}))}return "OK"})()`);
          await new Promise((r) => setTimeout(r, 300));
          return buildTextToolResult(`已在 (${params.x}, ${params.y}) 派发点击事件。`, { x: params.x, y: params.y });
        }
        if (params.action === "fill") {
          if (!params.selector || params.text === undefined) {
            return browserError("ERROR: fill 需要 selector 与 text 参数。");
          }
          const expr =
            `(function(){const el=document.querySelector(${JSON.stringify(params.selector)});` +
            `if(!el) return "ERROR: element not found"; el.focus(); el.value=${JSON.stringify(params.text)};` +
            `el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return "OK";})()`;
          const out = await cdp(expr);
          return out === "OK"
            ? buildTextToolResult(`已向 ${params.selector} 填入文本。`, { selector: params.selector })
            : browserError(`填入失败：${String(out).slice(0, 200)}`);
        }
        // evaluate
        if (!params.expression?.trim()) {
          return browserError("ERROR: evaluate 需要 expression 参数。");
        }
        const value = await cdp(params.expression);
        return buildTextToolResult(
          `执行结果：${typeof value === "string" ? value : JSON.stringify(value, null, 1)?.slice(0, 3000)}`,
          undefined,
          TOOL_LIMITS.webFetchBytes,
        );
      } catch (err) {
        return browserError(
          `浏览器不可用：${String(err).slice(0, 200)}\n（请先在右侧面板打开「浏览器」，再重试本工具）`,
        );
      }
    },
  };

  return [readFile, writeFile, editFile, listDir, execCommand, globTool, grepTool, deleteFile, todoWrite, backgroundBash, taskOutput, taskStop, webFetchTool, webSearchTool, browserViewTool, browserActTool];
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
  if (options && (options.now || options.workspaceRoot || options.getWorkspaceRoot || options.checkpoint)) {
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
    case "glob":
    case "grep":
    case "todo_write":
    case "webfetch":
    case "websearch":
    case "browser_view":
      return "read";
    // agent（子代理派发）免审批（对齐 ZCode needsApproval:false）：拦截下沉到子代理
    // 内部工具——general-purpose 继承父审批门，plan 模式下子代理写工具同样被拦。
    // subagent_output 纯读内存 registry，同为只读。
    case "agent":
    case "subagent_output":
      return "read";
    case "exec_command":
    case "browser_act":
    case "background_bash":
    case "task_output":
    case "task_stop":
      return "exec";
    // ExitPlanMode（P2 尾巴 #8）：挂起等批准的交互工具，不适用写/执行拦截矩阵；
    // 模式可用性由 createApprovalGate 的专用分支裁决（仅计划模式放行）。
    case "exit_plan_mode":
    case "ask_user_question":
      return "read";
    default:
      return "write";
  }
}
