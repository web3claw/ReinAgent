/**
 * Wake fixtures 回归测试（2026-10-06 批次 1）：用 Wake 上游验证过的真实形态
 * 样本（MIT，tests/fixtures 原样拷贝）钉死我们 importers 的解析行为。
 * 样本来自 Wake 仓库 crates/wake-core/tests/fixtures/{claude,codex,pi}。
 * 运行：node --test src/lib/import/importFixtures.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const {
  createClaudeImporter,
  createCodexImporter,
  createPiImporter,
  createOmpImporter,
  createKiroImporter,
  createQoderImporter,
  createKimiImporter,
  createCodebuddyImporter,
  createWorkbuddyImporter,
  createGeminiImporter,
  createGrokImporter,
  createCraftImporter,
} = await import("./importers.ts");

const FIXTURES_ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "home");

/** 真实文件系统 ImportFs：根固定在 fixtures/home，剥掉 HOME 前缀后按相对路径读。 */
function fixtureFs(home) {
  const prefix = home.endsWith("/") ? home : `${home}/`;
  const rel = (path) => (path.startsWith(prefix) ? path.slice(prefix.length) : path);
  return {
    async readText(path) {
      try {
        return readFileSync(join(FIXTURES_ROOT, rel(path)), "utf8");
      } catch {
        return null;
      }
    },
    async listDir(path) {
      const { readdirSync } = await import("node:fs");
      try {
        // 契约：返回全部条目（文件+目录），不过滤——importer 自行按扩展名取舍。
        return readdirSync(join(FIXTURES_ROOT, rel(path)));
      } catch {
        return [];
      }
    },
    async readEnds(path, headLen, tailLen) {
      let full;
      try {
        full = readFileSync(join(FIXTURES_ROOT, rel(path)), "utf8");
      } catch {
        return null;
      }
      const total = full.length;
      let head = full.slice(0, Math.min(headLen, total));
      if (head.length < total) {
        const cut = head.lastIndexOf("\n");
        head = cut >= 0 ? head.slice(0, cut + 1) : "";
      }
      let tail = total > head.length ? full.slice(Math.max(0, total - tailLen)) : "";
      if (total - tail.length > 0) {
        const idx = tail.indexOf("\n");
        tail = idx >= 0 ? tail.slice(idx + 1) : "";
      }
      return { head, tail, totalBytes: total, mtimeMs: 1700000000000 };
    },
    async readRange(path, offset, length) {
      try {
        return readFileSync(join(FIXTURES_ROOT, rel(path)), "utf8").slice(offset, offset + length);
      } catch {
        return null;
      }
    },
  };
}

const HOME = "/home/tester";
const fs = fixtureFs(HOME);

// ==================== Claude Code ====================

const CLAUDE_PROJECT = "claude/projects/-Users-tester-Github-wakefx";
const CLAUDE_MAIN = `${CLAUDE_PROJECT}/11111111-aaaa-bbbb-cccc-000000000001.jsonl`;
const CLAUDE_IMAGES = `${CLAUDE_PROJECT}/44444444-aaaa-bbbb-cccc-000000000004.jsonl`;

test("Claude fixture：custom-title 是最高标题优先级；isMeta 行不进标题", async () => {
  const importer = createClaudeImporter(fs, HOME);
  const summaries = await importer.scan();
  const main = summaries.find((s) => s.externalId === "11111111-aaaa-bbbb-cccc-000000000001");
  assert.ok(main, "主 fixture 应被 scan 发现");
  // Wake 语义：custom-title > 首条真人用户文本；summary 行只是跳过类型不做标题
  assert.equal(main.title, "QR login revamp");
  assert.equal(main.projectPath, "/Users/tester/Github/wakefx");
});

test("Claude fixture：isMeta/caveat 行、sidechain、compact、未知类型不进消息流", async () => {
  const importer = createClaudeImporter(fs, HOME);
  const summaries = await importer.scan();
  const summary = summaries.find((s) => s.externalId === "11111111-aaaa-bbbb-cccc-000000000001");
  assert.ok(summary, "主 fixture 应被 scan 发现");
  const { messages } = await importer.convert(summary);
  const roles = messages.map((m) => m.role);
  // 12 行样本 → 应只余 真人user / assistant(text) / tool(配对) / assistant(text)
  assert.deepEqual(roles, ["user", "assistant", "tool", "assistant"]);
  assert.match(messages[0].content, /二维码扫描登录/);
  assert.equal(messages[1].content, "好的,我先查看现有代码。");
  assert.equal(messages[2].toolName, "Read");
  assert.equal(messages[2].toolCallId, "toolu_01");
  assert.match(messages[3].content, /已完成/);
});

test("Claude fixture：纯图片用户行跳过（文本导入形态），文本块照常提取", async () => {
  const importer = createClaudeImporter(fs, HOME);
  const summaries = await importer.scan();
  const imageSession = summaries.find((s) => s.externalId === "44444444-aaaa-bbbb-cccc-000000000004");
  assert.ok(imageSession, "图片 fixture 应被发现");
  const { messages } = await importer.convert(imageSession);
  // 5 行 = 4 条 user（1 文本+3 纯图片）+ 1 assistant → 只余 user(带文本) + assistant
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"]);
});

// ==================== Pi ====================

