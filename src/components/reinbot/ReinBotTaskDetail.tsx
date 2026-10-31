import { useState, useEffect, useRef } from "react";
import {
  Bot,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Terminal,
  Wrench,
  Clock,
} from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import {
  subscribeTask,
  getEntrySnapshot,
  getTaskExecutionStatus,
  subscribeStreaming,
} from "../../lib/chat/conversationPool";
import { MarkdownText } from "../chat/MarkdownText";

export interface ReinBotTaskDetailProps {
  taskId: string;
  reinBotName?: string;
  onClose?: () => void;
}

export function ReinBotTaskDetail({
  taskId,
  reinBotName = "ReinBot",
  onClose: _onClose,
}: ReinBotTaskDetailProps) {
  const tasks = useAppStore((state) => state.tasks);
  const task = tasks.find((t) => t.id === taskId);

  const [state, setState] = useState(() => getEntrySnapshot(taskId));
  const [, setStreamingTick] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 订阅会话池状态更新
  useEffect(() => {
    setState(getEntrySnapshot(taskId));
    const unsubscribeTask = subscribeTask(taskId, () => {
      setState(getEntrySnapshot(taskId));
    });
    const unsubscribeStreaming = subscribeStreaming(() => {
      setStreamingTick((t) => t + 1);
    });
    return () => {
      unsubscribeTask();
      unsubscribeStreaming();
    };
  }, [taskId]);

  // 新增消息时自动轻柔滚动到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [state.messages.length]);

  const taskStatus = getTaskExecutionStatus(taskId);

  // 提取工具执行与文件改动统计
  const toolCallsCount = state.messages.reduce((acc, m) => {
    const tools = (m as any).toolCalls || (m as any).toolInvocations || [];
    return acc + (Array.isArray(tools) ? tools.length : 0);
  }, 0);

  return (
    <div className="flex flex-col h-full w-full bg-[var(--surface)] select-text overflow-hidden">
      {/* 顶部任务信息条 */}
      <div className="flex items-center justify-between px-3 py-2 bg-[var(--bg-sunken)] border-b border-[var(--border)] shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {taskStatus === "running" ? (
            <Loader2 className="w-4 h-4 animate-spin text-[var(--brand)] shrink-0" />
          ) : taskStatus === "done" ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
          ) : taskStatus === "error" ? (
            <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />
          ) : (
            <Terminal className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
          )}
          <span className="text-xs font-semibold text-[var(--text)] truncate flex-1" title={task?.title || taskId}>
            {task?.title || "未命名任务"}
          </span>
        </div>
      </div>

      {/* 对话与执行流滚动区 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* 顶部专属标识：由 ReinBot 发送 */}
        <div className="flex items-center justify-end">
          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--surface-hover)] border border-[var(--border)] text-[11px] font-medium text-[var(--text-muted)] shadow-xs">
            <Bot className="w-3.5 h-3.5 text-[var(--brand)]" />
            <span>由 {reinBotName} 发送</span>
          </div>
        </div>

        {/* 消息与工具时间线 */}
        {state.messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center text-[var(--text-muted)]">
            <Loader2 className="w-6 h-6 animate-spin text-[var(--brand)] mb-2" />
            <p className="text-xs">任务已派发，正在初始化会话...</p>
          </div>
        ) : (
          state.messages.map((msg, index) => {
            const isUser = msg.role === "user";
            const toolInvocations = (msg as any).toolCalls || (msg as any).toolInvocations || [];

            return (
              <div key={msg.id || index} className="space-y-2">
                {/* 消息气泡 */}
                {msg.text && (
                  <div
                    className={`rounded-xl p-3 text-xs leading-relaxed min-w-0 break-words [overflow-wrap:anywhere] shadow-xs ${
                      isUser
                        ? "bg-[var(--brand)] text-[var(--brand-fg)] rounded-tr-xs"
                        : "bg-[var(--surface-hover)] text-[var(--text)] border border-[var(--border)] rounded-tl-xs"
                    }`}
                  >
                    {isUser ? (
                      <div className="whitespace-pre-wrap font-medium">{msg.text}</div>
                    ) : (
                      <MarkdownText text={msg.text} streaming={msg.status === "streaming"} />
                    )}
                  </div>
                )}

                {/* 工具调用折叠摘要卡片 */}
                {Array.isArray(toolInvocations) && toolInvocations.length > 0 && (
                  <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-sunken)] p-2 text-[11px] text-[var(--text-muted)] space-y-1">
                    <div className="flex items-center justify-between font-medium text-[var(--text)]">
                      <div className="flex items-center gap-1.5">
                        <Wrench className="w-3 h-3 text-[var(--brand)]" />
                        <span>已调用 {toolInvocations.length} 个工具</span>
                      </div>
                    </div>
                    <div className="space-y-1 pt-1 border-t border-[var(--border)]/60">
                      {toolInvocations.map((inv: any, i: number) => (
                        <div key={i} className="flex items-center justify-between font-mono text-[10px]">
                          <span className="truncate max-w-[200px] text-[var(--text)]">
                            {inv.name || inv.toolName || "tool"}
                          </span>
                          <span className={inv.isError ? "text-rose-500" : "text-emerald-500"}>
                            {inv.isError ? "失败" : "成功"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}

        {/* 正在执行指示器 */}
        {taskStatus === "running" && (
          <div className="flex items-center gap-2 p-3 rounded-xl bg-[var(--surface-hover)] border border-[var(--border)] text-xs text-[var(--text-muted)] animate-pulse">
            <Loader2 className="w-4 h-4 animate-spin text-[var(--brand)] shrink-0" />
            <span>智能体正在执行命令与编写代码...</span>
          </div>
        )}
      </div>

      {/* 底部状态汇总条 */}
      <div className="px-3 py-1.5 bg-[var(--bg-sunken)] border-t border-[var(--border)] flex items-center justify-between text-[11px] text-[var(--text-muted)] shrink-0 font-mono">
        <div className="flex items-center gap-2">
          <span>状态: {taskStatus === "running" ? "运行中" : taskStatus === "done" ? "已完成" : taskStatus === "error" ? "异常" : "就绪"}</span>
          {toolCallsCount > 0 && <span>· 工具: {toolCallsCount}</span>}
        </div>
        <div className="flex items-center gap-1">
          <Clock className="w-3 h-3" />
          <span>{task?.createdAt ? new Date(task.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "--:--"}</span>
        </div>
      </div>
    </div>
  );
}
