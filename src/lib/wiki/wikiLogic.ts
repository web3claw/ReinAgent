/**
 * Wiki 生成纯逻辑（ROADMAP ⑨，零依赖 node --test 直测）：
 * 规划 JSON 三层容错解析（直接 parse → 剥围栏取大括号 → 正则抢救 → 兜底大纲）、
 * 输出清洗（粘连标题断行 / 元对话行过滤，围栏内不动，Hetu SanitizeWikiContent 同构）、
 * 截断判定（stopReason=length 或 ``` 围栏奇数）、prompt 组装。
 */

export const WIKI_MAX_PAGES = 16;
export const WIKI_MIN_PAGES = 8;
export const WIKI_MAX_CHAPTERS = 6;

export interface WikiPagePlan {
  /** 全套页序（0 = 总览页由编排层追加） */
  index: number;
  chapter: string;
  title: string;
  brief: string;
  /** 该页覆盖的真实目录 / 文件 / 模块名（按页检索上下文用） */
  covers: string[];
}

export interface WikiContextMaterial {
  baseContext: string;
  tree: string;
  sources: string;
  topLevelModules: string[];
  failure?: string | null;
}

// ===== 规划 JSON 解析（三层容错） =====

interface RawPlan {
  chapters?: unknown;
  pages?: unknown;
}

function coerceCovers(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim());
  if (typeof v === "string" && v.trim()) {
    // 字符串形态：逗号/顿号/空格拆分
    return v.split(/[,，、\s]+/).filter(Boolean);
  }
  return [];
}

function planFromObject(obj: RawPlan): WikiPagePlan[] {
  const plans: WikiPagePlan[] = [];
  let index = 0;
  const chapters = Array.isArray(obj.chapters) ? obj.chapters : obj.pages ? [{ pages: obj.pages }] : [];
  for (const ch of chapters) {
    if (typeof ch !== "object" || ch === null) continue;
    const rec = ch as Record<string, unknown>;
    const chapter = typeof rec.title === "string" ? rec.title.trim() : "";
    const pages = Array.isArray(rec.pages) ? rec.pages : [];
    for (const pg of pages) {
      if (typeof pg !== "object" || pg === null) continue;
      const p = pg as Record<string, unknown>;
      const title = typeof p.title === "string" ? p.title.trim() : "";
      if (!title) continue;
      plans.push({
        index: index++,
        chapter,
        title,
        brief: typeof p.brief === "string" ? p.brief.trim() : "",
        covers: coerceCovers(p.covers),
      });
    }
  }
  return plans;
}

/** 层三：正则抢救——模型输出破碎 JSON 时按 "title" 字段线性捞页 */
function salvagePlanByRegex(text: string): WikiPagePlan[] {
  const plans: WikiPagePlan[] = [];
  const seen = new Set<string>();
  const re = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    try {
      // 章节标题（后面紧跟 "pages"）不是页面，跳过
      if (/^\s*,\s*"pages"/.test(text.slice(m.index + m[0].length, m.index + m[0].length + 24))) continue;
      const title = JSON.parse(`"${m[1]}"`).trim();
      if (title && !seen.has(title) && title.length <= 60) {
        seen.add(title);
        plans.push({ index: plans.length, chapter: "", title, brief: "", covers: [] });
      }
    } catch {
      /* 转义失败跳过 */
    }
  }
  return plans;
}

/**
 * 解析规划输出。返回 null 表示彻底失败（调用方带原文重试或走兜底大纲）。
 * 页数收敛到 [WIKI_MIN_PAGES, WIKI_MAX_PAGES]（超出截断、不足不强行凑）。
 */
export function parseWikiPlan(raw: string): WikiPagePlan[] | null {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  let plans: WikiPagePlan[] = [];
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(body.slice(start, end + 1)) as RawPlan;
      plans = planFromObject(parsed);
    } catch {
      plans = [];
    }
  }
  if (plans.length === 0) plans = salvagePlanByRegex(body);
  // 总览页不在此列：纯导航/目录类标题剔除
  plans = plans.filter((p) => !/^(总览|overview|目录|table of contents)$/i.test(p.title));
  if (plans.length === 0) return null;
  return plans.slice(0, WIKI_MAX_PAGES).map((p, i) => ({ ...p, index: i }));
}