test("Pi fixture：session header + message 条目照常解析", async () => {
  const importer = createPiImporter(fs, HOME);
  const summaries = await importer.scan();
  assert.ok(summaries.length > 0, "pi fixture 应被 scan 发现");
  const first = summaries[0];
  assert.equal(first.source, "pi");
  assert.ok(first.title.length > 0);
  assert.ok(first.messageCount > 0);
  const { messages } = await importer.convert(first);
  assert.ok(messages.length > 0);
  assert.ok(messages.some((m) => m.role === "user"));
});

// ==================== Codex ====================

test("Codex fixture：新旧格式混合归档扫描与解析", async () => {
  const importer = createCodexImporter(fs, HOME);
  const summaries = await importer.scan();
  assert.ok(summaries.length > 0, "codex fixtures 应被 scan 发现");
  for (const summary of summaries) {
    const { messages } = await importer.convert(summary);
    assert.ok(messages.length > 0, `${summary.externalId} 应解析出消息`);
    assert.ok(messages.some((m) => m.role === "user" || m.role === "assistant"));
  }
});

// ==================== Omp（Pi 变体）====================

test("Omp fixture：pi 同构格式、独立数据根", async () => {
  const importer = createOmpImporter(fs, HOME);
  const summaries = await importer.scan();
  assert.ok(summaries.length > 0, "omp fixture 应被 scan 发现");
  assert.equal(summaries[0].source, "omp");
  const { messages } = await importer.convert(summaries[0]);
  assert.ok(messages.length > 0);
  assert.ok(messages.some((m) => m.role === "user"));
});

// ==================== Kiro ====================

test("Kiro fixture：边车标题/模型 + Prompt/AssistantMessage 行解析", async () => {
  const importer = createKiroImporter(fs, HOME);
  const summaries = await importer.scan();
  const s = summaries.find((x) => x.externalId === "44444444-aaaa-bbbb-cccc-000000000004");
  assert.ok(s, "kiro fixture 应被 scan 发现");
  assert.equal(s.title, "Kiro QR session");
  assert.equal(s.projectPath, "/Users/tester/Github/wakefx");
  assert.equal(s.model, "claude-sonnet-4");
  const { messages } = await importer.convert(s);
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"]);
  assert.match(messages[0].content, /用 Kiro 重构二维码扫描/);
  assert.equal(messages[1].content, "已拆分扫描组件并补上清理逻辑。");
});

// ==================== Qoder ====================

test("Qoder fixture：active 分支解析、弃用分支与元数据行剔除、custom-title 优先", async () => {
  const importer = createQoderImporter(fs, HOME);
  const summaries = await importer.scan();
  const s = summaries.find((x) => x.externalId === "abababab-aaaa-bbbb-cccc-000000000014");
  assert.ok(s, "qoder 主 fixture 应被 scan 发现");
  // custom-title > ai-title
  assert.equal(s.title, "Qoder active branch title");
  assert.equal(s.model, "qoder-performance");
  const { messages } = await importer.convert(s);
  // 主链：isMeta 根(跳过) + user + assistant(工具调用分片,无文本) + assistant(text)
  //       + tool_result + attachment(跳过) + user + assistant；弃用分支不进
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "assistant", "tool", "user", "assistant"],
  );
  // active-leaf 显式 null = 已回退空会话：不出现在 scan（无消息可导）
  assert.ok(!summaries.some((x) => x.externalId === "cdcdcdcd-aaaa-bbbb-cccc-000000000015"));
});

// ==================== CodeBuddy / WorkBuddy ====================

test("CodeBuddy fixture：OpenAI Responses 行形、callId 配对、标题优先级与占位符", async () => {
  const importer = createCodebuddyImporter(fs, HOME);
  const summaries = await importer.scan();
  const s = summaries.find((x) => x.externalId === "cb000001-aaaa-bbbb-cccc-000000000001");
  assert.ok(s, "codebuddy fixture 应被 scan 发现");
  // custom-title > ai-title（占位 "(No content)" 不采信，last-wins 的 "Generated later" 被压过）
  assert.equal(s.title, "QR effect cleanup");
  assert.equal(s.projectPath, "/Users/fixture/src/wakefx");
  const { messages } = await importer.convert(s);
  const roles = messages.map((m) => m.role);
  // user, assistant, tool(Read), tool(Bash failed), assistant, user, assistant
  assert.deepEqual(roles, ["user", "assistant", "tool", "tool", "assistant", "user", "assistant"]);
  assert.equal(messages[2].toolName, "Read");
  assert.equal(messages[2].toolStatus, "success");
  assert.equal(messages[3].toolName, "Bash");
  assert.equal(messages[3].toolStatus, "error");
  // 合成 user 行（<system-reminder> 开头）被过滤
  assert.ok(messages.every((m) => m.role !== "user" || !m.content.startsWith("<")));
});

test("WorkBuddy fixture：孪生解析、独立数据根", async () => {
  const importer = createWorkbuddyImporter(fs, HOME);
  const summaries = await importer.scan();
  assert.ok(summaries.length > 0, "workbuddy fixture 应被 scan 发现");
  assert.equal(summaries[0].source, "workbuddy");
  const { messages } = await importer.convert(summaries[0]);
  assert.ok(messages.length > 0);
});

// ==================== Gemini CLI ====================

