/**
 * subagentRunner —— 子代理引擎（P1-6，LA 式轻量版：进程内嵌套 runTurn）。
 *
 * 与参照的取舍：
 * - ZCode = 子代理是完整独立 session（事件镜像/右侧回放/恢复）——重；
 * - LA = 进程内递归 runner + 结构化卡片 + 私有持久化——轻。
 * 我们选 LA 形态：子代理跑在本文件内的嵌套 `runTurn`（agentRuntime），转录只在
 * 内存、不写主会话历史，最终报告作为 agent 工具的 toolResult 回到主循环。
 *
 * 结构性禁递归：agent 工具由 runAgentTurn 在解析出 model 之后注入，而
 * `getTools()` 注册表里没有 agent——子代理工具集来自注册表过滤，天然不含 agent。
 *
 * 权限（对齐 ZCode runtime/methods/subagent.ts 语义）：
 * - Explore：只读工具集（结构性保证，无 exec/write 类工具）+ 只读提示词，不挂审批门；
 * - general-purpose：完整注册表工具集 + 继承父审批门/工具级策略（写操作照常弹主会话审批）。
 * 两种类型都共享父轮 AbortSignal（父停子停，对齐 LA 共享 signal）。
 */

import { Type } from "typebox";
import {
  finishRun,
  getRun,
  getRunSignal,
  registerRun,
} from "../subagents/subagentRegistry.js";
import {
  DEFAULT_SUBAGENT_TOOLS,
  SUBAGENT_MUTATING_TOOLS,
  loadSubagentCatalog,
  normalizeSubagentHandle,
  resolveSubagentModelPin,
  type SubagentCatalog,
  type SubagentDefinition,
} from "../subagents/subagentDefinitions.js";

/** 子代理默认步数上限。ZCode maxTurns 默认 4；实测 Deepseek 碎步形态（工具轮+正文轮各占一步）
 *  4 步连「列目录+报告」都触顶，放宽到 6（主模型会收到触顶 ⚠ 警告并如实转告）。 */
export const SUBAGENT_MAX_STEPS = 6;

/** 定义是否可改动文件/执行命令（决定是否继承父审批门）。 */
export function subagentCanMutate(definition: SubagentDefinition): boolean {
  return definition.tools.some((tool) => SUBAGENT_MUTATING_TOOLS.includes(tool));
}

/** 组合子代理系统提示词（对齐 PI composeSubagentSystemPrompt 的框架行语义）。 */
export function composeSubagentSystemPrompt(definition: SubagentDefinition, workspaceRoot?: string): string {
  const mutationLine = subagentCanMutate(definition)
    ? "You may modify files inside the workspace; write operations go through the caller's approval flow."
    : "You have no file-modification tools; report findings instead of changing anything.";
  const base =
    `You are the "${definition.name}" subagent. ${definition.description}\n` +
    `${mutationLine}\n` +
    "Your final message is the ONLY thing returned to the caller: make it the complete report.\n\n" +
    definition.prompt;
  return workspaceRoot
    ? `${base}\n\nCurrent workspace root: ${workspaceRoot}. Relative paths in tool calls will automatically resolve against this root directory.`
    : base;
}

/** pi-ai Usage 字段（缺省 0 聚合）。 */
export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SubagentRunResult {
  /** 子代理最终 assistant 文本（它的报告）。 */
  content: string;
  toolUseCount: number;
  durationMs: number;
  usage: SubagentUsage;
  maxStepsReached: boolean;
  aborted: boolean;
  errorMessage?: string;
  /** 实际执行模型的 provider/model 戳（取自 assistant 原件；用量按真实模型记账）。 */
  provider?: string;
  model?: string;
}

/**
 * 子代理转录落库（P2 尾巴 #7）：复用 conversations.db 的 message/part 两表，
 * task_id = `subagent:<runId>`（不写 task 表 → 不会出现在会话列表/水合里）。
 * 每条 pi-ai 消息一行、整条 JSON 一个 part（kind="transcript_message"，忠实原样）。
 * 「在右侧打开」的完整回放从 conversation_load 读回。失败仅 warn——回放是增强，
 * 不能影响子代理本身的结果收敛。
 */