/** 兜底大纲：规划彻底失败时按顶层模块拆页（每模块一页，上限 6） */
export function fallbackPlanFromModules(modules: string[]): WikiPagePlan[] {
  const usable = modules.filter((m) => m && m !== "(root)").slice(0, 6);
  const list = usable.length > 0 ? usable : ["项目概览"];
  return list.map((title, i) => ({
    index: i,
    chapter: "",
    title: `${title} 模块解析`,
    brief: `围绕 ${title} 目录展开的模块说明。`,
    covers: [title],
  }));
}

// ===== 输出清洗（Hetu SanitizeWikiContent 同构） =====

/** 粘连标题：「…。## 小节」一行内句子+标题 → 标点后断行 */
const GLUED_HEADING = /([。！？；：.!?:;])\s*(#{1,6}\s)/g;
/** 行首元对话开场白 */
const META_LINE = /^(?:好的?[，,、。]|嗯[，,、。]|好吧[，,。]|OK[，,。.!]|Alright[，,.]|Sure[，,.]|Let me |Now I|I'll |I will |I need to|稍等[，,]|抱歉[，,])/;
/** 输出过程说明短语 */
const META_PHRASE = /现在整理成最终|整理成最终的?\s*[Mm]arkdown|^现在(?:我|我们)?(?:来|将|开始)?\s*(?:整理|生成|编写|输出)(?:成)?|^以下是最终|^确保格式(?:正确|无误|完整)[。.!]?\s*$/;

/**
 * 清洗模型输出：围栏感知——代码块内不做任何处理；围栏外粘连标题断行 +
 * 丢弃元对话行（保守：仅当行内无 Markdown 结构符号时）+ 去首尾空行。
 */
export function sanitizeWikiContent(content: string): string {
  if (!content?.trim()) return content;
  const kept: string[] = [];
  let inFence = false;
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (t.startsWith("```")) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    if (inFence) {
      kept.push(line);
      continue;
    }
    const outLine = line.replace(GLUED_HEADING, "$1\n$2");
    for (const seg of outLine.split("\n")) {
      const s = seg.trim();
      const meta =
        s.length > 0 &&
        (META_LINE.test(s) || META_PHRASE.test(s)) &&
        !s.includes("`") && !s.includes("**") && !s.includes("](") &&
        !s.startsWith("#") && !s.startsWith("-") && !s.startsWith("*") &&
        !s.startsWith("|") && !s.startsWith(">") && !/[0-9]/.test(s[0]);
      if (!meta) kept.push(seg);
    }
  }
  let i = 0;
  while (i < kept.length && !kept[i].trim()) i++;
  let j = kept.length;
  while (j > i && !kept[j - 1].trim()) j--;
  return kept.slice(i, j).join("\n");
}

// ===== 截断判定 =====

/**
 * 是否需要续写：显式 length 截断，或 ``` 围栏计数为奇（停在代码块内）。
 * Hetu CountFences + BuildContinuePrompt 语义。
 */
export function needsContinuation(stopReason: string, content: string): boolean {
  if (stopReason === "length") return true;
  return (content.match(/```/g) ?? []).length % 2 === 1;
}

// ===== Prompt 组装 =====

export const WIKI_ARCHITECT_SYSTEM_PROMPT = "你是软件项目文档架构师。只输出 JSON，不要输出其他内容。";
export const WIKI_PAGE_SYSTEM_PROMPT =
  "你是深度技术文档作者。基于提供的项目资料撰写 Wiki 页面，直接输出 Markdown 正文，不要包含任何解释、过渡语或对话性文字。";
export const WIKI_OVERVIEW_SYSTEM_PROMPT = WIKI_PAGE_SYSTEM_PROMPT;

function contextBlock(material: WikiContextMaterial): string {
  const parts: string[] = [];
  if (material.baseContext.trim()) parts.push(`【项目文档】\n${material.baseContext.trim()}`);
  if (material.tree.trim()) parts.push(`【目录结构】\n${material.tree.trim()}`);
  if (material.sources.trim()) parts.push(`【源码采样】\n${material.sources.trim()}`);
  return parts.join("\n\n");
}

/** 规划 prompt（Hetu PlanModulePagesAsync 同构） */
export function buildPlanPrompt(projectName: string, material: WikiContextMaterial): string {
  const jsonSpec = `{
  "chapters": [
    {"title": "章节标题", "pages": [
      {"title": "页面标题", "brief": "该页要讲清什么（一句话）", "covers": ["覆盖的目录/文件/模块名"]}
    ]}
  ]
}`;
  return `项目名称：${projectName}

【项目资料】
${contextBlock(material)}

请为该项目规划一套 Wiki 文档的章节与页面（DeepWiki 风格，父子级结构：章节为父级、页面为子级；总览页单独生成，不在此列）。
规划要求：
1. 按项目的真实结构划分 3-${WIKI_MAX_CHAPTERS} 个章节，总页面数 ${WIKI_MIN_PAGES}-${WIKI_MAX_PAGES} 个；
2. 一页只讲一个模块 / 一个领域 / 一个关注点，不要把多个不相关的模块塞进同一页；
3. 页面标题要具体（写清模块名，如「命令执行与工作树」），不要用「核心模块详解」「系统设计」这类大而空的标题；
4. covers 写该页覆盖的真实目录 / 文件 / 模块名，用于按页定位上下文，务必来自上面的资料；
5. 只输出 JSON，不要输出其他内容，格式如下：
${jsonSpec}`;
}

/** 规划修复 prompt（解析失败时带原文重试一次） */
export function buildPlanRepairPrompt(rawReply: string): string {
  const jsonSpec = `{"chapters":[{"title":"章节标题","pages":[{"title":"页面标题","brief":"该页要讲清什么","covers":["覆盖的目录/文件/模块名"]}]}]}`;
  return `上一次回复无法解析为 JSON。下面是你上次的回复，请严格按给定格式重新输出，只输出 JSON，不要任何解释文字。
格式：${jsonSpec}

【上次的回复】
${rawReply}`;
}

/** 页面 prompt：全量资料 + 该页 covers 命中的上下文 + 手风约束 */
export function buildPagePrompt(input: {
  projectName: string;
  plan: WikiPagePlan;
  siblingTitles: string[];
  material: WikiContextMaterial;
  coveredContext?: string;
}): string {
  const nav = input.siblingTitles.map((t) => `- ${t}`).join("\n");
  return `项目名称：${input.projectName}

【本页主题】
标题：${input.plan.title}
章节：${input.plan.chapter || "（无）"}
要点：${input.plan.brief || "（无）"}
覆盖范围：${input.plan.covers.join("、") || "（未指定）"}

【全套页面导航】（避免与其他页重复，可在文末「相关页面」一节引用）
${nav}

【项目资料】
${contextBlock(input.material)}
${input.coveredContext?.trim() ? `\n【本页覆盖范围的补充上下文】\n${input.coveredContext.trim()}` : ""}

写作要求：
1. 直接输出 Markdown 正文（不要输出页面大标题，从二级标题开始）；
2. 立足上面资料中的真实内容展开，不要编造资料里不存在的模块或接口；
3. 涉及结构、流程或模块关系时，用 \`\`\`mermaid 代码块绘制相应图表，仅限 mermaid 支持的图类型（graph / flowchart / sequenceDiagram / classDiagram / stateDiagram / erDiagram / pie / gantt）；目录结构、文件树用 \`\`\`text 代码块表示，不要用 mermaid；
4. 篇幅 800-2000 字，讲透本页主题即可。`;
}

/** 总览页 prompt：强制 mermaid 架构图 + 页面导航 */
export function buildOverviewPrompt(input: {
  projectName: string;
  material: WikiContextMaterial;
  generatedPages: { chapter: string; title: string; brief: string }[];
}): string {
  const nav = input.generatedPages
    .map((p) => (p.chapter ? `- ${p.chapter}\n  - ${p.title}` : `- ${p.title}`))
    .join("\n");
  return `项目名称：${input.projectName}

【项目资料】
${contextBlock(input.material)}

【本套 Wiki 已生成的页面】
${nav}

请为该项目撰写 Wiki 总览页（DeepWiki 风格），直接输出 Markdown 正文：
1. 开篇一段话概述项目定位与核心能力；
2. 「总体架构」一节必须包含一个 \`\`\`mermaid 代码块绘制的架构图（graph 或 flowchart），清晰表达主要组件及其关系；
3. 「文档导航」一节按上面的页面清单列出全部页面的链接式目录（用无序列表，不要真的造链接地址）；
4. 立足资料中的真实内容，不要编造。`;
}

/** 续写 prompt（completeOneShotText 内建续写用的同款语义，保留导出供单测） */
export function buildContinuePrompt(existing: string): string {
  return `以下是一篇文档已生成的内容，输出在末尾被截断（可能停在句子中途或未闭合的代码块内）。
请从截断处继续输出剩余内容：不要重复已有内容，不要输出解释或过渡语（例如「好的，继续」），保持原有格式续写下去。
若停在代码块内，请先补全该代码块（含收尾的 \`\`\`）。

【已有内容】
${existing}`;
}
