import test from "node:test";
import assert from "node:assert/strict";
import {
  CLAWHUB_CATEGORY_SLUGS,
  classifyClawHubSkill,
} from "./clawHubCategories.ts";

const skill = (slug, displayName, summary, topics) => ({ slug, displayName, summary, topics });

// ---- 分类启发式：每个非 other 分类至少 2 例 ----

test("integrations：api/mcp/webhook/notion 命中", () => {
  const a = classifyClawHubSkill(
    skill("notion-sync", "Notion Sync", "Two-way sync with the Notion API", ["notion"]),
  );
  assert.equal(a[0], "integrations");

  const b = classifyClawHubSkill(
    skill("mcp-webhook-bridge", "MCP Webhook Bridge", "Expose webhooks to MCP clients", [
      "mcp",
      "webhook",
    ]),
  );
  assert.deepEqual(b, ["integrations"]);
});

test("automation：cron/scheduled/workflow/daily 命中", () => {
  const a = classifyClawHubSkill(
    skill("cron-runner", "Cron Runner", "Run cron jobs and scheduled automation", ["cron"]),
  );
  assert.equal(a[0], "automation");

  const b = classifyClawHubSkill(
    skill("daily-digest", "Daily Digest", "Deliver a recurring workflow summary every morning", [
      "workflow",
    ]),
  );
  assert.deepEqual(b, ["automation"]);
});

test("research：arxiv/web search/scrape/papers 命中", () => {
  const a = classifyClawHubSkill(
    skill("arxiv-daily", "Arxiv Daily", "Fetch new papers from arxiv", ["arxiv"]),
  );
  assert.equal(a[0], "research");

  const b = classifyClawHubSkill(
    skill("web-search-pro", "Web Search Pro", "Search and scrape the live web", ["search"]),
  );
  assert.deepEqual(b, ["research"]);
});

test("development：python/debug/git pull request/lint/typescript 命中", () => {
  const a = classifyClawHubSkill(
    skill("python-debugger", "Python Debugger", "Debug python programs and run tests", ["python"]),
  );
  assert.equal(a[0], "development");

  const b = classifyClawHubSkill(
    skill(
      "pr-reviewer",
      "PR Reviewer",
      "Review git pull requests and lint typescript code",
      ["git"],
    ),
  );
  assert.deepEqual(b, ["development"]);
});

test("productivity：todo/tasks/notes/gtd/calendar 命中", () => {
  const a = classifyClawHubSkill(
    skill("todo-board", "Todo Board", "Manage tasks and notes in a markdown board", [
      "todo",
      "notes",
    ]),
  );
  assert.equal(a[0], "productivity");

  const b = classifyClawHubSkill(
    skill("gtd-planner", "GTD Planner", "Plan your week with a spreadsheet and calendar", ["gtd"]),
  );
  assert.deepEqual(b, ["productivity"]);
});

test("communication：email/gmail/inbox/slack 命中", () => {
  const a = classifyClawHubSkill(
    skill("gmail-triage", "Gmail Triage", "Triage your email inbox automatically", [
      "email",
      "gmail",
    ]),
  );
  assert.equal(a[0], "communication");

  const b = classifyClawHubSkill(
    skill("slack-notifier", "Slack Notifier", "Send messages and alerts to slack channels", [
      "slack",
    ]),
  );
  assert.equal(b[0], "communication");
});

test("creative：image/art/diffusion/music/audio 命中", () => {
  const a = classifyClawHubSkill(
    skill("image-studio", "Image Studio", "Generate images and art with diffusion models", [
      "image",
      "art",
    ]),
  );
  assert.equal(a[0], "creative");

  const b = classifyClawHubSkill(
    skill("song-writer", "Song Writer", "Write music and audio jingles", ["music"]),
  );
  assert.deepEqual(b, ["creative"]);
});

test("knowledge：memory/knowledge graph/rag/wiki 命中", () => {
  const a = classifyClawHubSkill(
    skill("second-brain", "Second Brain", "Personal knowledge graph with recall", [
      "memory",
      "knowledge",
    ]),
  );
  assert.equal(a[0], "knowledge");

  const b = classifyClawHubSkill(
    skill("rag-indexer", "RAG Indexer", "Embedding-based wiki retrieval", ["rag"]),
  );
  assert.deepEqual(b, ["knowledge"]);
});