test("Gemini fixture：$set 覆盖式快照重放", async () => {
  const importer = createGeminiImporter(fs, HOME);
  const summaries = await importer.scan();
  const s = summaries.find((x) => x.externalId === "55555555-aaaa-bbbb-cccc-000000000005");
  assert.ok(s, "gemini fixture 应被 scan 发现");
  const { messages } = await importer.convert(s);
  // 3 条 $set：1 → 2 → 重放到最后一条非空快照，旧的 m1 文本被覆盖
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"]);
  assert.match(messages[0].content, /Gemini 帮我调试二维码解码/);
  assert.equal(messages[1].content, "可以,先在解码回调里打日志。");
});

// ==================== Grok Build ====================

test("Grok fixture：ACP chunk 按角色段合并、tool_call 配对、summary 边车", async () => {
  const importer = createGrokImporter(fs, HOME);
  const summaries = await importer.scan();
  const s = summaries.find((x) => x.externalId === "77777777-aaaa-bbbb-cccc-000000000007");
  assert.ok(s, "grok fixture 应被 scan 发现");
  assert.equal(s.title, "Grok QR scan cleanup");
  assert.equal(s.projectPath, "/Users/tester/Github/wakefx");
  assert.equal(s.model, "grok-composer-2.5-fast");
  const { messages } = await importer.convert(s);
  // user 两段合并为一条；tool_call→update 配对；agent 两段合并为一条
  assert.deepEqual(messages.map((m) => m.role), ["user", "tool", "assistant"]);
  assert.match(messages[0].content, /Grok 看看二维码扫描,/);
  assert.match(messages[0].content, /重点 useEffect\(\) 清理$/);
  assert.equal(messages[1].toolName, "Grep");
  assert.equal(messages[1].toolStatus, "success");
  assert.match(messages[1].content, /found 2 matches/);
  assert.equal(messages[2].content, "已定位泄漏,补了清理回调。");
});

test("Kimi fixture：占位标题回退首条 prompt；append_message 只收 assistant", async () => {
  const importer = createKimiImporter(fs, HOME);
  const summaries = await importer.scan();
  assert.equal(summaries.length, 2, "两个 kimi 会话目录");
  const custom = summaries.find((s) => s.externalId.includes("88888888"));
  assert.ok(custom);
  assert.equal(custom.title, "Kimi QR fix");
  const placeholder = summaries.find((s) => s.externalId.includes("99999999"));
  assert.ok(placeholder);
  // "New Session" 占位 → 回退首条 prompt 文本
  assert.equal(placeholder.title, "占位标题会话应回退到这句");
  const { messages } = await importer.convert(custom);
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"]);
  assert.match(messages[0].content, /Kimi 修一下二维码组件/);
  assert.equal(messages[1].content, "已定位 QrScanner 泄漏并补了清理回调。");
});

// ==================== Craft Agents ====================

test("Craft fixture：header 驱动、hidden/plan/info 行剔除、占位符展开", async () => {
  const importer = createCraftImporter(fs, HOME);
  const summaries = await importer.scan();
  assert.equal(summaries.length, 5, "五个 craft 会话目录");
  const main = summaries.find((s) => s.externalId.endsWith("/260801-brave-otter"));
  assert.ok(main);
  assert.equal(main.title, "Fix QR scanner crash");
  assert.equal(main.model, "claude-opus-5-5");
  const { messages } = await importer.convert(main);
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "assistant", "tool", "tool", "assistant", "tool", "assistant"],
  );
  // {{SESSION_PATH}} 展开为会话目录绝对路径（Bash 命令的 toolInput 里）
  const bash = messages.find((m) => m.role === "tool" && m.toolName === "Bash");
  assert.ok(
    bash &&
      String(bash.toolArgs?.command ?? "").includes(
        "/home/tester/.craft-agent/workspaces/wakefx-ws/sessions/260801-brave-otter",
      ),
  );
  assert.equal(bash?.toolStatus, "error");
  // hidden user 行（Background task finished）与 info/mystery 行不进
  assert.ok(messages.every((m) => !m.content.includes("Background task finished")));
});

test("Craft claimed：Claude 引擎副本认领（Pi 连接不认领）", async () => {
  const importer = createCraftImporter(fs, HOME);
  await importer.scan();
  const claimed = importer.claimed?.() ?? [];
  const claimedIds = claimed.map((c) => c.externalId);
  assert.equal(claimed.every((c) => c.source === "claude-code"), true);
  assert.ok(claimedIds.includes("c1a0de00-aaaa-4bbb-8ccc-000000000001"), "主会话的引擎副本应被认领");
  // 260802 是 pi/gpt-6-astra 连接：不认领
  const quietLakeSdk = "01a0d3b2-0000-7000-8000-000000000002";
  assert.ok(!claimedIds.includes(quietLakeSdk), "Pi 引擎会话不认领");
});

// ==================== ZCode（node:sqlite 真实库）====================