export async function persistSubagentTranscript(runId: string, messages: any[]): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const rows = messages.map((m, index) => ({
      msg_id: `sm${index}`,
      seq: index,
      role: String(m?.role ?? "assistant"),
      status: "done",
      started_at: null,
      ended_at: null,
      tool_name: null,
      tool_call_id: null,
      is_error: null,
      truncated_by: null,
      error: null,
      thinking_started_at: null,
      thinking_duration_ms: null,
      parts: [
        {
          part_index: 0,
          kind: "transcript_message",
          payload: JSON.stringify(m ?? {}),
        },
      ],
    }));
    await invoke("conversation_sync", { taskId: `subagent:${runId}`, messages: rows });
  } catch (err) {
    console.warn(`[subagent] transcript persist failed for ${runId} (replay unavailable):`, err);
  }
}

/** 从转录快照聚合子代理运行事实（纯函数，可测）。 */
export function summarizeSubagentRun(
  messages: any[],
  durationMs: number,
  maxStepsReached: boolean,
  aborted: boolean,
  errorMessage: string | undefined,
): SubagentRunResult {  let content = "";
  let toolUseCount = 0;
  let provider: string | undefined;
  let model: string | undefined;
  const usage: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "assistant") {
      // 真实模型戳（pi-ai assistant 原件自带；钉选模型与会话模型都由此如实反映）
      if (!provider && typeof m.provider === "string" && m.provider) provider = m.provider;
      if (!model && typeof m.model === "string" && m.model) model = m.model;
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
            content = block.text; // 取末个非空文本块
          } else if (block?.type === "toolCall" || block?.type === "tool_use") {
            toolUseCount += 1;
          }
        }
      }
      const u = m.usage as Record<string, unknown> | undefined;
      if (u && typeof u === "object") {
        usage.input += typeof u.input === "number" ? u.input : 0;
        usage.output += typeof u.output === "number" ? u.output : 0;
        usage.cacheRead += typeof u.cacheRead === "number" ? u.cacheRead : 0;
        usage.cacheWrite += typeof u.cacheWrite === "number" ? u.cacheWrite : 0;
      }
    } else if (m.role === "toolResult") {
      // 兜底计数：某些形态下 toolCall 块计数可能缺失
    }
  }
  return {
    content: content.trim(),
    toolUseCount,
    durationMs,
    usage,
    maxStepsReached,
    aborted,
    errorMessage,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  };
}

/** 子代理工具注入面（runAgentTurn 解析出模型后闭包传入）。桥接层签名放宽为 any。 */
export interface SubagentToolDeps {
  /** pi-ai Model 对象（父轮默认；定义钉选模型可覆盖）。 */
  model: any;
  /** provider 级 stream 函数。 */
  stream: (model: any, context: any, options?: any) => any;
  api: string;
  label: string;
  getApiKey: (provider: string) => any;
  thinkingLevel?: string;
  workspaceRoot?: string;
  /** 父轮 AbortSignal：父停子停。 */
  signal?: AbortSignal;
  /** 父审批门（可改动定义继承；只读定义不挂）。 */
  beforeToolCall?: (ctx: any, signal?: AbortSignal) => Promise<{ block?: boolean; reason?: string } | undefined>;
  /** 父轮工具注册表（getTools() 结果——不含 agent，天然禁递归）。 */
  registryTools: unknown[];
  /** 目录注入（测试用）；缺省运行时加载 loadSubagentCatalog()。 */
  catalog?: SubagentCatalog;
  /** 后台子代理完成回调（系统通知；缺省浏览器环境默认实现）。 */
  notify?: (info: { id: string; type: string; description: string; status: string; summary: string; error?: string }) => void;
  now?: () => number;
}

/** 后台完成通知的浏览器默认实现（系统通知 + 提示音；Node/Web 不可达时静默）。 */
async function defaultNotify(info: {
  id: string;
  type: string;
  description: string;
  status: string;
  summary: string;
  error?: string;
}): Promise<void> {
  try {
    const { sendSystemNotification, playNotificationSound } = await import("../chat/taskNotifications.js");
    const statusLabel =
      info.status === "completed" ? "已完成" : info.status === "stopped" ? "已停止" : "失败";
    const head = info.summary ? info.summary.slice(0, 120) : (info.error ?? "");
    await sendSystemNotification(`子代理${statusLabel}：${info.description}`, head);
    playNotificationSound();
  } catch {
    // 通知通道不可用不应影响子代理收束
  }
}

