/**
 * slashCommands.ts —— 斜杠命令纯逻辑（对齐 ZCode svc/commands 与 slashCommandHelpers）。
 *
 * 两类命令：
 * - **内置**：宿主实现的能力（`/clear` 清空当前任务时间线、`/compact` 手动压缩、
 *   `/help` 帮助），由 Composer/App 层执行；
 * - **自定义**：扫描 `<工作区>/.ReinAgent/commands/*.md`，frontmatter 提供
 *   `name` / `description`，正文为提示词模板（支持 `$ARGUMENTS` 占位）——
 *   选中后**填进输入框**（不直接发送，用户可编辑）。
 *
 * 本模块只做纯逻辑（解析/匹配/模板展开），扫描走 Rust 命令、UI 由 Composer 承担。
 */

export interface SlashCommand {
  /** 触发名（不含前导斜杠），如 `compact`、`review`、`find-skills` */
  name: string;
  /** UI 展示名（自定义命令可用 frontmatter.name；内置为中文/英文短名） */
  label: string;
  description: string;
  /** builtin = 宿主执行；custom = 填入提示词模板；skill = 启用的技能；mcp = 启用的 MCP 工具 */
  kind: "builtin" | "custom" | "skill" | "mcp";
  /** 自定义命令的模板正文（含 `$ARGUMENTS` 占位） */
  body?: string;
  /** 图标标识符或类型 */
  icon?: string;
  /** 所属分组或来源（如 MCP 服务的展示名） */
  sourceLabel?: string;
  /** 离线状态（如 MCP 服务连接失败或未就绪时为 true） */
  offline?: boolean;
}

/** 内置命令清单（宿主实现；不含 UI 文案以外的可执行细节）。 */
export const BUILTIN_COMMANDS: SlashCommand[] = [
  {
    name: "plan",
    label: "plan",
    description: "切换到计划模式：只读调研，提交计划获批后再执行（可附带首个任务）",
    kind: "builtin",
    icon: "plan",
  },
  {
    name: "goal",
    label: "goal",
    description: "查看或管理会话目标：/goal <目标> 设定，pause/resume/clear 管理",
    kind: "builtin",
    icon: "goal",
  },
  {
    name: "compact",
    label: "compact",
    description: "压缩上下文：把较早的轮次交给摘要模型生成摘要",
    kind: "builtin",
    icon: "compact",
  },
  {
    name: "compress",
    label: "compress",
    description: "压缩上下文：把较早的轮次交给摘要模型生成摘要（/compact 别名）",
    kind: "builtin",
    icon: "compact",
  },
  {
    name: "init",
    label: "init",
    description: "创建或更新工作区的 AGENTS.md 项目说明（供后续会话注入，可选备注）",
    kind: "builtin",
    icon: "init",
  },
  {
    name: "clear",
    label: "clear",
    description: "清空当前任务的对话时间线（不可撤销，需二次确认）",
    kind: "builtin",
    icon: "clear",
  },
  {
    name: "help",
    label: "help",
    description: "显示可用命令与用法",
    kind: "builtin",
    icon: "help",
  },
];

/**
 * 解析 `/` 菜单的查询词。
 * 命中条件：文本以 `/` 开头且**尚未出现空格**（即仍在输入命令名）。
 * @returns 查询词（不含 `/`）；不处于命令输入态时返回 null
 */
export function parseSlashQuery(text: string): string | null {
  const match = /^\/([^\s/]*)$/.exec(text);
  return match ? match[1] : null;
}

/** 按查询词过滤命令（名称前缀优先，其次名称包含、描述包含）。 */
export function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  const prefix: SlashCommand[] = [];
  const rest: SlashCommand[] = [];
  for (const cmd of commands) {
    const name = cmd.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(cmd);
    else if (name.includes(q) || cmd.description.toLowerCase().includes(q)) rest.push(cmd);
  }
  return [...prefix, ...rest];
}

/**
 * 把「整条输入」解析为内置命令调用（用于**回车提交时**执行命令）。
 *
 * 交互模型（2026-10-05 用户定稿）：`/` 菜单选中只是把 `/name ` 填进输入框
 * （见 Composer 的 selectSlashCommand），**不直接执行**；真正的执行发生在用户按回车
 * 提交时——由本函数判定。因此这里必须精确匹配：
 * - 命中：整串就是 `/name`（name ∈ BUILTIN_COMMANDS）或 `/name 参数…`；
 * - 不命中一律返回 null（交回普通发送）：`/foo`（未注册）、`/home/user/file` 这类路径、
 *   或带前缀的普通文本——绝不因为"以 / 开头"就吞掉用户内容。
 */
export function matchBuiltinCommand(
  text: string,
): { command: SlashCommand; args: string } | null {
  const match = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const name = match[1].toLowerCase();
  const command = BUILTIN_COMMANDS.find((cmd) => cmd.name.toLowerCase() === name);
  return command ? { command, args: match[2] ?? "" } : null;
}

/**
 * 展开自定义命令模板：把 `$ARGUMENTS` 替换为参数串（ZCode 同款占位语义）。
 * - 无占位符时：参数非空则把参数追加为末行（否则命令参数会被静默丢弃）；
 * - 无参数且无占位符：原样返回模板。
 */