test("ZCode fixture：task_type 白名单、软删/迁移副本隐藏、占位标题回退、part 解析", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const mainDb = new DatabaseSync(":memory:");
  const tasksDb = new DatabaseSync(":memory:");
  mainDb.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, directory TEXT, title TEXT, title_source TEXT,
      task_type TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, sequence INTEGER, data TEXT
    );
  `);
  tasksDb.exec(`CREATE TABLE tasks (task_id TEXT, deleted INTEGER, migration_source TEXT);`);
  const insSession = mainDb.prepare(
    "INSERT INTO session (id,directory,title,title_source,task_type,parent_id,time_created,time_updated) VALUES (?,?,?,?,?,?,?,?)",
  );
  const insMsg = mainDb.prepare("INSERT INTO message (id,session_id,time_created,data) VALUES (?,?,?,?)");
  const insPart = mainDb.prepare("INSERT INTO part (id,message_id,session_id,sequence,data) VALUES (?,?,?,?,?)");
  const dir = "/Users/tester/proj";
  insSession.run("s1", dir, "QR fix", "custom", "interactive", null, 1786000000000, 1786000100000);
  insSession.run("s2", dir, "Deleted task", "custom", "interactive", null, 1786000000000, 1786000100000);
  insSession.run("s3", dir, "Migrated", "custom", "interactive", null, 1786000000000, 1786000100000);
  insSession.run("s4", dir, "Subagent run", "custom", "subagent_child", "s1", 1786000000000, 1786000100000);
  insSession.run("s5", dir, "", "default", "interactive", null, 1786000200000, 1786000300000);
  // s1：user 文本 + assistant（modelId）文本 + assistant 工具调用
  insMsg.run("m1", "s1", 1786000001000, JSON.stringify({ role: "user", time: { created: 1786000001000 } }));
  insPart.run("p1", "m1", "s1", 1, JSON.stringify({ type: "text", text: "修复二维码扫描的 useEffect 清理" }));
  insMsg.run("m2", "s1", 1786000002000, JSON.stringify({ role: "assistant", time: { created: 1786000002000 }, modelId: "glm-5.3", tokens: { total: 120 } }));
  insPart.run("p2", "m2", "s1", 1, JSON.stringify({ type: "reasoning", text: "分析" }));
  insPart.run("p3", "m2", "s1", 2, JSON.stringify({ type: "text", text: "先看组件源码。" }));
  insPart.run("p4", "m2", "s1", 3, JSON.stringify({ type: "tool", tool: "Read", callID: "call-1", state: { input: { file_path: "src/qr.tsx" }, output: "export function Qr() {}" } }));
  // s5：占位标题（title_source=default）→ 回退首条用户文本
  insMsg.run("m5", "s5", 1786000201000, JSON.stringify({ role: "user", time: { created: 1786000201000 } }));
  insPart.run("p5", "m5", "s5", 1, JSON.stringify({ type: "text", text: "占位标题会话的首条提问" }));
  // 隐藏集：s2 软删、s3 迁移副本
  tasksDb.exec("INSERT INTO tasks (task_id, deleted, migration_source) VALUES ('s2', 1, NULL);");
  tasksDb.exec("INSERT INTO tasks (task_id, deleted, migration_source) VALUES ('s3', 0, 'claude-code');");

  const mkDb = (map) => ({
    async query(path, sql, params = []) {
      const db = map[path];
      if (!db) return null;
      try {
        const stmt = db.prepare(sql);
        const columns = stmt.columns().map((c) => c.name);
        const rows = stmt.all(...params).map((row) => columns.map((c) => (row[c] === undefined ? null : row[c])));
        return { columns, rows };
      } catch {
        return null;
      }
    },
  });
  const db = mkDb({
    [`${HOME}/.zcode/cli/db/db.sqlite`]: mainDb,
    [`${HOME}/.zcode/v2/tasks-index.sqlite`]: tasksDb,
  });
  const { createZcodeImporter } = await import("./importers.ts");
  const importer = createZcodeImporter(fs, HOME, db);
  const summaries = await importer.scan();
  const ids = summaries.map((s) => s.externalId).sort();
  // s2/s3 隐藏、s4 不在白名单 → 只剩 s1 与 s5
  assert.deepEqual(ids, ["s1", "s5"]);
  const s1 = summaries.find((s) => s.externalId === "s1");
  assert.equal(s1.title, "QR fix");
  assert.equal(s1.projectPath, dir);
  assert.equal(s1.model, "glm-5.3");
  const s5 = summaries.find((s) => s.externalId === "s5");
  assert.equal(s5.title, "占位标题会话的首条提问", "占位标题回退首条用户文本");
  const { messages } = await importer.convert(s1);
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "tool"]);
  assert.equal(messages[1].content, "先看组件源码。");
  assert.equal(messages[2].toolName, "Read");
  assert.equal(messages[2].toolCallId, "call-1");
  assert.equal(messages[2].content, "export function Qr() {}");
});

// ==================== Cursor / OpenClaw（文件型）====================

test("Cursor fixture：user_query 壳提取、workspace 注入行剔除、turn_ended 空壳不列", async () => {
  const { createCursorImporter } = await import("./importers.ts");
  const importer = createCursorImporter(fs, HOME);
  const summaries = await importer.scan();
  // 4444 只有 turn_ended 空壳 → 只列 3333
  assert.deepEqual(summaries.map((s) => s.externalId), ["33333333-aaaa-bbbb-cccc-000000000003"]);
  const { messages } = await importer.convert(summaries[0]);
  const roles = messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "user"]);
  assert.match(messages[0].content, /把二维码扫描组件/);
  assert.ok(messages.every((m) => !m.content.includes("<workspace>")));
  assert.equal(messages[1].content, "先看现有组件结构,再抽公共 hook。");
});

test("OpenClaw fixture：legacy jsonl 路径、checkpoint 边车不列", async () => {
  const { createOpenclawImporter } = await import("./importers.ts");
  const importer = createOpenclawImporter(fs, HOME);
  const summaries = await importer.scan();
  const ids = summaries.map((s) => s.externalId).sort();
  assert.ok(ids.includes("main/cccccccc-aaaa-bbbb-cccc-000000000017"));
  assert.ok(ids.includes("main/dddddddd-aaaa-bbbb-cccc-000000000018"));
  assert.ok(!ids.some((id) => id.includes("checkpoint")), "checkpoint 边车不列");
  const main = summaries.find((s) => s.externalId.endsWith("cccccccc-aaaa-bbbb-cccc-000000000017"));
  assert.equal(main.projectPath, "/Users/tester/Github/wakefx");
  const { messages } = await importer.convert(main);
  assert.ok(messages.length > 0);
  assert.ok(messages.some((m) => m.role === "user"));
});

// ==================== Copilot / Hermes / Devin（node:sqlite 真实库）====================

function sqliteImportDb(map) {
  return {
    async query(path, sql, params = []) {
      const db = map[path];
      if (!db) return null;
      try {
        const stmt = db.prepare(sql);
        const columns = stmt.columns().map((c) => c.name);
        const rows = stmt.all(...params).map((row) => columns.map((c) => (row[c] === undefined ? null : row[c])));
        return { columns, rows };
      } catch {
        return null;
      }
    },
  };
}

test("Copilot fixture：sessions+turns 聚合与正文导出", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { createCopilotImporter } = await import("./importers.ts");
  const main = new DatabaseSync(":memory:");
  main.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, branch TEXT, summary TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE turns (id TEXT PRIMARY KEY, session_id TEXT, user_message TEXT, assistant_response TEXT);
  `);
  main.exec("INSERT INTO sessions VALUES ('c1', '/Users/tester/proj', 'main', 'QR cleanup', 1786000000000, 1786000100000);");
  main.exec("INSERT INTO sessions VALUES ('c2', '/Users/tester/proj', 'main', 'Empty', 1786000000000, 1786000100000);");
  main.exec("INSERT INTO turns VALUES ('t1', 'c1', '看看二维码组件', '已定位泄漏。');");
  main.exec("INSERT INTO turns VALUES ('t2', 'c1', '修一下', '补了 cleanup。');");
  const db = sqliteImportDb({ [`${HOME}/.copilot/session-store.db`]: main });
  const importer = createCopilotImporter(fs, HOME, db);
  const summaries = await importer.scan();
  assert.deepEqual(summaries.map((s) => s.externalId), ["c1"], "空会话不列");
  assert.equal(summaries[0].title, "QR cleanup");
  const { messages } = await importer.convert(summaries[0]);
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(messages[1].content, "已定位泄漏。");
});