/** 工具结果对象形状（与 tools.js buildTextToolResult 对齐的最小面）。 */
export interface SubagentToolResult {
  content: { type: "text"; text: string; bytes?: number }[];
  details?: Record<string, unknown>;
  isError?: boolean;
}

/** 渲染目录到工具描述（对齐 PI：- name (tools: …): 描述）。 */
export function renderSubagentCatalogDescription(catalog: SubagentCatalog): string {
  const items = catalog.definitions.length
    ? catalog.definitions
        .map((def) => {
          const tools = def.tools.length ? def.tools.join(", ") : "default set";
          return `- ${def.name} (tools: ${tools}): ${def.description}`;
        })
        .join("\n")
    : "(no subagent definitions configured)";
  return (
    "Launch a subagent to handle a complex, multi-step task autonomously.\n" +
    "Available subagents:\n" +
    items +
    "\nThe subagent runs with its own context and its final message is returned as the tool result — " +
    "so the prompt must be self-contained (goal, constraints, expected output). " +
    "Set run_in_background=true to return immediately and let the subagent keep running " +
    "(read its report later with subagent_output). " +
    "Use this for broad codebase searches, multi-file investigations, or independent subtasks; " +
    "for simple lookups use the direct tools instead."
  );
}

/** 按定义工具白名单过滤注册表（未知名字自然落空；注册表无 agent，天然禁递归）。 */
export function filterToolsForDefinition(definition: SubagentDefinition, registryTools: unknown[]): unknown[] {
  const wanted = new Set(definition.tools.length > 0 ? definition.tools : DEFAULT_SUBAGENT_TOOLS);
  return registryTools.filter(
    (t) =>
      t !== null &&
      typeof t === "object" &&
      typeof (t as { name?: unknown }).name === "string" &&
      wanted.has((t as { name: string }).name),
  );
}

/**
 * 构造 `agent` 工具（定义驱动，2026-10-01 对齐 PI-Desktop 子智能体目录）。
 * 不暴露 model 参数——历史 tool call 里的旧 override 会长期污染后续轮。
 * run_in_background=true 时立即返回运行 id，报告经 `subagent_output` 查询；
 * 后台完成触发 notify 回调（系统通知）。**异步工厂**：需先加载定义目录渲染描述。
 */
