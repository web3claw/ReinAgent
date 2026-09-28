/**
 * contextUsage.ts —— 上下文容量面板数据层（对齐 ZCode ChatContextUsage）。
 *
 * - 已用 token：来自 API 真实 usage（input + output），绝不估算替换；
 * - 上限：模型元数据声明的 contextWindow；
 * - 分类明细：本地字符估算（中文字符 ×2、其余 ×1，除以 3 向上取整，对齐 ZCode
 *   estimateTokens），UI 百分比按字符占比；估算口径诚实标注（confidence: low）。
 */

export interface ContextUsageCategory {
  key: string;
  labelKey: string;
  percent: number;
  /** 类别字符数（0 = 上下文中无此类内容，如实显示 0.0%） */
  chars?: number;
  /**
   * 懒构建该类别的真实内容文本（点击明细行在右侧面板查看）。
   * 无内容的类别不提供此字段 → 行不可点击。
   */
  buildContent?: () => string;
  /** 预览面板的语言标注（Shiki 高亮用） */
  language?: string;
}

export interface ContextUsageData {
  /** 真实 usage tokens（input + cacheRead + output，即上下文实际消耗） */
  used: number;
  /** 模型上下文窗口上限 */
  total: number;
  /** 已用百分比 */
  percent: number;
  /** 平均缓存命中率（≥78% 才由 UI 显示，对齐 ZCode 阈值） */
  hitRate?: number;
  categories: ContextUsageCategory[];
}

const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

/** 中文字符按 2 计、其余按 1 计（对齐 ZCode estimateTokens 的加权口径） */
export function weightedChars(text: string): number {
  let n = 0;
  for (const ch of text) {
    n += CJK_RE.test(ch) ? 2 : 1;
  }
  return n;
}

export function buildContextUsageData(params: {
  /** 最后一条 assistant 的真实 usage：input + output */
  used?: number;
  /** 当前模型声明的上下文窗口 */
  total?: number;
  /** 平均缓存命中率：cacheRead /（input + cacheRead），由调用方按真实 usage 计算 */
  hitRate?: number;
  /** 对话消息（text + thinking 均计入估算） */
  messages: { role: string; text: string; thinking?: string }[];
  /** 系统提示词全文 */
  systemPrompt: string;
  /** 系统工具 schema JSON 文本 */
  toolsJson: string;
  /** 本轮注入的技能段文本（buildSkillsSystemPrompt 产物；未启用/未选时为空） */
  skillsJson?: string;
  /** 本轮发送的 MCP 工具 schema JSON 文本（启用服务器枚举产物；不可得时为空） */
  mcpToolsJson?: string;
  /** meta_user 注入块文本（currentDate + 记忆索引；ZCode meta_user_context 口径） */
  metaUserJson?: string;
  /** 各类别的真实内容懒构建（点击明细行在右侧面板查看；无内容不传 → 行不可点击） */
  categoryContent?: Record<string, { buildContent: () => string; language?: string }>;
}): ContextUsageData | null {
  const used = Number(params.used ?? 0);
  const total = Number(params.total ?? 0);
  // No-Fallback：没有真实 usage 或未知容量时不渲染面板（对齐 ZCode getRenderableTaskUsage）
  if (!Number.isFinite(used) || used <= 0 || !Number.isFinite(total) || total <= 0) {
    return null;
  }

  let msgChars = 0;
  for (const m of params.messages) {
    msgChars += weightedChars((m.text ?? "") + (m.thinking ?? ""));
  }
  // 七类对齐 ZCode breakdown 明细（messages/system_prompt/meta_user_context/
  // skills/system_tool_schemas/mcp_tool_schemas）：技能/MCP/meta_user（currentDate+
  // 记忆索引）= 本轮实际注入/发送的真实内容，由调用方传入；不可得时如实计 0。
  // 排序：非零按占比降序，零值行固定在末尾。
  const rawCategories = [
    { key: "messages", labelKey: "contextUsageMessages", chars: msgChars },
    { key: "systemTools", labelKey: "contextUsageSystemTools", chars: weightedChars(params.toolsJson ?? "") },
    { key: "systemPrompt", labelKey: "contextUsageSystemPrompt", chars: weightedChars(params.systemPrompt ?? "") },
    { key: "skills", labelKey: "contextUsageSkills", chars: weightedChars(params.skillsJson ?? "") },
    { key: "mcpTools", labelKey: "contextUsageMcpTools", chars: weightedChars(params.mcpToolsJson ?? "") },
    { key: "metaUser", labelKey: "contextUsageOther", chars: weightedChars(params.metaUserJson ?? "") },
  ];

  const nonZero = rawCategories.filter((c) => c.chars > 0);
  const totalChars = nonZero.reduce((sum, c) => sum + c.chars, 0) || 1;
  const categories: ContextUsageCategory[] = rawCategories.map((c) => ({
    key: c.key,
    labelKey: c.labelKey,
    percent: c.chars > 0 ? Math.max(0.1, (c.chars / totalChars) * 100) : 0,
    chars: c.chars,
    ...(params.categoryContent?.[c.key] ?? {}),
  }));

  return {
    used,
    total,
    percent: Math.min(100, (used / total) * 100),
    hitRate: params.hitRate,
    categories,
  };
}

/** 紧凑 token 数字格式化：zh「70.5万」/ en「705K」（对齐 ZCode formatCompactTokenNumber） */
export function formatCompactTokens(n: number, locale: string = "zh-CN"): string {
  try {
    return new Intl.NumberFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(n);
  } catch {
    return String(n);
  }
}

/** 紧凑时长格式化：1h58m / 11m25s / 42s（对齐 LiveAgent 统计条风格） */
export function formatDurationCompact(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${sec}s`;
  return `${sec}s`;
}
