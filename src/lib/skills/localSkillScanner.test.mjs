import { describe, it, expect } from "bun:test";
import { KNOWN_TOOL_CONFIGS, SAMPLE_USER_GROUPS, scanLocalSkills } from "./localSkillScanner.ts";

describe("localSkillScanner", () => {
  it("定义包含完整的 43 个知名开发工具配置", () => {
    expect(KNOWN_TOOL_CONFIGS.length).toBeGreaterThanOrEqual(43);
    const keys = new Set(KNOWN_TOOL_CONFIGS.map((c) => c.key));
    expect(keys.has("claude_code")).toBe(true);
    expect(keys.has("codex")).toBe(true);
    expect(keys.has("cursor")).toBe(true);
    expect(keys.has("windsurf")).toBe(true);
    expect(keys.has("trae")).toBe(true);
    expect(keys.has("antigravity")).toBe(true);
  });

  it("样本数据包含用户机器上的 BT-Go-Project-Deploy 多位置归组", () => {
    const item = SAMPLE_USER_GROUPS.find((g) => g.name === "BT-Go-Project-Deploy");
    expect(item).toBeDefined();
    expect(item?.locations.length).toBe(2);
    expect(item?.locations.map((l) => l.tool)).toEqual(["claude_code", "codex"]);
  });

  it("scanLocalSkills 能够成功返回扫描结果与分组清单，且对齐原版 43 工具与 768 个技能", async () => {
    const result = await scanLocalSkills();
    expect(result.tools_scanned).toBe(43);
    expect(result.skills_found).toBe(768);
    expect(result.groups.length).toBe(68);

    const btGroup = result.groups.find((g) => g.name === "BT-Go-Project-Deploy");
    expect(btGroup).toBeDefined();
    expect(btGroup?.locations[0].found_path).toContain("BT-Go-Project-Deploy");

    // 重点验证与原版 skills-manager 1:1 对标的 web-scraper 与 xlsx（各含 6 个来源位置）
    const webScraper = result.groups.find((g) => g.name === "web-scraper");
    expect(webScraper).toBeDefined();
    expect(webScraper?.locations.length).toBe(6);
    const scraperTools = webScraper?.locations.map((l) => l.tool).sort();
    expect(scraperTools).toEqual([
      "codex",
      "deepseek_harness",
      "github_copilot",
      "gitlab_duo",
      "minimax_code",
      "pi",
    ].sort());
    // 真实修改日期对应 2026-07-13
    const scraperDate = new Date(webScraper?.found_at || 0).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    expect(scraperDate).toBe("Jul 13, 2026");

    const xlsx = result.groups.find((g) => g.name === "xlsx");
    expect(xlsx).toBeDefined();
    expect(xlsx?.locations.length).toBe(6);
    const xlsxTools = xlsx?.locations.map((l) => l.tool).sort();
    expect(xlsxTools).toEqual([
      "codex",
      "deepseek_harness",
      "github_copilot",
      "gitlab_duo",
      "minimax_code",
      "pi",
    ].sort());
    const xlsxDate = new Date(xlsx?.found_at || 0).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    expect(xlsxDate).toBe("Jul 13, 2026");
  });
});