test("Hermes fixture：source=tool 不列、tool_calls 两种形状与 tool_call_id 回填", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { createHermesImporter } = await import("./importers.ts");
  const main = new DatabaseSync(":memory:");
  main.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, title TEXT, started_at REAL, ended_at REAL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL);
  `);
  main.exec("INSERT INTO sessions VALUES ('h1', 'cli', 'hermes-3', '扫码修复', 1786000000, 1786000100);");
  main.exec("INSERT INTO sessions VALUES ('h2', 'tool', 'hermes-3', 'session_search', 1786000000, 1786000100);");
  main.exec(`INSERT INTO messages VALUES ('m1','h1','user','看下二维码组件',NULL,NULL,NULL,1786000001);`);
  // OpenAI 原样形状
  main.exec(`INSERT INTO messages VALUES ('m2','h1','assistant','',NULL,'[{"id":"call-a","type":"function","function":{"name":"Read","arguments":"{\\"file\\":\\"qr.tsx\\"}"}}]','Read',1786000002);`);
  main.exec(`INSERT INTO messages VALUES ('m3','h1','tool','组件源码', 'call-a', NULL, 'Read', 1786000003);`);
  // 自家精简形状（无 id，按 tool_name 顺位回填）
  main.exec(`INSERT INTO messages VALUES ('m4','h1','assistant','读完继续',NULL,'[{"name":"Bash","arguments":"{\\"cmd\\":\\"npm test\\"}"}]',NULL,1786000004);`);
  main.exec(`INSERT INTO messages VALUES ('m5','h1','tool','测试通过','',NULL,'Bash',1786000005);`);
  const db = sqliteImportDb({ [`${HOME}/.hermes/state.db`]: main });
  const importer = createHermesImporter(fs, HOME, db);
  const summaries = await importer.scan();
  assert.deepEqual(summaries.map((s) => s.externalId), ["h1"], "source=tool 不列");
  const { messages } = await importer.convert(summaries[0]);
  assert.deepEqual(messages.map((m) => m.role), ["user", "tool", "assistant", "tool"]);
  assert.equal(messages[0].content, "看下二维码组件");
  assert.equal(messages[1].toolName, "Read");
  assert.equal(messages[1].toolArgs.file, "qr.tsx");
  assert.equal(messages[2].content, "读完继续");
  assert.equal(messages[3].toolName, "Bash");
});

test("Devin fixture：main_chain 回溯、hidden 不列、内部消息剔除", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { createDevinImporter } = await import("./importers.ts");
  const main = new DatabaseSync(":memory:");
  main.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, working_directory TEXT, model TEXT, created_at INTEGER, last_activity_at INTEGER, main_chain_id TEXT, hidden INTEGER);
    CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY, session_id TEXT, node_id TEXT, parent_node_id TEXT, chat_message TEXT, created_at INTEGER);
  `);
  main.exec("INSERT INTO sessions VALUES ('d1','扫码修复','/Users/tester/proj','devin-1',1786000000,1786000100,'n4',0);");
  main.exec("INSERT INTO sessions VALUES ('d2','隐藏会话','/Users/tester/proj','devin-1',1786000000,1786000100,NULL,1);");
  const msg = (o) => JSON.stringify(o);
  main.exec(`INSERT INTO message_nodes VALUES (1,'d1','n1',NULL,'${msg({ role: "user", content: "看下二维码", metadata: { is_user_input: true, telemetry: { source: "user" } } })}',1786000001);`);
  main.exec(`INSERT INTO message_nodes VALUES (2,'d1','n2','n1','${msg({ role: "assistant", content: "先读源码", tool_calls: [{ id: "c1", name: "Read", arguments: { file: "qr.tsx" } }] })}',1786000002);`);
  main.exec(`INSERT INTO message_nodes VALUES (3,'d1','n3','n2','${msg({ role: "tool", content: "源码内容", tool_call_id: "c1" })}',1786000003);`);
  main.exec(`INSERT INTO message_nodes VALUES (4,'d1','n4','n3','${msg({ role: "assistant", content: "修好了" })}',1786000004);`);
  // 侧枝（不主链）：重试分支不该进
  main.exec(`INSERT INTO message_nodes VALUES (5,'d1','x1','n2','${msg({ role: "assistant", content: "废弃分支文本" })}',1786000005);`);
  // 内部消息：心跳
  main.exec(`INSERT INTO message_nodes VALUES (6,'d1','x2','n4','${msg({ role: "user", content: "keepalive", metadata: { telemetry: { source: "cache_keepalive" } } })}',1786000006);`);
  const db = sqliteImportDb({ [`${HOME}/.local/share/devin/cli/sessions.db`]: main });
  const importer = createDevinImporter(fs, HOME, db);
  const summaries = await importer.scan();
  assert.deepEqual(summaries.map((s) => s.externalId), ["d1"], "hidden 不列");
  assert.equal(summaries[0].model, "devin-1");
  const { messages } = await importer.convert(summaries[0]);
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
  assert.ok(messages.every((m) => !m.content.includes("废弃分支")), "侧枝不进");
  assert.ok(messages.every((m) => !m.content.includes("keepalive")), "心跳不进");
  assert.equal(messages[2].toolName, "Read");
});