export async function createSubagentTool(deps: SubagentToolDeps) {
  const now = deps.now ?? (() => Date.now());
  const notify = deps.notify ?? defaultNotify;
  const catalog = deps.catalog ?? (await loadSubagentCatalog());
  return {
    name: "agent",
    label: "子代理",
    description: renderSubagentCatalogDescription(catalog),
    parameters: Type.Object(
      {
        description: Type.String({ description: "任务的简短描述（3-5 个词）" }),
        prompt: Type.String({ description: "交给子代理的完整任务说明（必须自包含：目标、约束、期望产出）" }),
        subagent_type: Type.Optional(
          Type.String({ description: "子代理句柄（见工具描述目录）；缺省 explorer（只读调研）" }),
        ),
        run_in_background: Type.Optional(
          Type.Boolean({ description: "true = 立即返回、子代理后台运行（经 subagent_output 查询结果）" }),
        ),
      },
      { required: ["description", "prompt"] },
    ),
    execute: async (
      _toolCallId: string,
      params: { description: string; prompt: string; subagent_type?: string; run_in_background?: boolean },
    ): Promise<SubagentToolResult> => {
      const handle = normalizeSubagentHandle((params.subagent_type ?? "explorer").trim());
      const definition = catalog.definitions.find((def) => def.name === handle);
      // 未知句柄如实报错并列出可用目录（不静默降级——模型应当修正句柄名）
      if (!definition) {
        const available = catalog.definitions.map((def) => def.name).join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Unknown subagent_type "${params.subagent_type ?? handle}". Available: ${available}.`,
            },
          ],
          isError: true,
        };
      }
      const type = definition.name;

      // 模型钉选：定义优先；供应商缺失 → 如实报错；API Key 空 → 抛错也如实报错（不静默回落）
      let pinned: { model: any; stream: any; api: string; label: string; getApiKey: () => any } | null = null;
      if (definition.model) {
        let resolved: Awaited<ReturnType<typeof resolveSubagentModelPin>> = null;
        try {
          resolved = await resolveSubagentModelPin(definition.model);
        } catch (err) {
          return {
            content: [{ type: "text", text: `Subagent "${type}" model pin failed: ${String(err)}` }],
            isError: true,
          };
        }
        if (!resolved) {
          return {
            content: [
              {
                type: "text",
                text: `Subagent "${type}" pins model "${definition.model}" which is not configured. Configure it in model settings or edit the definition.`,
              },
            ],
            isError: true,
          };
        }
        pinned = resolved;
      }

      const scopedTools = filterToolsForDefinition(definition, deps.registryTools);
      if (scopedTools.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Subagent "${type}" has no usable tools (granted: ${definition.tools.join(", ") || "default"}; none match the registry).`,
            },
          ],
          isError: true,
        };
      }

      const { runTurn } = await import("../agent/agentRuntime.js");
      const startedAt = now();
      const runId = registerRun({
        type,
        description: params.description,
        prompt: params.prompt,
        background: params.run_in_background === true,
        startedAt,
      });

      /** 共享推进逻辑：跑嵌套循环 → 汇总 → registry 收束（+ 后台通知）。 */
      const driveRun = async (signal: AbortSignal | undefined): Promise<SubagentRunResult> => {
        const result = await runTurn({
          model: pinned?.model ?? deps.model,
          stream: pinned?.stream ?? deps.stream,
          api: pinned?.api ?? deps.api,
          label: pinned?.label ?? deps.label,
          getApiKey: pinned?.getApiKey ?? deps.getApiKey,
          systemPrompt: composeSubagentSystemPrompt(definition, deps.workspaceRoot),
          // 转录末条为 user：子代理任务作为单条 user 消息进入
          messages: [{ role: "user", content: params.prompt, timestamp: Date.now() }],
          tools: scopedTools as any[],
          signal,
          maxSteps: SUBAGENT_MAX_STEPS,
          // 定义钉选 thinking 优先（off 映射关闭），否则跟随会话
          thinkingLevel: (definition.thinkingLevel === "off"
            ? "off"
            : definition.thinkingLevel ?? deps.thinkingLevel ?? "off") as any,
          // 可改动定义：继承父审批门（写操作弹主会话审批）；只读定义结构性安全不挂。
          beforeToolCall: subagentCanMutate(definition) ? deps.beforeToolCall : undefined,
          onEvent: () => {},
        });
        // 转录落库（P2 尾巴 #7）：完成后即可在右侧面板完整回放
        void persistSubagentTranscript(runId, result.messages);
        const summary = summarizeSubagentRun(
          result.messages,
          now() - startedAt,
          result.maxStepsReached,
          result.aborted,
          result.errorMessage,
        );
        return summary;
      };

      // ---- 后台：立即返回 id，嵌套循环脱离父轮继续跑 ----
      if (params.run_in_background === true) {
        const signal = getRunSignal(runId);
        void driveRun(signal)
          .then((summary) => {
            const status = summary.aborted ? "stopped" : summary.errorMessage ? "failed" : "completed";
            finishRun(runId, status, {
              toolUseCount: summary.toolUseCount,
              durationMs: summary.durationMs,
              usage: summary.usage,
              summary: summary.content,
              error: summary.errorMessage,
              maxStepsReached: summary.maxStepsReached,
            });
            void notify({
              id: runId,
              type,
              description: params.description,
              status,
              summary: summary.content,
              error: summary.errorMessage,
            });
          })
          .catch((err) => {
            finishRun(runId, "failed", { error: String(err), summary: "" });
          });
        return {
          content: [
            {
              type: "text",
              text:
                `Background subagent started: ${runId} (${type})\n` +
                `Read its report later with subagent_output(id="${runId}"). ` +
                `The user will be notified when it completes.`,
            },
          ],
          details: {
            kind: "subagent",
            subagentType: type,
            subagentId: runId,
            description: params.description,
            prompt: params.prompt,
            background: true,
          },
        };
      }

      // ---- 前台：await 嵌套循环（父 signal 桥接——父停子停）----
      const summary = await driveRun(deps.signal);
      const status = summary.aborted ? "stopped" : summary.errorMessage ? "failed" : "completed";
      finishRun(runId, status, {
        toolUseCount: summary.toolUseCount,
        durationMs: summary.durationMs,
        usage: summary.usage,
        summary: summary.content,
        error: summary.errorMessage,
      });

      // 结果文本（对齐 ZCode formatAgentOutputForResult：报告 + 事实头 + usage 块）
      const used =
        summary.usage.input + summary.usage.output + summary.usage.cacheRead + summary.usage.cacheWrite;
      const header = [
        `subagent ${type} · ${summary.toolUseCount} tool calls · ${Math.round(summary.durationMs / 100) / 10}s · ${used} tokens (in ${summary.usage.input} / out ${summary.usage.output} / cache ${summary.usage.cacheRead})`,
        summary.maxStepsReached
          ? "⚠ 步数上限触顶：子代理可能未完成，报告可能不完整。"
          : null,
        summary.aborted ? "⚠ 已被用户停止。" : null,
        summary.errorMessage ? `⚠ 子代理错误：${summary.errorMessage}` : null,
      ].filter((l) => l !== null);
      const body = summary.content || "(子代理没有产出任何文本报告)";
      const text = [...header, "", body].join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          kind: "subagent",
          subagentType: type,
          subagentId: runId,
          description: params.description,
          prompt: params.prompt,
          background: false,
          toolUseCount: summary.toolUseCount,
          durationMs: summary.durationMs,
          usage: summary.usage,
          // 用量按真实模型记账（Rust 回填读这两个字段；缺省由 Rust 侧兜底 unknown）
          ...(summary.provider ? { provider: summary.provider } : {}),
          ...(summary.model ? { model: summary.model } : {}),
          maxStepsReached: summary.maxStepsReached,
          aborted: summary.aborted,
          error: summary.errorMessage ?? null,
          summary: body.slice(0, 2000),
        },
      };
    },
  };
}

