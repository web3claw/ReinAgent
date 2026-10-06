/**
 * requestPreview —— 「下一次请求预览」的纯构建层。
 *
 * 同源铁律（No-Fallback）：所有内容都来自真实发送链路使用的同一批函数——
 * - 上下文装配：`assembleTurnContext`（与 runAgentTurn 共用；预览传 runSessionStartHooks=false
 *   以回避外部 hook 副作用，其余逐字同源）；
 * - 消息：`toApiMessages` + `microcompactMessages`（与 controller 发送前同管道）；
 * - 压缩水位线：`computeCompactionWatermark` + `lastUsedTokens` + `readPromptCeiling`（与
 *   autoCompact 判据同源），越线时如实提示「下次发送会先自动压缩」；
 * - 工具：注册表 + MCP + 询问/计划 + 记忆管理器（装配产物）+ 子代理对（同工厂构建）。
 *
 * 如实性边界（文档尾部注记同步声明）：这是装配到 pi-ai 流式调用前的视图；各协议适配器
 * 还会做最后一层协议转换（如 anthropic 的消息合并、请求参数拼装），预览不假装是最终 HTTP 字节。
 */

import type { Message } from "@earendil-works/pi-ai";
import type { ChatState } from "./conversationModel";
import { toApiMessages } from "./conversationModel.js";
import {
  computeCompactionWatermark,
  microcompactMessages,
  modelKeyOf,
} from "./compaction.ts";
import { readPromptCeiling } from "./promptCeiling";
import { lastUsedTokens } from "./conversationController.js";
import { assembleTurnContext, getStreamFnForApi } from "../providers/runAgentTurn";
import type { ApprovalMode, ApprovalCoordinator } from "../providers/runAgentTurn";
import { buildModel, type ProviderConfig } from "../providers/modelFactory";
import { createSubagentOutputTool, createSubagentTool } from "../providers/subagentRunner";

/** 展示体积护栏：单条目与整体上限（超限如实标注，防预览渲染巨文卡死）。 */
export const PREVIEW_ENTRY_MAX_CHARS = 4000;
export const PREVIEW_TOTAL_MAX_CHARS = 400_000;

export interface PreviewToolEntry {
  name: string;
  description: string;
  schemaJson: string;
}

export interface PreviewMessageEntry {
  role: string;
  /** 单行摘要（徽标旁） */
  summary: string;
  /** 正文（已按条目上限裁剪） */
  body: string;
  clipped: boolean;
  /** 图片/工具调用等块的如实标注 */
  notes: string[];
}

export interface RequestPreview {
  params: {
    provider: string;
    model: string;
    api: string;
    thinkingLevel?: string;
    maxOutputTokens: number;
    approvalMode: ApprovalMode;
    workspaceRoot?: string;
    demo: boolean;
  };
  systemPrompt: string;
  tools: PreviewToolEntry[];
  context: {
    currentDate: string;
    agentsMd: string;
    memory: string;
    skills: string;
    sessionStart: string;
  };
  messages: PreviewMessageEntry[];
  messageMergedNote: string | null;
  rawJson: string;
  /** 未截断的完整原始 JSON：rawJson 仅为弹窗渲染护栏（400k 截断防 Shiki 卡死），
   *  「复制全文」必须用本字段——落档/喂外部工具要的是完整形态。 */
  rawJsonFull: string;
  rawClipped: boolean;
  notes: string[];
}

export interface RequestPreviewInput {
  /** 发送选项（App.buildTurnOptions() 的产物，与真实下一次发送同源）。 */
  options: {
    source: string;
    config: ProviderConfig & { provider?: string; modelId?: string };
    systemPrompt?: string;
    workspaceRoot?: string;
    assistantId?: string;
    approvalMode?: ApprovalMode;
    thinkingLevel?: string;
    toolPolicies?: Record<string, "allow" | "ask" | "deny">;
  };
  /** 当前会话状态（时间线与计数器；与 UI 所见一致）。 */
  state: ChatState;
}

/** 预览专用的无副作用审批协调器：仅用于让工具清单与真实发送一致（ask/exit 工具挂载条件）。 */
const PREVIEW_APPROVAL_STUB: ApprovalCoordinator = {
  request: async () => "reject",
  isAlwaysAllowed: () => false,
  allowAlways: () => {},
};