// ==================== DeepSeek Harness ====================

test("dsh fixture：v4/v0 两代解析、agent-instructions 剔除、tool 回填、title 事件", async () => {
  const { createDshImporter } = await import("./importers.ts");
  const importer = createDshImporter(fs, HOME);
  const summaries = await importer.scan();
  const ids = summaries.map((s) => s.externalId).sort();
  assert.deepEqual(ids, ["dsh-e2e4-0001", "dsh-v4-0003"]);
  const v4 = summaries.find((s) => s.externalId === "dsh-v4-0003");
  assert.equal(v4.projectPath, "/Users/tester/Github/wakefx");
  const { messages } = await importer.convert(v4);
  const roles = messages.map((m) => m.role);
  // v4 全程：user + assistant + tool(call-1) + tool(call-2 拒绝) + tool(pruned) + assistant 收尾
  assert.deepEqual(roles, ["user", "assistant", "tool", "tool", "tool", "assistant"]);
  assert.match(messages[0].content, /把 README 里的安装命令换成 npx/);
  assert.equal(messages[1].content, "我先看一下 README 的安装段落。");
  assert.equal(messages[2].toolName, "read_file");
  assert.equal(messages[2].toolCallId, "call-1");
  assert.equal(messages[3].toolName, "edit_file");
  assert.match(messages[5].content, /README 是只读的/);
  assert.ok(messages.every((m) => !m.content.includes("Workspace instructions")));
  const v0 = summaries.find((s) => s.externalId === "dsh-e2e4-0001");
  assert.equal(v0.title, "QR scan dependency fix", "session/title last-wins");
  assert.equal(v0.model, "deepseek-chat-v4");
  const v0conv = await importer.convert(v0);
  assert.ok(v0conv.messages.some((m) => m.role === "user"));
  assert.ok(v0conv.messages.some((m) => m.role === "tool"));
  // plugin 来源的 user 行（fs-watch）与 agent-instructions 都不进
  assert.ok(v0conv.messages.every((m) => !m.content.includes("[fs-watch]") && !m.content.includes("Instructions from")));
});

// ==================== OpenCode SQLite（真库 schema 回归）====================

