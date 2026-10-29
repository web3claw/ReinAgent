/**
 * skillsShClient.ts —— 对接 skills.sh 开放技能生态的客户端。
 * 支持获取 All-Time / Trending / Hot 榜单及实时搜索。
 * 出站请求走 proxiedFetch（遵守代理设置，跨端双模兼容）。
 */

import { proxiedFetch } from "../web/proxiedFetch.ts";

export interface SkillsShSkill {
  id: string;
  skill_id: string;
  name: string;
  source: string;
  installs: number;
}

export type LeaderboardKind = "alltime" | "trending" | "hot";

/** 从 HTML 中解析技能列表（支持 Next.js 内嵌数据与正则容错） */
export function parseSkillsFromHtml(html: string): SkillsShSkill[] {
  const seen = new Set<string>();
  const results: SkillsShSkill[] = [];

  // 1. 尝试匹配 __NEXT_DATA__
  try {
    const marker = '<script id="__NEXT_DATA__" type="application/json">';
    const startIdx = html.indexOf(marker);
    if (startIdx !== -1) {
      const endIdx = html.indexOf("</script>", startIdx + marker.length);
      if (endIdx !== -1) {
        const jsonStr = html.slice(startIdx + marker.length, endIdx);
        const data = JSON.parse(jsonStr);
        const list =
          data?.props?.pageProps?.initialSkills ||
          data?.props?.pageProps?.skills ||
          data?.props?.pageProps?.items;
        if (Array.isArray(list)) {
          for (const item of list) {
            const skill = normalizeRawSkill(item);
            if (skill && !seen.has(skill.id)) {
              seen.add(skill.id);
              results.push(skill);
            }
          }
          if (results.length > 0) return results;
        }
      }
    }
  } catch {
    // 忽略并回退到流式脚本或正则解析
  }

  // 2. 匹配 Next.js RSC 流式脚本与 JSON 中的技能对象（支持转义或未转义引号）
  // 匹配形如: \"source\":\"...\" ... \"skillId\":\"...\" ... \"installs\":123
  const pattern =
    /(?:\\)?["']source(?:\\)?["']\s*:\s*(?:\\)?["']([^"'\\\s]+)(?:\\)?["'][^{}]*?(?:\\)?["'](?:skillId|skill_id)(?:\\)?["']\s*:\s*(?:\\)?["']([^"'\\\s]+)(?:\\)?["'][^{}]*?(?:(?:\\)?["']name(?:\\)?["']\s*:\s*(?:\\)?["']([^"'\\\\]*)(?:\\)?["'][^{}]*?)?(?:\\)?["']installs(?:\\)?["']\s*:\s*(\d+)/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const source = match[1];
    const skillId = match[2];
    const name = match[3] || skillId;
    const installs = parseInt(match[4], 10) || 0;
    const id = `${source}/${skillId}`;
    if (!seen.has(id)) {
      seen.add(id);
      results.push({
        id,
        skill_id: skillId,
        name,
        source,
        installs,
      });
    }
  }

  // 3. 次级回退：宽松匹配
  if (results.length === 0) {
    const fallbackRegex =
      /\{(?=[^{}]*?"source"\s*:\s*"([^"\\]+)")(?=[^{}]*?"(?:skillId|skill_id)"\s*:\s*"([^"\\]+)")(?=[^{}]*?"installs"\s*:\s*(\d+))[^{}]*?\}/g;
    while ((match = fallbackRegex.exec(html)) !== null) {
      const source = match[1];
      const skillId = match[2];
      const installs = parseInt(match[3], 10) || 0;
      const id = `${source}/${skillId}`;
      if (!seen.has(id)) {
        seen.add(id);
        results.push({
          id,
          skill_id: skillId,
          name: skillId,
          source,
          installs,
        });
      }
    }
  }

  return results;
}