test("agents：agent/autonomous/proactive/assistant 命中", () => {
  const a = classifyClawHubSkill(
    skill("autonomous-researcher", "Autonomous Researcher", "An autonomous research agent", [
      "agent",
      "autonomous",
    ]),
  );
  assert.equal(a[0], "agents");

  const b = classifyClawHubSkill(
    skill("proactive-assistant", "Proactive Assistant", "A proactive persona that plans ahead", [
      "assistant",
    ]),
  );
  assert.deepEqual(b, ["agents"]);
});

test("operations：docker/deploy/server/monitoring/uptime 命中", () => {
  const a = classifyClawHubSkill(
    skill("docker-ops", "Docker Ops", "Manage docker deployments and server logs", ["docker"]),
  );
  assert.equal(a[0], "operations");

  const b = classifyClawHubSkill(
    skill("uptime-watchdog", "Uptime Watchdog", "Monitor services and collect metrics", [
      "monitoring",
      "uptime",
    ]),
  );
  assert.deepEqual(b, ["operations"]);
});

test("security：security/passwords/secrets/pentest/audit 命中", () => {
  const a = classifyClawHubSkill(
    skill("vault-guard", "Vault Guard", "Store passwords and secrets with encryption", [
      "security",
    ]),
  );
  assert.equal(a[0], "security");

  const b = classifyClawHubSkill(
    skill("pentest-toolkit", "Pentest Toolkit", "Audit web apps for vulnerabilities and permissions", [
      "pentest",
    ]),
  );
  assert.deepEqual(b, ["security"]);
});

test("finance：finance/stocks/crypto/portfolio/budget/expenses 命中", () => {
  const a = classifyClawHubSkill(
    skill("stock-tracker", "Stock Tracker", "Track stocks and crypto portfolio value", ["finance"]),
  );
  assert.equal(a[0], "finance");

  const b = classifyClawHubSkill(
    skill("budget-buddy", "Budget Buddy", "Track expenses and split invoices", [
      "budget",
      "expenses",
    ]),
  );
  assert.deepEqual(b, ["finance"]);
});

test("lifestyle：cooking/recipes/weather/sleep/habits 命中", () => {
  const a = classifyClawHubSkill(
    skill("meal-planner", "Meal Planner", "Suggest recipes and track workouts", [
      "cooking",
      "recipes",
    ]),
  );
  assert.equal(a[0], "lifestyle");

  const b = classifyClawHubSkill(
    skill(
      "weather-outfit",
      "Weather Outfit",
      "Pick outfits from the weather forecast and your sleep habits",
      ["weather"],
    ),
  );
  assert.deepEqual(b, ["lifestyle"]);
});

// ---- other 回退 ----

test("全部未命中归入 other", () => {
  const a = classifyClawHubSkill(
    skill("quote-garden", "Quote Garden", "Random quote cards for your desk", ["quotes"]),
  );
  assert.deepEqual(a, ["other"]);

  const b = classifyClawHubSkill(skill("x", "X", "", []));
  assert.deepEqual(b, ["other"]);
});

// ---- 排序与截断 ----

test("topics 命中权重高于名称/摘要：security(3+1) 排在 operations(2) 前", () => {
  const result = classifyClawHubSkill(
    skill(
      "server-security-monitor",
      "Server Security Monitor",
      "Monitor server security posture",
      ["security"],
    ),
  );
  assert.deepEqual(result, ["security", "operations"]);
});

test("最多返回 3 个分类，同分按声明顺序稳定截断", () => {
  const result = classifyClawHubSkill(
    skill("kitchen-sink", "Kitchen Sink", "kitchen sink", ["api", "cron", "search", "code", "todo"]),
  );
  assert.equal(result.length, 3);
  assert.deepEqual(result, ["integrations", "automation", "research"]);
});

test("分类 slugs 表覆盖全部 14 个分区", () => {
  assert.equal(CLAWHUB_CATEGORY_SLUGS.length, 14);
  assert.ok(CLAWHUB_CATEGORY_SLUGS.includes("other"));
});