test("OpenCode SQLite：真库 schema（session 无时间列、v1/v2 两代并存）逐会话代数裁决", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { createOpencodeSqliteImporter } = await import("./importers.ts");
  const main = new DatabaseSync(":memory:");
  // 按 2026-10-07 真库 schema 建表：session 无 time_created/time_updated
  main.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
    -- 真库形态：session_v2 是 v2 代会话表（自有时间列，正文在 session_message）
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
  `);
  main.exec("INSERT INTO session_v2 VALUES ('other-session', 'p1', NULL, '/x', '无正文不列', 1, 1);");
  main.exec("INSERT INTO session_v2 VALUES ('ses_v2native', 'p1', NULL, '/Users/tester/proj-c', 'v2 原生会话', 1786000500000, 1786000600000);");
  const smn1 = JSON.stringify({ text: "v2 原生的第一条", time: { created: 1786000510000 } });
  const smn2 = JSON.stringify({ role: "assistant", content: [{ type: "text", text: "v2 原生的回复" }], time: { created: 1786000520000 } });
  main.exec(`INSERT INTO session_message VALUES ('smn1','ses_v2native','user',1,1786000510000,1786000510000,'${smn1.replaceAll("'", "''")}')`);
  main.exec(`INSERT INTO session_message VALUES ('smn2','ses_v2native','assistant',2,1786000520000,1786000520000,'${smn2.replaceAll("'", "''")}')`);
  // v1 会话：正文在 part
  main.exec("INSERT INTO session VALUES ('ses_v1', 'p1', NULL, '/Users/tester/proj-a', 'v1 会话标题');");
  main.exec("INSERT INTO message VALUES ('mm1','ses_v1',1786000001000,1786000002000,'{\"role\":\"user\",\"time\":{\"created\":1786000001000}}')");
  main.exec("INSERT INTO part VALUES ('pp1','mm1','ses_v1',1786000001000,1786000001000,'{\"type\":\"text\",\"text\":\"v1 会话的用户消息\"}')");
  // v2 会话：正文在 session_message
  main.exec("INSERT INTO session VALUES ('ses_v2', 'p1', NULL, '/Users/tester/proj-b', 'v2 会话标题');");
  main.exec("INSERT INTO session_message VALUES ('sm1','ses_v2','user',1,1786000100000,1786000100000,'{\"text\":\"v2 会话的用户消息\",\"time\":{\"created\":1786000100000}}')");
  main.exec("INSERT INTO session_message VALUES ('sm2','ses_v2','assistant',2,1786000200000,1786000200000,'{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"v2 的回复\"}],\"time\":{\"created\":1786000200000}}')");
  // 子代理：不列
  main.exec("INSERT INTO session VALUES ('ses_child', 'p1', 'ses_v1', '/Users/tester/proj-a', '子代理');");
  const db = sqliteImportDb({ [`${HOME}/.local/share/opencode/opencode.db`]: main });
  const importer = createOpencodeSqliteImporter(fs, HOME, db);
  const summaries = await importer.scan();
  const ids = summaries.map((s) => s.externalId).sort();
  assert.deepEqual(ids, ["ses_v1", "ses_v2", "ses_v2native"]);
  const v1 = summaries.find((s) => s.externalId === "ses_v1");
  assert.equal(v1.title, "v1 会话标题");
  assert.ok(!Number.isNaN(new Date(v1.createdAt).getTime()) && v1.createdAt.startsWith("2026-08-06"), "时间从 message 聚合（session 表没有时间列）");
  const v1conv = await importer.convert(v1);
  assert.deepEqual(v1conv.messages.map((m) => m.role), ["user"]);
  const v2 = summaries.find((s) => s.externalId === "ses_v2");
  const v2conv = await importer.convert(v2);
  assert.deepEqual(v2conv.messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal(v2conv.messages[1].content, "v2 的回复");
  // v2 原生（session_v2 + session_message）
  const native = summaries.find((s) => s.externalId === "ses_v2native");
  assert.ok(native, "v2 原生会话应被枚举");
  assert.equal(native.title, "v2 原生会话");
  const nativeConv = await importer.convert(native);
  assert.deepEqual(nativeConv.messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal(nativeConv.messages[0].content, "v2 原生的第一条");
  // 删除 ses_v1（放最后）：session_v2 键列探测应选 id、不误报 no such column，且不波及他行
  const { deleteSessionBySource } = await import("./importers.ts");
  const dbExec = {
    query: db.query,
    execute: (path, sql, params = []) => {
      try {
        return { changed: main.prepare(sql).run(...params).changes };
      } catch (e) {
        console.log("exec fail:", String(e).slice(0, 80));
        return null;
      }
    },
  };
  await deleteSessionBySource(
    { source: "opencode", externalId: "ses_v1", title: "t", projectPath: null, model: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messageCount: 1, filePath: `${HOME}/.local/share/opencode/opencode.db` },
    { fs, db: dbExec, home: HOME },
  );
  assert.equal(main.prepare("SELECT COUNT(*) c FROM session WHERE id='ses_v1'").get().c, 0);
  assert.equal(main.prepare("SELECT COUNT(*) c FROM session_v2").get().c, 2, "session_v2 他行不波及");
});

// ==================== 删除所选（永久删除 + SQL）====================

test("删除分发：pi 文件型删主文件；zcode SQL 型三表连删", async () => {
  const { deleteSessionBySource } = await import("./importers.ts");
  const { DatabaseSync } = await import("node:sqlite");

  // --- pi：文件型 ---
  const removed = [];
  const fsWithRemove = {
    ...fs,
    async removePath(path) {
      removed.push(path);
      return true;
    },
  };
  await deleteSessionBySource(
    {
      source: "pi",
      externalId: "66666666-aaaa-bbbb-cccc-000000000006",
      title: "t",
      projectPath: null,
      model: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 1,
      filePath: `${HOME}/.pi/agent/sessions/--Users-tester-Github-wakefx--/2026-08-06T10-00-00-000Z_66666666-aaaa-bbbb-cccc-000000000006.jsonl`,
    },
    { fs: fsWithRemove, home: HOME },
  );
  assert.deepEqual(removed, [
    `${HOME}/.pi/agent/sessions/--Users-tester-Github-wakefx--/2026-08-06T10-00-00-000Z_66666666-aaaa-bbbb-cccc-000000000006.jsonl`,
  ]);

  // --- codex：同为单文件型 ---
  removed.length = 0;
  await deleteSessionBySource(
    {
      source: "codex",
      externalId: "44444444-aaaa-bbbb-cccc-000000000004",
      title: "t",
      projectPath: null,
      model: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 1,
      filePath: `${HOME}/.codex/sessions/2026/08/09/rollout-2026-08-09T10-30-00-44444444-aaaa-bbbb-cccc-000000000004.jsonl`,
    },
    { fs: fsWithRemove, home: HOME },
  );
  assert.deepEqual(removed, [
    `${HOME}/.codex/sessions/2026/08/09/rollout-2026-08-09T10-30-00-44444444-aaaa-bbbb-cccc-000000000004.jsonl`,
  ]);

  // --- zcode：SQL 型三表连删 + tasks-index 清标记 ---
  const main = new DatabaseSync(":memory:");
  const tasks = new DatabaseSync(":memory:");
  main.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
  `);
  tasks.exec("CREATE TABLE tasks (task_id TEXT, deleted INTEGER);");
  main.exec("INSERT INTO session VALUES ('s-del', '/p', '待删');");
  main.exec("INSERT INTO message VALUES ('m1', 's-del', '{}');");
  main.exec("INSERT INTO part VALUES ('p1', 'm1', 's-del', '{}');");
  tasks.exec("INSERT INTO tasks VALUES ('s-del', 0);");
  const query = (path, sql, params = []) => {
    const target = path.endsWith("tasks-index.sqlite") ? tasks : main;
    try {
      const stmt = target.prepare(sql);
      const columns = stmt.columns().map((c) => c.name);
      const rows = stmt.all(...params).map((row) => columns.map((c) => (row[c] === undefined ? null : row[c])));
      return { columns, rows };
    } catch {
      return null;
    }
  };
  const execute = (path, sql, params = []) => {
    const target = path.endsWith("tasks-index.sqlite") ? tasks : main;
    try {
      const changed = target.prepare(sql).run(...params).changes;
      return { changed };
    } catch {
      return null;
    }
  };
  const db = { query, execute };
  await deleteSessionBySource(
    {
      source: "zcode",
      externalId: "s-del",
      title: "t",
      projectPath: null,
      model: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 1,
      filePath: `${HOME}/.zcode/cli/db/db.sqlite`,
    },
    { fs: fsWithRemove, db, home: HOME },
  );
  assert.equal(main.prepare("SELECT COUNT(*) c FROM session").get().c, 0);
  assert.equal(main.prepare("SELECT COUNT(*) c FROM message").get().c, 0);
  assert.equal(main.prepare("SELECT COUNT(*) c FROM part").get().c, 0);
  assert.equal(tasks.prepare("SELECT COUNT(*) c FROM tasks").get().c, 0);
});

test("删除分发：devin 走 SQL、文件型缺 removePath 能力时如实报错", async () => {
  const { deleteSessionBySource } = await import("./importers.ts");
  const { DatabaseSync } = await import("node:sqlite");
  const main = new DatabaseSync(":memory:");
  main.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY, session_id TEXT);
  `);
  main.exec("INSERT INTO sessions VALUES ('d1', 'x');");
  main.exec("INSERT INTO message_nodes VALUES (1, 'd1');");
  const db = {
    query: (path, sql, params = []) => {
      const stmt = main.prepare(sql);
      const columns = stmt.columns().map((c) => c.name);
      return { columns, rows: stmt.all(...params).map((row) => columns.map((c) => (row[c] === undefined ? null : row[c]))) };
    },
    execute: (path, sql, params = []) => ({ changed: main.prepare(sql).run(...params).changes }),
  };
  await deleteSessionBySource(
    {
      source: "devin",
      externalId: "d1",
      title: "t",
      projectPath: null,
      model: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 1,
      filePath: `${HOME}/.local/share/devin/cli/sessions.db`,
    },
    { fs, db, home: HOME },
  );
  assert.equal(main.prepare("SELECT COUNT(*) c FROM sessions").get().c, 0);

  // 文件型但 fs 没有 removePath 能力（理论不发生在应用内）→ 如实报错
  await assert.rejects(
    deleteSessionBySource(
      {
        source: "pi",
        externalId: "x",
        title: "t",
        projectPath: null,
        model: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 1,
        filePath: `${HOME}/.pi/agent/sessions/x.jsonl`,
      },
      { fs, home: HOME },
    ),
    /failed to delete/,
  );
});
