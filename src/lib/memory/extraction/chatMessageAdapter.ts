// ChatMessage → pi-ai Message 归一（抽取引擎唯一入户口）。
//
// 引擎的 context.ts / prompts 按 pi-ai Message（content 块）读取对话，而
// conversationPool 传入的是时间线 ChatMessage（.text；工具是独立的
// role:"tool" 条目）。曾因 `as any` 直接混用两种形状，extractLatestUserText
// 永远读到空串，每轮抽取在调模型之前即被 skipped:"empty-user-message" 静默
// 跳过（2026-10-06 探针实证 + 本文件回归测试钉死）。
//
// 输出只需满足 context.ts 实际消费的字段：role/content，toolResult 的
// toolCallId/toolName/isError。AssistantMessage 的 usage/api/provider 等库
// 必填字段不参与抽取窗口，不做任何假数据填充，以最小占位经类型断言通过。

import type { ChatMessage } from "../../chat/conversationModel.js";
import type {
  AssistantMessage,
  Message,
  TextContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";

export function toExtractionMessages(messages: readonly ChatMessage[]): Message[] {
  const out: Message[] = [];
  /** 当前工具条目挂载锚点：最近一条 assistant（用户消息后重置）。 */
  let lastAssistant: AssistantMessage | null = null;

  for (const entry of messages) {
    const timestamp = entry.startedAt ?? entry.endedAt ?? 0;

    if (entry.role === "user") {
      if (!entry.text.trim()) continue;
      const userMessage: UserMessage = { role: "user", content: entry.text, timestamp };
      out.push(userMessage);
      lastAssistant = null;
      continue;
    }

    if (entry.role === "assistant") {
      const content: (TextContent | ToolCall)[] = entry.text.trim()
        ? [{ type: "text", text: entry.text }]
        : [];
      // 库必填的 usage/api/stopReason 等与抽取窗口无关，占位断言（见文件头）。
      const assistantMessage = { role: "assistant", content, timestamp } as AssistantMessage;
      out.push(assistantMessage);
      lastAssistant = assistantMessage;
      continue;
    }

    // role === "tool"：时间线上的调用+结果合一 → assistant 的 toolCall 块 + toolResult 消息。
    const toolCall: ToolCall = {
      type: "toolCall",
      id: entry.toolCallId ?? `tool-${entry.id}`,
      name: entry.toolName ?? "unknown",
      arguments: (entry.args && typeof entry.args === "object" ? entry.args : {}) as ToolCall["arguments"],
    };
    if (lastAssistant) {
      lastAssistant.content.push(toolCall);
    } else {
      const anchor = { role: "assistant", content: [toolCall], timestamp } as AssistantMessage;
      out.push(anchor);
      lastAssistant = anchor;
    }
    const toolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [],
      isError: entry.isError === true,
      timestamp,
    };
    out.push(toolResult);
  }

  // 无文本也无工具挂载的 assistant 对窗口与 mutation 摘要都没有贡献，滤掉。
  return out.filter(
    (message) => message.role !== "assistant" || (message as AssistantMessage).content.length > 0,
  );
}
