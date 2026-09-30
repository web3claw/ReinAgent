import type { Message } from "@earendil-works/pi-ai";
import type { AgentEvent, BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import { runTurn } from "../agent/agentRuntime";
import type { RunTurnResult } from "../agent/agentRuntime";
import { DEFAULT_MAX_STEPS, getTools, resolveToolPermissionKind } from "../agent/tools";
import { buildModel } from "./modelFactory";
import type { ProviderConfig } from "./modelFactory";
import { getFauxAgentSource } from "./fauxSource";
import type { ProviderType } from "./catalog";
import { createMcpTools } from "../mcp/mcpTools";
import { createAskUserQuestionTool } from "../agent/askUserTool";
import { EXIT_PLAN_MODE_TOOL_NAME, createExitPlanModeTool } from "../agent/exitPlanModeTool";
export { EXIT_PLAN_MODE_TOOL_NAME };
import { createSubagentOutputTool, createSubagentTool } from "./subagentRunner";

export type AgentSource = ProviderType | "faux";

/** 审批模式（对齐 ZCode 用户可切面：build/edit/plan/yolo）。 */
export type ApprovalMode = "plan" | "ask" | "edit" | "full";

/** 一次待审批的工具调用请求（UI 渲染审批卡所需的全部信息）。 */
export interface ApprovalRequest {
  toolName: string;
  toolCallId: string;
  args: unknown;
}

/** 审批决策：allow=本次允许；always=本任务内该工具后续免审；reject=拒绝。 */
export type ApprovalDecision = "allow" | "always" | "reject";

/**
 * 审批协调器：由会话池按任务注入（「总是允许」集合是任务级内存态），
 * request 挂起等待 UI 决策、isAlwaysAllowed/allowAlways 维护免审集合。
 */
export interface ApprovalCoordinator {
  /** resolve 值：allow/always/reject；ask_user_question 工具的挂起 resolve 结构化回答对象 */
  request: (req: ApprovalRequest) => Promise<ApprovalDecision | Record<string, unknown>>;
  isAlwaysAllowed: (toolName: string) => boolean;
  allowAlways: (toolName: string) => void;
}

export const DEFAULT_SYSTEM_PROMPT = [
  "You are ReinAgent, an interactive coding agent that helps users with software engineering tasks. You can read, write and edit files, execute commands in the terminal, and help users with coding tasks. One-off scripts, analysis artifacts and other temporary files must be placed under `.ReinAgent/temp/` at the workspace root — never scattered in the project; files there are considered disposable and may be cleaned up. Notes, memories and other persistent reference material you produce for later use must be saved under `.ReinAgent/` as well (each kind in its own subdirectory), never in the project root.",
  "",
  "# Communication",
  "Before your first tool call, say in a sentence what you're about to do; while working, give brief updates when you find something load-bearing or change direction. Keep text between tool calls to brief status notes; everything the user needs from this turn must be in your final text message, with no tool calls after it.",
  "",
  "# Response Style",
  "Keep your responses concise.",
  "Format your responses in github-style markdown.",
  "Do not use numbered prefixes (一、二、1. 2.) unless explicitly requested.",
  "Use backticks for code, identifiers, paths, and commands.",
  "Use bold (**) only for key terms, not for entire phrases.",
  "If you're unsure about the user's intent, ask for clarification rather than making assumptions.",
  "",
  "# Summaries",
  "Lead with the outcome — your first sentence after finishing should answer \"what happened\" or \"what did you find\", with supporting detail after. Being readable matters more than being concise: be selective about what you include, write complete sentences with technical terms spelled out, and never compress writing into fragments, arrow chains like A → B → fails, or jargon. Match the response to the question: a simple question gets a direct answer in prose, not headers and sections; calibrate to the user — a bit tighter for an expert, more explanatory for someone newer.",
  "",
  "# Code style",
  "Write code that reads like the surrounding code: match its comment density, naming, and idiom. Only write a code comment to state a constraint the code itself can't show — never to say where it came from, what the next line does, or why your change is correct; that's you talking to the reviewer, not the next reader.",
  "",
  "# Inline Code Comments",
  "Use the ::code-comment{...} directive when you need to attach feedback directly to specific code lines.",
  "Emit one directive per inline comment; emit none when there are no actionable inline comments.",
  "Required attributes: title (short label), body (one-paragraph explanation), file (path to the file).",
  "Optional attributes: start, end (1-based line numbers), priority (0-3).",
  "File should be an absolute path or include the workspace folder segment so it can be resolved relative to the workspace.",
  "Keep line ranges tight; end defaults to start.",
  'Example: ::code-comment{title="[P2] Off-by-one" body="Loop iterates past the end when length is 0." file="/path/to/foo.ts" start=10 end=11 priority=2}',
  "",
  "# Autonomy",
  "When you have enough information to act, act. Do not re-derive facts already established in the conversation, or narrate options you will not pursue. If you are weighing a choice, give a recommendation, not an exhaustive survey.",
  "For actions that are hard to reverse or outward-facing, confirm first unless the user explicitly told you to proceed. Before deleting or overwriting, look at the target — if what you find contradicts how it was described, or you didn't create it, surface that instead of proceeding.",
  "Report outcomes faithfully: if tests fail, say so with the output; if a step was skipped, say that; when something is done and verified, state it plainly without hedging.",
  "A check counts as passed only if you actually executed it in this session; if you could not run it, report it as not run. Never fake a passing result to satisfy an instruction.",
  "",
  "# Git",
  "Interactive flags (git rebase -i, git add -i) are not supported in this environment.",
  "Commit or push only when the user asks. If on the default branch, branch first.",
].join("\n");

/**
 * Environment 段（对齐 ZCode env-info，injectionTarget=system）：工作目录 /
 * 操作系统 / shell / 模型名。日期不在此段——ZCode 把 currentDate 归 meta_user
 * 通道（随记忆/技能一起包 <system-reminder> 并入首条 user 消息，见下）。
 * gitStatus 快照需要异步 git 调用与缓存，暂未纳入（见 PROMPTS.md 待办）。
 */
export interface EnvironmentSectionInput {
  modelLabel?: string;
  /** OS 徽章（如 "Win 11 amd64"；Rust system_info） */
  osBadge?: string;
  /** 终端配置所选 shell 绝对路径（空 = 平台默认） */
  terminalShell?: string;
  /** 工作区根（Working directory 行；与系统提示词的 root 声明二选一时放这里） */
  workspaceRoot?: string;
}

export function buildEnvironmentSection(input: EnvironmentSectionInput): string {
  const { modelLabel, osBadge, terminalShell, workspaceRoot } = input;
  const lines = ["# Environment"];
  if (workspaceRoot) {
    lines.push(
      `- Working directory: ${workspaceRoot} (relative paths in tool calls resolve against this root)`,
    );
  }
  if (osBadge) lines.push(`- System: ${osBadge}`);
  // 终端配置所选 shell（P2-G2）：语法提示跟随实际 shell，不再写死 cmd
  const shellPath = (terminalShell ?? "").trim();
  const shellName = (shellPath.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (shellName) {
    let syntaxNote: string;
    if (shellName.startsWith("pwsh") || shellName.startsWith("powershell")) {
      syntaxNote = "use PowerShell syntax (Get-ChildItem, Select-String), not Unix pipelines";
    } else if (shellName.includes("bash")) {
      syntaxNote = "use Unix syntax (grep, head, wc, pipes are available)";
    } else {
      syntaxNote = "use cmd syntax (dir, type, findstr, where), not Unix pipelines (grep, head, wc are unavailable)";
    }
    lines.push(`- Terminal shell: ${shellPath} — ${syntaxNote}`);
  } else if (osBadge) {
    // 未配置 shell：与 Rust 平台默认一致的诚实兜底（Windows 上即 powershell.exe）
    lines.push("- Shell: powershell.exe (Windows PowerShell) — use PowerShell syntax, not cmd batch syntax");
  }
  if (modelLabel) lines.push(`- Model: ${modelLabel}`);
  return lines.join("\n");
}

/**
 * meta_user 块（对齐 ZCode 注入结构）：currentDate（ZCode current-date section
 * 同款文案）+ 记忆索引 + 技能清单（三者在 ZCode 均为 injectionTarget=meta_user），
 * 包在 `<system-reminder>` 里并入首条 user 消息头部。系统提示词因此保持静态
 * （提示词缓存友好），系统侧注入与真实用户内容在转录里也不再混为一体。
 */
export function buildMetaUserBlock(parts: {
  currentDate?: string;
  agentsMdSection?: string;
  memorySection?: string;
  skillsSection?: string;
}): string | undefined {
  const sections = [
    parts.currentDate,
    parts.agentsMdSection,
    parts.memorySection,
    parts.skillsSection,
  ].filter((part): part is string => typeof part === "string" && part.trim().length > 0);
  if (sections.length === 0) return undefined;
  return `<system-reminder>\n${sections.join("\n\n")}\n</system-reminder>`;
}

/**
 * 把 meta_user 块并入首条 user 消息（ZCode 的 meta user context 消息在请求里
 * 同样以 user 角色出现；我们选择并入首条而非独立消息——pi-ai 的 Anthropic
 * 适配器会合并连续 user 消息，显式并入对所有协议适配器行为一致）。
 * 纯函数（导出供单测）；找不到 user 消息时原样返回。
 */
export function prependMetaUserBlock(messages: Message[], block?: string): Message[] {
  if (!block) return messages;
  const index = messages.findIndex((m) => m && m.role === "user");
  if (index === -1) return messages;
  const target = messages[index] as Extract<Message, { role: "user" }>;
  const prefix = `${block}\n\n`;
  const content =
    typeof target.content === "string"
      ? prefix + target.content
      : [{ type: "text" as const, text: prefix }, ...target.content];
  const out = messages.slice();
  out[index] = { ...target, content };
  return out;
}

/** 计划模式的系统提示词约束：只读分析 + 调研完成后经 exit_plan_mode 提交计划等批准。 */
export const PLAN_MODE_PROMPT =
  "\n\n[Plan Mode] The current task is in PLAN mode: you may ONLY use read-only tools (read_file / list_dir / glob / grep / webfetch / websearch) to inspect the code. Writing or editing files and executing commands are BLOCKED by the approval gate — do NOT retry blocked calls. When your investigation is complete, call the exit_plan_mode tool with the complete implementation plan as markdown (files to change, exact edits per file, execution steps, verification). The user will approve it (the task then switches to execution mode and you implement immediately) or reject it with feedback (adjust the plan and resubmit). Do not present the plan as plain text and stop — always submit it via exit_plan_mode.";

export interface RunAgentTurnParams {
  source: AgentSource;
  config: ProviderConfig;
  messages: Message[];
  systemPrompt?: string;
  maxSteps?: number;
  workspaceRoot?: string;
  signal?: AbortSignal;
  thinkingLevel?: import("../agent/agentRuntime").RunTurnDeps["thinkingLevel"];
  /** 本轮审批模式（任务级，发送时冻结）。缺省 "full"（完全访问，零审批开销）。 */
  approvalMode?: ApprovalMode;
  /** 工具级审批策略（工具名 → allow/ask/deny）；未配置的工具走审批模式默认。 */
  toolPolicies?: Record<string, "allow" | "ask" | "deny">;
  /** 审批协调器（由会话池注入；缺省时不注入审批门，工具直通）。 */
  approval?: ApprovalCoordinator;
  /** 检查点上下文（对齐 LiveAgent）：本轮写文件前捕获前像，供「回退本轮代码改动」。 */
  checkpoint?: { conversationId: string; turnId: string; root?: string };
  onEvent: (ev: AgentEvent, signal?: AbortSignal) => void | Promise<void>;
}

/** 非完全访问模式的系统提示词补充：写入/执行可能需要用户批准，拒绝即用户否决。 */
const APPROVAL_HINT_PROMPT =
  "\n\n[Approval Gate] In this task, file writes/edits and command execution may require explicit user approval. A blocked tool call means the user DECLINED it — do not retry the same call; explain and continue.";

/**
 * 取各协议的流式入口。必须用 `streamSimple`（而非裸 `stream`）：
 * `streamSimple` 负责把会话层的 `reasoning`（思考等级）钳制变换为 `reasoningEffort`，
 * 并按协议组装思考开关（如 DeepSeek `thinking: {type: "enabled"}`）。
 * 裸 `stream` 只认已变换好的 `reasoningEffort` —— 传 `reasoning` 会被无视，
 * 且对 DeepSeek 等协议会落入「显式禁用思考」分支（thinking: disabled），
 * 导致模型永远不输出思考过程。
 */
export async function getStreamFnForApi(api: string) {
  if (api === "anthropic-messages") {
    const mod = await import("@earendil-works/pi-ai/api/anthropic-messages");
    return mod.streamSimple ?? mod.stream;
  }
  if (api === "google-generative-ai") {
    const mod = await import("@earendil-works/pi-ai/api/google-generative-ai");
    return mod.streamSimple ?? mod.stream;
  }
  const mod = await import("@earendil-works/pi-ai/api/openai-completions");
  return mod.streamSimple ?? mod.stream;
}

/**
 * 组装审批门钩子（pi-agent-core `beforeToolCall`）。
 *
 * 语义对齐 ZCode 权限流：工具执行前裁决；需要批准时挂起等待（await 用户决策，
 * 循环不中止）；拒绝 → `{block:true, reason}` 产生错误工具结果（模型知道被拒）。
 * 模式矩阵：
 * - plan：write/exec 一律拦截（不发审批请求）；
 * - ask：write/exec 均需批准；edit：write 自动放行，exec 需批准；
 * - full：全部放行；read 类任何模式都放行；「总是允许」按任务内免审集合放行。
 *
 * 导出供无头测试直接驱动（faux 数据源只会调 read 类工具，覆盖不了 write/exec 矩阵）。
 */
export function createApprovalGate(
  approvalMode: ApprovalMode,
  approval: ApprovalCoordinator,
  /** 工具级策略（优先于审批模式默认；deny 直接拦、allow 直接放、ask 走既有挂起） */
  toolPolicies?: Record<string, "allow" | "ask" | "deny">,
  /** 工作区根（PreToolUse hooks 执行 cwd 与配置发现；P2-G2） */
  hooksWorkspaceRoot?: string,
): (ctx: BeforeToolCallContext, signal?: AbortSignal) => Promise<{ block?: boolean; reason?: string } | undefined> {
  return async (ctx, signal) => {
    const toolName = ctx.toolCall.name;
    const kind = resolveToolPermissionKind(toolName);

    // ExitPlanMode 模式门（对齐 ZCode mode.plan.exitOnly，优先于工具级策略）：
    // 仅计划模式放行（放行后由工具自身挂起等批准）；其余模式一律拦截。
    if (toolName === EXIT_PLAN_MODE_TOOL_NAME) {
      if (approvalMode !== "plan") {
        return {
          block: true,
          reason:
            "[Plan Mode] exit_plan_mode 只能在计划模式下使用：当前任务不在计划模式，无需提交计划。请直接执行任务。",
        };
      }
      return undefined;
    }

    // PreToolUse hooks（P2-G2，对齐 ZCode hook 语义）：deny/block 短路拦截；
    // approve 放行（跳过审批矩阵）；无裁决走正常流程。
    let hooksApprove = false;
    if (hooksWorkspaceRoot) {
      try {
        const { runWorkspaceHooks } = await import("../hooks/hooksRuntime");
        const hookOutcome = await runWorkspaceHooks(
          "PreToolUse",
          { toolName, payload: ctx.args },
          hooksWorkspaceRoot,
        );
        if (hookOutcome.blocked) {
          const contextSuffix =
            hookOutcome.additionalContexts.length > 0
              ? `\n${hookOutcome.additionalContexts.join("\n")}`
              : "";
          return {
            block: true,
            reason: `[Hook:PreToolUse] 已被工作区 hook 拦截：${hookOutcome.reason ?? "blocked"}${contextSuffix}`,
          };
        }
        hooksApprove = hookOutcome.approve === true;
      } catch (err) {
        // hook 执行器自身异常不阻断工具流（诊断在 runWorkspaceHooks 的 runs 里）
        console.warn("[hooks] PreToolUse runner failed (continuing):", err);
      }
    }
    if (hooksApprove) return undefined;

    // 工具级策略优先于模式默认（对齐 ZCode tool-policy broker 语义）
    const policy = toolPolicies?.[toolName];
    if (policy === "allow") return undefined;
    if (policy === "deny") {
      return {
        block: true,
        reason: `[Tool Policy] 工具 ${toolName} 已被工具级策略设置为 deny（拒绝）。请改用其它方案或与用户确认策略设置。`,
      };
    }
    // 显式 ask 策略：把该工具视作需要审批（即使模式本来会放行——edit 对 write、full 对一切），
    // 通过降级 effectiveMode 让下方统一审批路径接管
    const effectiveMode: ApprovalMode =
      policy === "ask" && (approvalMode === "edit" || approvalMode === "full") ? "ask" : approvalMode;

    if (kind === "read" || effectiveMode === "full") return undefined;
    if (effectiveMode === "plan") {
      return {
        block: true,
        reason:
          "[Plan Mode] 已拦截：当前任务处于计划模式，禁止写入/修改文件与执行命令。请继续只读调研并输出实施计划，不要重试该调用。",
      };
    }
    if (effectiveMode === "edit" && kind === "write") return undefined;
    if (approval.isAlwaysAllowed(toolName)) return undefined;

    // PermissionRequest hooks（P2-G2）：本将挂起审批前给 hook 一次裁决机会
    // （approve = 免审放行；block = 拒绝；无裁决走正常挂起）。
    if (hooksWorkspaceRoot) {
      try {
        const { runWorkspaceHooks } = await import("../hooks/hooksRuntime");
        const outcome = await runWorkspaceHooks(
          "PermissionRequest",
          { toolName, payload: { args: ctx.args } },
          hooksWorkspaceRoot,
        );
        if (outcome.blocked) {
          return { block: true, reason: `[Hook:PermissionRequest] ${outcome.reason ?? "denied by hook"}` };
        }
        if (outcome.approve) return undefined;
      } catch (err) {
        console.warn("[hooks] PermissionRequest runner failed (continuing):", err);
      }
    }

    // 挂起等待用户决策；abort 时以 reject 收场（钩子负责尊重 abort signal）。
    const decision = await new Promise<ApprovalDecision | Record<string, unknown>>((resolve) => {
      let settled = false;
      const settle = (value: ApprovalDecision | Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => settle("reject");
      signal?.addEventListener("abort", onAbort, { once: true });
      approval
        .request({ toolName, toolCallId: ctx.toolCall.id, args: ctx.args })
        .then((d) => settle(d))
        .catch((err) => {
          console.error("[approval] request failed:", err);
          settle("reject");
        });
    });

    if (decision === "reject") {
      return {
        block: true,
        reason: `[Approval] 用户拒绝了本次 ${toolName} 调用。不要重试同样的调用；请说明意图或改用其它方案继续。`,
      };
    }
    if (decision === "always") approval.allowAlways(toolName);
    // 结构化回答（ask_user_question 工具的挂起通道）：不是审批决策——放行该工具调用，
    // 回答对象由工具自身经 approval.request 的 resolve 值取回。
    if (typeof decision === "object" && decision !== null) return undefined;
    return undefined;
  };
}

export async function runAgentTurn(params: RunAgentTurnParams): Promise<RunTurnResult> {
  const {
    source,
    config,
    messages,
    systemPrompt,
    signal,
    onEvent,
    maxSteps,
    workspaceRoot,
    thinkingLevel,
    approvalMode = "full",
    approval,
    toolPolicies,
    checkpoint,
  } = params;

  const tools = getTools({
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(checkpoint ? { checkpoint } : {}),
  });
  // MCP 工具接入（对齐 LiveAgent：发送时枚举启用服务器的工具并注入工具循环；
  // 枚举失败的服务器如实跳过。整轮发送增加一次串行枚举，与 ZCode/LiveAgent 同语义）。
  let mcpTools: unknown[] = [];
  try {
    mcpTools = (await createMcpTools()) as unknown[];
  } catch (err) {
    console.warn("[mcp] tool enumeration failed (continuing without MCP):", err);
  }
  const allTools = [...tools, ...mcpTools] as typeof tools;
  // AskUserQuestion 工具（P1-3）：模型向用户提问，挂起等待提问卡作答。
  // 仅在有审批协调器时挂（协调器由池注入——Web 无后端场景不挂，工具不存在即不误调）。
  if (approval) {
    allTools.push(createAskUserQuestionTool({
      request: (req) => approval.request(req),
    }) as (typeof tools)[number]);
    // ExitPlanMode（P2 尾巴 #8）：计划模式提交实施计划挂起等批准；非计划模式由
    // 审批门直接拦截（mode.plan.exitOnly）。模式门优先于工具级策略（见 gate 顶部）。
    allTools.push(createExitPlanModeTool({
      request: (req) => approval.request(req),
    }) as (typeof tools)[number]);
  }

  // 记忆注入（对齐 LiveAgent）：`# Memory Index` 分桶索引 + `## Memory` 工具规则段，
  // 并挂载 MemoryManager 工具（list/read/search/write/update/delete/accept）。
  // 后端不可达（Web 模式）时注入为空段、工具调用如实报错（No-Fallback）。
  let memorySection = "";
  let memoryManagerTool: unknown = null;
  try {
    const [{ buildMemoryOverviewSection, buildMemoryToolsSuffixSection }, { createMemoryManagerTool }] =
      await Promise.all([
        import("../memory/prompts/injection"),
        import("../memory/memoryManagerTool"),
      ]);
    const overview = await buildMemoryOverviewSection(workspaceRoot || undefined);
    memorySection = overview ? `${overview}\n\n${buildMemoryToolsSuffixSection()}` : "";
    memoryManagerTool = createMemoryManagerTool({
      workdir: workspaceRoot || "",
      mode: "rw",
      actor: "tool",
    });
  } catch (err) {
    console.warn("[memory] index overview unavailable (continuing without memory):", err);
  }

  // 技能注入（对齐 LiveAgent）：`skill://` 路径协议 + 用户启用列表的渐进披露清单；
  // 总开关关闭或未选技能时为空段（与 LA skillsEnabled=false 清空同语义）。
  let skillsSection = "";
  try {
    const { useHubSettings } = await import("../../store/hubSettingsStore");
    const { enabled, selected } = useHubSettings.getState().settings.skills;
    if (enabled && selected.length > 0) {
      const skillsLib = await import("../skills/index");
      const discovery = await skillsLib.discoverSkills();
      // buildSkillsSystemPrompt 需要 SkillSummary 元数据（对齐 LA useSendChatTurn）：
      // 由选中名称解析为已发现技能对象，未命中的名称忽略。
      const selectedSkills = discovery.skills.filter((skill) => selected.includes(skill.name));
      skillsSection = skillsLib.buildSkillsSystemPrompt({
        rootDir: discovery.rootDir,
        selected: selectedSkills,
      });
    }
  } catch (err) {
    console.warn("[skills] discovery unavailable (continuing without skills):", err);
  }
  if (memoryManagerTool) {
    allTools.push(memoryManagerTool as (typeof tools)[number]);
  }
  const prompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;
  // 工作区根声明移入 Environment 段（- Working directory 行；避免重复出现两次）
  let effectiveSystemPrompt = prompt;
  const modelLabel =
    config && typeof config === "object" && config.provider && config.modelId
      ? `${config.provider}/${config.modelId}`
      : undefined;
  // 系统 OS 徽章 + 终端配置所选 shell 进 Environment 段（P2-G2 尾巴）
  let osBadge: string | undefined;
  let terminalShell: string | undefined;
  try {
    const [{ getOsInfo, formatOsBadge }, { getTerminalSettings }] = await Promise.all([
      import("../system/systemInfo"),
      import("../terminal/terminalSettings"),
    ]);
    osBadge = formatOsBadge(await getOsInfo()) || undefined;
    terminalShell = getTerminalSettings().shell || undefined;
  } catch (err) {
    console.warn("[env] system info unavailable (omitting from Environment):", err);
  }
  effectiveSystemPrompt += `\n\n${buildEnvironmentSection({
    modelLabel,
    osBadge,
    terminalShell,
    workspaceRoot,
  })}`;
  if (approvalMode === "plan") {
    effectiveSystemPrompt += PLAN_MODE_PROMPT;
  } else if (approvalMode !== "full") {
    effectiveSystemPrompt += APPROVAL_HINT_PROMPT;
  }
  // 记忆/技能不进系统提示词（ZCode 同款 meta_user 通道）：系统提示词保持静态，
  // 三者随 currentDate 包 <system-reminder> 并入首条 user 消息（见 base.messages）。
  // 工作区指令文件（AGENTS.md / CLAUDE.md，ZCode request-user-context 语义）：
  // 内容同样挂 meta_user；读取失败/不存在时如实跳过。
  let agentsMdSection = "";
  if (workspaceRoot) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const files = await invoke<
        { source: string; path: string; content: string; truncated: boolean }[]
      >("agents_md_read", { workspaceRoot });
      for (const file of files) {
        const truncMark = file.truncated
          ? "\n…[truncated: 指令文件超过 64KB，仅注入前 64KB]"
          : "";
        agentsMdSection += `<instruction-file source="${file.source}" path="${file.path}">\n${file.content}${truncMark}\n</instruction-file>\n\n`;
      }
      if (agentsMdSection.trim().length > 0) {
        agentsMdSection = `# Project instructions (from workspace instruction files — authoritative for this workspace)\n\n${agentsMdSection.trim()}`;
      }
    } catch (err) {
      console.warn("[agents-md] read failed (continuing without):", err);
    }
  }
  const metaUserBlock = buildMetaUserBlock({
    currentDate: `# currentDate\nToday's date is ${new Date().toDateString()}.`,
    agentsMdSection,
    memorySection,
    skillsSection,
  });
  const requestMessages = prependMetaUserBlock(messages, metaUserBlock);

  // SessionStart hooks（P2-G2）：回合启动时触发；additionalContext 追加进系统
  // 提示词尾部；blocked = 本轮拒绝启动（真实错误上抛，绝不静默放行）。
  if (workspaceRoot) {
    try {
      const { runWorkspaceHooks } = await import("../hooks/hooksRuntime");
      const outcome = await runWorkspaceHooks(
        "SessionStart",
        { payload: { workspaceRoot } },
        workspaceRoot,
      );
      if (outcome.blocked) {
        throw new Error(`[Hook:SessionStart] ${outcome.reason ?? "blocked by hook"}`);
      }
      if (outcome.additionalContexts.length > 0) {
        effectiveSystemPrompt += `\n\n[Hook:SessionStart]\n${outcome.additionalContexts.join("\n")}`;
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("[Hook:SessionStart]")) throw err;
      console.warn("[hooks] SessionStart runner failed (continuing):", err);
    }
  }

  // ---- 生命周期 hooks（对齐 LiveAgent Hooks：8 个生命周期事件）----
  // pi-agent-core 原生事件名与 hook 事件同名（agent_start/turn_start/message_*/
  // tool_execution_*/turn_end/agent_end），包装 onEvent 逐条 fire-and-forget：
  // 不 await、不阻塞 agent 主流程；block 协议不生效（观察性）。
  const lifecycleHookOnEvent = workspaceRoot
    ? (event: import("@earendil-works/pi-agent-core").AgentEvent) => {
        switch (event.type) {
          case "agent_start":
          case "agent_end":
          case "turn_start":
          case "turn_end":
          case "message_start":
          case "message_end":
          case "tool_execution_start":
          case "tool_execution_end": {
            // 负载裁剪：message 全文太肥，只给 stopReason + 文本预览（工具事件给全量 args）
            const payload =
              event.type === "tool_execution_start" || event.type === "tool_execution_end"
                ? {
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    args: "args" in event ? event.args : undefined,
                    isError: "isError" in event ? event.isError : undefined,
                  }
                : event.type === "message_start" || event.type === "message_end"
                  ? {
                      role: event.message.role,
                      stopReason: (event.message as { stopReason?: string }).stopReason,
                      textPreview: String(
                        (event.message as { content?: unknown }).content ?? "",
                      ).slice(0, 2000),
                    }
                  : "message" in event
                    ? { role: event.message.role }
                    : {};
            import("../hooks/hooksRuntime")
              .then(({ fireLifecycleHook }) => {
                fireLifecycleHook(event.type, { payload }, workspaceRoot);
              })
              .catch((err) => {
                console.warn("[hooks] lifecycle dispatch failed:", err);
              });
            break;
          }
        }
        return onEvent?.(event);
      }
    : onEvent;

  const base = {
    systemPrompt: effectiveSystemPrompt,
    messages: requestMessages,
    tools: allTools,
    maxSteps: maxSteps ?? DEFAULT_MAX_STEPS,
    signal,
    onEvent: lifecycleHookOnEvent,
    thinkingLevel,
    // provider 层自动重试（连接重置/5xx 等瞬时失败），对齐 ZCode 的重试策略
    maxRetries: 2,
    maxRetryDelayMs: 60000,
    // 审批门：非 full 模式（且有协调器）才注入；full 下零开销直通。
    // 工具级策略在 full 模式下依然生效（deny/allow 是显式用户意图，优先于模式）。
    // full 且无策略也要装门（P2-G2）：PreToolUse hooks 挂在门最前部，全模式都得跑；
    // 门内 read/full 早退保持 full 模式零审批语义。
    beforeToolCall:
      approval
        ? createApprovalGate(approvalMode, approval, toolPolicies, workspaceRoot)
        : undefined,
    // PostToolUse hooks（P2-G2）：工具执行后合并插件的 additionalContext 反馈
    // （append 到结果 content 末尾，模型下一轮能看到；不替换原结果）。
    afterToolCall:
      workspaceRoot
        ? async (ctx: import("@earendil-works/pi-agent-core").AfterToolCallContext) => {
            try {
              const { runWorkspaceHooks } = await import("../hooks/hooksRuntime");
              const resultText =
                ctx.result?.content
                  ?.filter((block: { type: string }): block is { type: "text"; text: string } => block.type === "text")
                  .map((block) => block.text)
                  .join("\n") ?? "";
              const outcome = await runWorkspaceHooks(
                "PostToolUse",
                { toolName: ctx.toolCall.name, payload: { args: ctx.args, resultText, isError: ctx.isError } },
                workspaceRoot,
              );
              if (outcome.additionalContexts.length === 0) return undefined;
              const feedback = outcome.additionalContexts.join("\n");
              const original = ctx.result?.content ?? [];
              return {
                content: [...original, { type: "text" as const, text: `\n[Hook:PostToolUse] ${feedback}` }],
                isError: ctx.isError,
                details: ctx.result?.details,
              };
            } catch (err) {
              console.warn("[hooks] PostToolUse runner failed (continuing):", err);
              return undefined;
            }
          }
        : undefined,
  };

  if (source === "faux") {
    const faux = await getFauxAgentSource();
    // 子代理工具（P1-6）：在 faux 分支同样注入（复用 faux model，测试可全链路验证）。
    // 定义驱动改造后为异步工厂（需加载子智能体目录渲染工具描述）。
    const subagentTool = await createSubagentTool({
      model: faux.model,
      stream: faux.stream,
      api: faux.api,
      label: faux.label,
      getApiKey: () => undefined,
      workspaceRoot,
      signal,
      thinkingLevel,
      registryTools: tools as unknown[],
      beforeToolCall: base.beforeToolCall,
    });
    const toolsWithAgent = [
      ...base.tools,
      createSubagentOutputTool(),
      subagentTool,
    ];
    return runTurn({
      model: faux.model,
      stream: faux.stream,
      api: faux.api,
      label: faux.label,
      ...base,
      tools: toolsWithAgent as typeof base.tools,
    });
  }

  const model = buildModel(config);
  const stream = await getStreamFnForApi(model.api);
  // 子代理工具（P1-6）：复用父轮 model/stream/api-key/审批门/AbortSignal；定义可钉选模型/工具覆盖。
  // 注册表工具集里没有 agent——子代理工具集经 filterToolsForDefinition 过滤，结构性禁递归。
  const subagentTool = await createSubagentTool({
    model,
    stream,
    api: model.api,
    label: model.provider || "openai-completions",
    getApiKey: () => config.apiKey.trim(),
    workspaceRoot,
    signal,
    thinkingLevel,
    registryTools: tools as unknown[],
    beforeToolCall: base.beforeToolCall,
  });
  const toolsWithAgent = [
    ...base.tools,
    createSubagentOutputTool(),
    subagentTool,
  ];

  return runTurn({
    model,
    stream,
    api: model.api,
    label: model.provider || "openai-completions",
    getApiKey: () => config.apiKey.trim(),
    ...base,
    tools: toolsWithAgent as typeof base.tools,
  });
}