export function expandCommandTemplate(body: string, args: string): string {
  const template = typeof body === "string" ? body : "";
  const trimmedArgs = args.trim();
  if (template.includes("$ARGUMENTS")) {
    return template.split("$ARGUMENTS").join(trimmedArgs);
  }
  if (trimmedArgs.length === 0) return template;
  return `${template.trimEnd()}\n\n${trimmedArgs}`;
}

/**
 * 从 Rust 扫描结果构造自定义命令（防御性解析：脏数据不崩、无 name 的条目丢弃）。
 * frontmatter 由 Rust 侧解析为字段，这里只做形状归一。
 */
export function toCustomCommands(
  entries: Array<{ name?: unknown; description?: unknown; body?: unknown }>,
): SlashCommand[] {
  const out: SlashCommand[] = [];
  for (const entry of entries ?? []) {
    const name = typeof entry?.name === "string" ? entry.name.trim().replace(/^\/+/, "") : "";
    if (!name || /\s/.test(name)) continue; // 名称不得含空白（否则菜单无法触发）
    out.push({
      name,
      label: name,
      description:
        typeof entry.description === "string" && entry.description.trim().length > 0
          ? entry.description.trim()
          : "自定义命令",
      kind: "custom",
      icon: "custom",
      body: typeof entry.body === "string" ? entry.body : "",
    });
  }
  return out;
}

/**
 * 把已启用的技能条目转换为斜杠命令（kind = "skill"）。
 * 选中后填入 `/{skill.name} `。
 */
export function toSkillCommands(
  skills: Array<{ name?: unknown; description?: unknown }>,
): SlashCommand[] {
  const out: SlashCommand[] = [];
  const seen = new Set<string>();
  for (const skill of skills ?? []) {
    const name = typeof skill?.name === "string" ? skill.name.trim().replace(/^\/+/, "") : "";
    if (!name || /\s/.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      label: name,
      description:
        typeof skill.description === "string" && skill.description.trim().length > 0
          ? skill.description.trim()
          : "已启用的技能",
      kind: "skill",
      icon: "skill",
    });
  }
  return out;
}

/**
 * 把已启用的 MCP 工具条目转换为斜杠命令（kind = "mcp"）。
 * 选中后填入 `/{tool.name} `。
 */
export function toMcpCommands(
  tools: Array<{ serverId?: unknown; serverLabel?: unknown; name?: unknown; description?: unknown }>,
): SlashCommand[] {
  const out: SlashCommand[] = [];
  const seen = new Set<string>();
  for (const tool of tools ?? []) {
    const name = typeof tool?.name === "string" ? tool.name.trim().replace(/^\/+/, "") : "";
    if (!name || /\s/.test(name) || seen.has(name)) continue;
    seen.add(name);
    const serverLabel =
      typeof tool.serverLabel === "string" && tool.serverLabel.trim()
        ? tool.serverLabel.trim()
        : typeof tool.serverId === "string" && tool.serverId.trim()
          ? tool.serverId.trim()
          : "MCP";
    out.push({
      name,
      label: name,
      description:
        typeof tool.description === "string" && tool.description.trim().length > 0
          ? tool.description.trim()
          : `MCP 工具 (${serverLabel})`,
      kind: "mcp",
      icon: "mcp",
      sourceLabel: serverLabel,
    });
  }
  return out;
}

/**
 * 为离线或启动失败的 MCP 服务生成保底命令条目（kind = "mcp"，offline = true）。
 * 保证外部挂载路径不存在或服务异常时在斜杠菜单中明确可见，绝不静默吞掉（对齐 Fail-Fast 铁律）。
 */
export function toMcpFallbackCommands(
  servers: Array<{ id?: unknown; description?: unknown }>,
  serverErrors?: Record<string, string> | string,
): SlashCommand[] {
  const out: SlashCommand[] = [];
  const seen = new Set<string>();
  const defaultError = typeof serverErrors === "string" ? serverErrors.trim() : "";

  for (const s of servers ?? []) {
    const id = typeof s?.id === "string" ? s.id.trim().replace(/^\/+/, "") : "";
    if (!id || /\s/.test(id) || seen.has(id)) continue;
    seen.add(id);

    let reason = "";
    if (typeof serverErrors === "object" && serverErrors !== null && typeof serverErrors[id] === "string") {
      reason = serverErrors[id].trim();
    } else if (defaultError) {
      const match = defaultError.split("\n").find((line) => line.includes(id));
      if (match) {
        reason = match.replace(new RegExp(`^${id}:\\s*`, "i"), "").trim();
      } else {
        const firstLine = defaultError.split("\n")[0] || defaultError;
        reason = firstLine.trim();
      }
    }

    const desc = reason
      ? `[离线/连接失败: ${reason.slice(0, 100)}]`
      : typeof s.description === "string" && s.description.trim()
      ? `[离线] ${s.description.trim()}`
      : "[服务离线或未提供可用工具]";

    out.push({
      name: id,
      label: id,
      description: desc,
      kind: "mcp",
      icon: "mcp",
      sourceLabel: id,
      offline: true,
    });
  }
  return out;
}