function clip(value: string, max: number): { text: string; clipped: boolean } {
  if (value.length <= max) return { text: value, clipped: false };
  return { text: `${value.slice(0, max)}\n…[preview clipped: 原 ${value.length} 字符]`, clipped: true };
}

/** pi-ai 消息 → 展示条目（文本/思考/图片/工具调用/工具结果逐块标注）。 */
function messageEntry(message: Message): PreviewMessageEntry {
  const notes: string[] = [];
  const chunks: string[] = [];
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    chunks.push(content);
  } else if (Array.isArray(content)) {
    for (const raw of content) {
      const block = raw as { type?: unknown; text?: unknown; thinking?: unknown; data?: unknown; mimeType?: unknown; name?: unknown; id?: unknown; arguments?: unknown; toolCallId?: unknown; isError?: unknown };
      switch (block.type) {
        case "text":
          chunks.push(String(block.text ?? ""));
          break;
        case "thinking":
          chunks.push(`[thinking]\n${String(block.thinking ?? block.text ?? "")}`);
          break;
        case "image": {
          const bytes = typeof block.data === "string" ? block.data.length : 0;
          notes.push(`image ${String(block.mimeType ?? "?")} · ~${Math.round((bytes * 3) / 4)} bytes`);
          chunks.push(`[image ${String(block.mimeType ?? "?")}，base64 ${bytes} 字符，发送时内联]`);
          break;
        }
        case "toolCall": {
          const args = (() => {
            try {
              return JSON.stringify(block.arguments ?? {});
            } catch {
              return String(block.arguments);
            }
          })();
          notes.push(`toolCall ${String(block.name ?? "?")}`);
          chunks.push(`[toolCall ${String(block.name ?? "?")}]\n${args}`);
          break;
        }
        case "toolResult": {
          if (block.isError === true) notes.push("toolResult isError");
          chunks.push(`[toolResult ${String(block.toolCallId ?? "")}]`);
          break;
        }
        default:
          notes.push(`block:${String(block.type ?? "unknown")}`);
          chunks.push(JSON.stringify(raw)?.slice(0, 400) ?? "");
      }
    }
  }
  const { text, clipped } = clip(chunks.join("\n"), PREVIEW_ENTRY_MAX_CHARS);
  const summarySource = text.replace(/\s+/g, " ").trim();
  return {
    role: String((message as { role?: unknown }).role ?? "?"),
    summary: summarySource.length > 80 ? `${summarySource.slice(0, 80)}…` : summarySource,
    body: text,
    clipped,
    notes,
  };
}

/**
 * 构建预览。任何环节失败都向上抛真实错误（No-Fallback）；可降级的环节
 * （子代理对构建失败/无审批上下文）降级并写入 notes 如实标注。
 */