/**
 * 构造 `subagent_output` 工具：按 id 查询后台子代理的状态与报告
 * （对齐 ZCode 后台 agent 的 output 文件语义）。
 */
export function createSubagentOutputTool() {
  return {
    name: "subagent_output",
    label: "子代理输出",
    description:
      "Read the status and final report of a subagent started with run_in_background=true. " +
      "status=running means it is still working; the report field appears once it completes.",
    parameters: Type.Object(
      {
        id: Type.String({ description: "子代理运行 id（agent 工具后台启动时返回）" }),
      },
      { required: ["id"] },
    ),
    execute: async (_toolCallId: string, params: { id: string }): Promise<SubagentToolResult> => {
      const record = getRun(params.id);
      if (!record) {
        return {
          content: [
            { type: "text", text: `subagent_output: 未找到运行 ${params.id}（id 无效或应用已重启）。` },
          ],
          isError: true,
        };
      }
      const elapsed = Math.round(((record.endedAt ?? Date.now()) - record.startedAt) / 100) / 10;
      const used = record.usage
        ? record.usage.input + record.usage.output + record.usage.cacheRead + record.usage.cacheWrite
        : null;
      const lines = [
        `${record.id} · ${record.type} · status: ${record.status} · ${elapsed}s${used !== null ? ` · ${used} tokens` : ""}`,
        record.maxStepsReached
          ? "⚠ 该运行触达步数上限：可能未产出最终报告，下方内容可能是中间叙述。"
          : null,
        "",
        record.status === "running"
          ? "(still running — check again later)"
          : record.summary || `(no report${record.error ? ` · error: ${record.error}` : ""})`,
      ].filter((l) => l !== null);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          kind: "subagent_output",
          subagentId: record.id,
          status: record.status,
          subagentType: record.type,
          description: record.description,
        },
      };
    },
  };
}

/** 按定义工具白名单过滤注册表（供外部复用；见上方同名实现）。 */
export { filterToolsForDefinition as filterToolsFor };