function normalizeRawSkill(item: Record<string, unknown>): SkillsShSkill | null {
  const source = String(item.source || "").trim();
  const skillId = String(item.skillId || item.skill_id || "").trim();
  if (!source || !skillId) return null;
  const name = String(item.name || skillId).trim() || skillId;
  const installs = typeof item.installs === "number" ? item.installs : parseInt(String(item.installs || 0), 10) || 0;
  return {
    id: `${source}/${skillId}`,
    skill_id: skillId,
    name,
    source,
    installs,
  };
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const WEB_MOCK_SKILLS: SkillsShSkill[] = [
  {
    id: "vercel-labs/skills/find-skills",
    skill_id: "find-skills",
    name: "find-skills",
    source: "vercel-labs/skills",
    installs: 4125000,
  },
  {
    id: "browserbase/stagehand/stagehand",
    skill_id: "stagehand",
    name: "stagehand",
    source: "browserbase/stagehand",
    installs: 1850000,
  },
  {
    id: "anthropics/anthropic-tools/web-search",
    skill_id: "web-search",
    name: "web-search",
    source: "anthropics/anthropic-tools",
    installs: 1420000,
  },
  {
    id: "google-gemini/gemini-tools/pdf-reader",
    skill_id: "pdf-reader",
    name: "pdf-reader",
    source: "google-gemini/gemini-tools",
    installs: 980000,
  },
  {
    id: "shadcn/ui-skills/component-designer",
    skill_id: "component-designer",
    name: "component-designer",
    source: "shadcn/ui-skills",
    installs: 890000,
  },
  {
    id: "tailwindlabs/tailwind-skills/v4-migrator",
    skill_id: "v4-migrator",
    name: "v4-migrator",
    source: "tailwindlabs/tailwind-skills",
    installs: 650000,
  },
  {
    id: "github/copilot-skills/git-workflow",
    skill_id: "git-workflow",
    name: "git-workflow",
    source: "github/copilot-skills",
    installs: 580000,
  },
  {
    id: "docker/docker-skills/containerize",
    skill_id: "containerize",
    name: "containerize",
    source: "docker/docker-skills",
    installs: 490000,
  },
  {
    id: "microsoft/autogen/agent-chat",
    skill_id: "agent-chat",
    name: "agent-chat",
    source: "microsoft/autogen",
    installs: 420000,
  },
  {
    id: "facebook/react-skills/react-compiler",
    skill_id: "react-compiler",
    name: "react-compiler",
    source: "facebook/react-skills",
    installs: 380000,
  },
  {
    id: "openai/skills/code-interpreter",
    skill_id: "code-interpreter",
    name: "code-interpreter",
    source: "openai/skills",
    installs: 360000,
  },
  {
    id: "nuxt/nuxt-skills/nitro-server",
    skill_id: "nitro-server",
    name: "nitro-server",
    source: "nuxt/nuxt-skills",
    installs: 290000,
  },
];

/** 获取 skills.sh 榜单列表 */
export async function fetchSkillsShLeaderboard(board: LeaderboardKind): Promise<SkillsShSkill[]> {
  const url =
    board === "trending"
      ? "https://skills.sh/trending"
      : board === "hot"
        ? "https://skills.sh/hot"
        : "https://skills.sh/";

  try {
    const response = await proxiedFetch(url, {
      headers: {
        "User-Agent": "ReinAgent-Skills/1.0",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!response.ok) {
      throw new Error(`获取 skills.sh 榜单失败 (HTTP ${response.status})`);
    }

    const html = await response.text();
    const skills = parseSkillsFromHtml(html);
    return skills;
  } catch (err) {
    if (!isTauri()) {
      return WEB_MOCK_SKILLS;
    }
    throw err;
  }
}

/** 实时搜索 skills.sh 市场 */
export async function searchSkillsSh(query: string, limit = 60): Promise<SkillsShSkill[]> {
  const q = query.trim();
  if (!q) return [];

  const url = `https://skills.sh/api/search?q=${encodeURIComponent(q)}&limit=${limit}`;
  try {
    const response = await proxiedFetch(url, {
      headers: {
        "User-Agent": "ReinAgent-Skills/1.0",
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`搜索 skills.sh 失败 (HTTP ${response.status})`);
    }

    const data = (await response.json()) as { skills?: unknown[] };
    const rawList = Array.isArray(data) ? data : Array.isArray(data?.skills) ? data.skills : [];
    const results: SkillsShSkill[] = [];
    const seen = new Set<string>();

    for (const item of rawList) {
      if (typeof item === "object" && item !== null) {
        const skill = normalizeRawSkill(item as Record<string, unknown>);
        if (skill && !seen.has(skill.id)) {
          seen.add(skill.id);
          results.push(skill);
        }
      }
    }

    return results;
  } catch (err) {
    if (!isTauri()) {
      const lower = q.toLowerCase();
      return WEB_MOCK_SKILLS.filter(
        (s) =>
          s.name.toLowerCase().includes(lower) ||
          s.skill_id.toLowerCase().includes(lower) ||
          s.source.toLowerCase().includes(lower)
      );
    }
    throw err;
  }
}