export async function buildRequestPreview(input: RequestPreviewInput): Promise<RequestPreview> {
  const { options, state } = input;
  const config = options.config;
  const workspaceRoot = options.workspaceRoot;
  const notes: string[] = [];

  // 1) 发送视图消息（与 controller 发送前同管道）
  const sendView = microcompactMessages(toApiMessages(state)) as Message[];
  const microcompactApplied = sendView.some((message) =>
    JSON.stringify((message as { content?: unknown }).content ?? "").includes("…[microcompacted:"),
  );

  // 2) 上下文装配（与 runAgentTurn 同源；预览不执行 SessionStart hooks）
  const assembly = await assembleTurnContext({
    config,
    messages: sendView,
    ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    ...(options.assistantId === undefined ? {} : { assistantId: options.assistantId }),
    approvalMode: options.approvalMode ?? "full",
    approval: PREVIEW_APPROVAL_STUB,
    runSessionStartHooks: false,
  });

  // 3) 子代理工具对（与发送同工厂；配置不完整时降级并如实标注）
  let tools = [...assembly.tools] as { name?: string; description?: string; parameters?: unknown; inputSchema?: unknown }[];
  let modelLabel: { api: string; provider: string } | null = null;
  try {
    const model = buildModel(config);
    modelLabel = { api: model.api, provider: model.provider };
    const stream = await getStreamFnForApi(model.api);
    const subagentTool = await createSubagentTool({
      model,
      stream,
      api: model.api,
      label: model.provider || "openai-completions",
      getApiKey: () => config.apiKey.trim(),
      workspaceRoot,
      thinkingLevel: (options.thinkingLevel ?? undefined) as never,
      registryTools: assembly.registryTools as never[],
      beforeToolCall: undefined,
    });
    tools = [...tools, createSubagentOutputTool(), subagentTool] as typeof tools;
  } catch (err) {
    notes.push(
      `子代理工具未能纳入预览（${err instanceof Error ? err.message : String(err)}）；注册表与其余工具仍如实列出。`,
    );
  }

  // 4) 压缩水位线（与 autoCompact 判据同源）：越线时如实提示
  const watermark = computeCompactionWatermark(
    config.contextWindow,
    config.maxOutputTokens,
    readPromptCeiling(modelKeyOf(config)),
  );
  const used = lastUsedTokens(state.messages);
  if (watermark !== undefined && used >= watermark) {
    notes.push(
      `当前用量（${used.toLocaleString()} tokens）已达压缩水位线（${Math.round(watermark).toLocaleString()}），下次发送将先自动压缩上下文。`,
    );
  }
  if (options.source === "faux") {
    notes.push("当前为演示模式（无可用 Key）：此预览反映装配内容，真实发送不会发生。");
  }
  if (microcompactApplied) {
    notes.push("较早轮次的超大工具结果已按 microcompact 规则折叠（发送视图，时间线原文不受影响）。");
  }
  notes.push("预览不含 SessionStart hooks 的追加内容（hook 是外部命令，仅真实发送时执行）。");
  notes.push(
    "这是装配到 pi-ai 流式调用前的视图；各协议适配器还会做最后一层协议转换，不必然等于最终 HTTP 字节。",
  );

  // 5) 工具序列化（描述 + schema；parameters 为 TypeBox schema，MCP 工具在 inputSchema 上）
  const toolEntries: PreviewToolEntry[] = tools
    .filter((tool): tool is { name: string; description?: string; parameters?: unknown; inputSchema?: unknown } => typeof tool?.name === "string")
    .map((tool) => {
      const schema = tool.parameters ?? tool.inputSchema ?? {};
      let schemaJson: string;
      try {
        schemaJson = JSON.stringify(schema, null, 2);
      } catch {
        schemaJson = String(schema);
      }
      return {
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        schemaJson,
      };
    });

  // 6) 消息展示视图（逐条裁剪）
  const entries = assembly.messages.map(messageEntry);
  const mergedNote = assembly.parts.currentDateLine
    ? "用户上下文（currentDate/项目指令/记忆/技能）已并入首条 user 消息头部（下方第一条 user 可见 <system-reminder> 块）。"
    : null;

  // 7) 原始 JSON（整体上限裁剪）
  const rawFull = (() => {
    try {
      return JSON.stringify(
        {
          systemPrompt: assembly.systemPrompt,
          // 与装配视图的 Tool 形状同构：{name, description, parameters}——
          // 漏 description 会让「工具描述引导」（如 agent 的 When to use）在预览里不可见。
          tools: toolEntries.map((tool) => ({
            name: tool.name,
            description: tool.description,
            schema: JSON.parse(tool.schemaJson),
          })),
          messages: assembly.messages,
        },
        null,
        2,
      );
    } catch (err) {
      return `[原始 JSON 序列化失败：${err instanceof Error ? err.message : String(err)}]`;
    }
  })();
  const raw = clip(rawFull, PREVIEW_TOTAL_MAX_CHARS);
  if (raw.clipped) {
    notes.push(
      `原始 JSON 已截断（原 ${rawFull.length} 字符，上限 ${PREVIEW_TOTAL_MAX_CHARS}）——仅影响本弹窗展示，复制全文仍为完整 JSON。`,
    );
  }

  return {
    params: {
      provider: String(config.provider ?? ""),
      model: String(config.modelId ?? ""),
      api: modelLabel?.api ?? String(config.apiFormat ?? ""),
      ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: String(options.thinkingLevel) }),
      maxOutputTokens: config.maxOutputTokens ?? 0,
      approvalMode: (options.approvalMode ?? "full") as ApprovalMode,
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      demo: options.source === "faux",
    },
    systemPrompt: assembly.systemPrompt,
    tools: toolEntries,
    context: {
      currentDate: assembly.parts.currentDateLine,
      agentsMd: assembly.parts.agentsMdSection,
      memory: assembly.parts.memorySection,
      skills: assembly.parts.skillsSection,
      sessionStart: assembly.parts.sessionStartContext,
    },
    messages: entries,
    messageMergedNote: mergedNote,
    rawJson: raw.text,
    rawJsonFull: rawFull,
    rawClipped: raw.clipped,
    notes,
  };
}
