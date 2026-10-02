/**
 * 导入库测试：会话导入器（内存 ImportFs 固定装置）+ 候选分组 + 模型配置解析。
 * 运行：node --test src/lib/import/import.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  createClaudeImporter,
  createCodexImporter,
  createPiImporter,
} = await import("./importers.ts");
const { groupImportCandidates, projectNameOf, formatImportDate } = await import("./importGroups.ts");
const {
  parseClaudeCodeModelConfig,
  parseCodexModelConfig,
  parseOpenCodeModelConfig,
  parsePiModelConfig,
  parseCcSwitchConfigJson,
  parseCcSwitchProviders,
  parseJsonDocument,
  draftMatchesExisting,
  resolveApiFormat,
  modelConfigImportId,
} = await import("./modelConfigParse.ts");

/** 内存 ImportFs：{ 路径: 内容 }（listDir 按前缀推导，模仿目录语义）。 */
function memoryFs(files) {
  return {
    async readText(path) {
      const norm = path.replace(/\\/g, "/");
      return Object.prototype.hasOwnProperty.call(files, norm) ? files[norm] : null;
    },
    async listDir(path) {
      const norm = path.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
      const set = new Set();
      for (const key of Object.keys(files)) {
        if (!key.startsWith(norm)) continue;
        const rest = key.slice(norm.length);
        if (!rest) continue;
        set.add(rest.split("/")[0]);
      }
      return [...set];
    },
    async readEnds(path, headLen, tailLen) {
      const full = await this.readText(path);
      if (full == null) return null;
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
      const full = await this.readText(path);
      if (full == null) return null;
      return full.slice(offset, offset + length);
    },
  };
}

const HOME = "/home/tester";

// ==================== 候选分组 ====================

test("groupImportCandidates：按来源分组、组内按 updatedAt 倒序、组间按最新倒序", () => {
  const candidates = [
    { source: "claude-code", externalId: "a", title: "A", projectPath: "/p1", model: null, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z", messageCount: 2, filePath: "/x/a.jsonl" },
    { source: "codex", externalId: "b", title: "B", projectPath: null, model: null, createdAt: "2024-02-01T00:00:00Z", updatedAt: "2024-03-01T00:00:00Z", messageCount: 5, filePath: "/x/b.jsonl" },
    { source: "claude-code", externalId: "c", title: "C", projectPath: "/p1", model: null, createdAt: "2024-01-05T00:00:00Z", updatedAt: "2024-01-05T00:00:00Z", messageCount: 1, filePath: "/x/c.jsonl" },
  ];
  const labels = { noProject: "未知项目", sources: { "claude-code": "Claude Code", opencode: "OpenCode", codex: "Codex CLI", pi: "Pi" } };
  const bySource = groupImportCandidates(candidates, "source", labels);
  assert.equal(bySource.length, 2);
  assert.equal(bySource[0].name, "Codex CLI");
  assert.equal(bySource[1].name, "Claude Code");
  assert.equal(bySource[1].items[0].externalId, "c");

  const byPath = groupImportCandidates(candidates, "path", labels);
  assert.equal(byPath.length, 2);
  assert.equal(byPath[0].name, "p1");
  assert.equal(byPath[1].name, "未知项目");
});

test("projectNameOf / formatImportDate", () => {
  assert.equal(projectNameOf("/a/b/MyProject"), "MyProject");
  assert.equal(projectNameOf("C:\\work\\demo"), "demo");
  assert.equal(projectNameOf(null), "");
  assert.ok(formatImportDate("2024-03-01T00:00:00Z").length > 0);
  assert.equal(formatImportDate("not-a-date"), "not-a-date");
});

// ==================== Claude Code 导入器 ====================

test("Claude Code：scan 提取标题/项目/模型；convert 配对 tool_use↔tool_result 并过滤合成行", async () => {
  const jsonl = [
    JSON.stringify({ type: "user", timestamp: "2024-05-01T10:00:00Z", cwd: "/work/demo", message: { role: "user", content: [{ type: "text", text: "<system-reminder>noise</system-reminder>" }] } }),
    JSON.stringify({ type: "user", timestamp: "2024-05-01T10:00:05Z", message: { role: "user", content: "帮我看下这个 bug" } }),
    JSON.stringify({ type: "assistant", timestamp: "2024-05-01T10:00:10Z", message: { role: "assistant", model: "claude-sonnet-4", content: [{ type: "text", text: "我先读文件" }, { type: "tool_use", id: "tu1", name: "read_file", input: { path: "a.ts" } }] } }),
    JSON.stringify({ type: "user", timestamp: "2024-05-01T10:00:15Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "file contents" }] } }),
    JSON.stringify({ type: "assistant", timestamp: "2024-05-01T10:00:20Z", message: { role: "assistant", content: "修好了" } }),
    JSON.stringify({ type: "assistant", isSidechain: true, message: { role: "assistant", content: "sidechain noise" } }),
  ].join("\n");
  const fs = memoryFs({ [`${HOME}/.claude/projects/proj1/session-abc.jsonl`]: jsonl });
  const importer = createClaudeImporter(fs, HOME);

  const summaries = await importer.scan();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].externalId, "session-abc");
  assert.equal(summaries[0].title, "帮我看下这个 bug");
  assert.equal(summaries[0].projectPath, "/work/demo");
  assert.equal(summaries[0].model, "claude-sonnet-4");
  assert.equal(summaries[0].messageCount, 5);

  const converted = await importer.convert(summaries[0]);
  assert.equal(converted.session.id, "import-claude-code-session-abc");
  const roles = converted.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "tool", "assistant"]);
  assert.equal(converted.messages[0].content, "帮我看下这个 bug");
  assert.equal(converted.messages[2].toolName, "read_file");
  assert.equal(converted.messages[2].toolCallId, "tu1");
  assert.equal(converted.messages[2].toolArgs.path, "a.ts");
  assert.equal(converted.messages[2].content, "file contents");
});

// ==================== Codex 导入器 ====================

test("Codex：新格式（session_meta+response_item）与旧格式（裸 header+裸行）都能解析，function_call 配对，合成前缀过滤", async () => {
  const newFormat = [
    JSON.stringify({ timestamp: "2024-06-01T08:00:00Z", type: "session_meta", payload: { id: "cx-new", cwd: "/repo/x", timestamp: "2024-06-01T08:00:00Z" } }),
    JSON.stringify({ timestamp: "2024-06-01T08:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md\nrules here" }] } }),
    JSON.stringify({ timestamp: "2024-06-01T08:00:02Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix the test" }] } }),
    JSON.stringify({ timestamp: "2024-06-01T08:00:03Z", type: "response_item", payload: { type: "function_call", call_id: "c1", name: "shell", arguments: "{\"cmd\":\"ls\"}" } }),
    JSON.stringify({ timestamp: "2024-06-01T08:00:04Z", type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "a.ts\nb.ts" } }),
    JSON.stringify({ timestamp: "2024-06-01T08:00:05Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] } }),
  ].join("\n");
  const oldFormat = [
    JSON.stringify({ id: "cx-old", timestamp: "2024-05-01T09:00:00Z", cwd: "/repo/y" }),
    JSON.stringify({ timestamp: "2024-05-01T09:00:01Z", type: "message", role: "user", content: [{ type: "input_text", text: "hello codex" }] }),
  ].join("\n");
  const fs = memoryFs({
    [`${HOME}/.codex/sessions/2024/06/01/roll-1.jsonl`]: newFormat,
    [`${HOME}/.codex/sessions/2024/05/01/roll-2.jsonl`]: oldFormat,
  });
  const importer = createCodexImporter(fs, HOME);

  const summaries = await importer.scan();
  assert.equal(summaries.length, 2);
  const byId = new Map(summaries.map((s) => [s.externalId, s]));
  assert.equal(byId.get("cx-new").title, "fix the test");
  assert.equal(byId.get("cx-old").title, "hello codex");
  assert.equal(byId.get("cx-old").projectPath, "/repo/y");

  const converted = await importer.convert(byId.get("cx-new"));
  const roles = converted.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "tool", "assistant"]);
  assert.equal(converted.messages[0].content, "fix the test");
  assert.equal(converted.messages[1].toolName, "shell");
  assert.equal(converted.messages[1].toolArgs.cmd, "ls");
  assert.equal(converted.messages[1].content, "a.ts\nb.ts");
});

test("Codex 采样：超过 5MB 的文件走头/尾采样 + 顺序续读找标题，messageCount 为 null", async () => {
  const bigPad = "x".repeat(6 * 1024 * 1024); // > CODEX_SCAN_FULL_PARSE_MAX_BYTES 的填充行（非法 JSON，逐行跳过）
  const lines = [
    JSON.stringify({ timestamp: "2024-07-01T08:00:00Z", type: "session_meta", payload: { id: "cx-big", cwd: "/repo/big", timestamp: "2024-07-01T08:00:00Z" } }),
    bigPad,
    JSON.stringify({ timestamp: "2024-07-01T08:59:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "deep title" }] } }),
  ];
  const fs = memoryFs({ [`${HOME}/.codex/sessions/2024/07/01/big.jsonl`]: lines.join("\n") });
  const importer = createCodexImporter(fs, HOME);
  const summaries = await importer.scan();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].externalId, "cx-big");
  assert.equal(summaries[0].title, "deep title");
  assert.equal(summaries[0].messageCount, null);
});

// ==================== Pi 导入器 ====================

test("Pi：session header + message 条目；toolCall↔toolResult 配对；session_info.name 优先做标题", async () => {
  const jsonl = [
    JSON.stringify({ type: "session", id: "pi-1", cwd: "/work/pi", timestamp: "2024-04-01T12:00:00Z" }),
    JSON.stringify({ type: "session_info", name: "周报整理" }),
    JSON.stringify({ type: "message", timestamp: "2024-04-01T12:00:05Z", message: { role: "user", content: "整理这份周报" } }),
    JSON.stringify({ type: "message", timestamp: "2024-04-01T12:00:10Z", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4", content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "w.md" } }] } }),
    JSON.stringify({ type: "message", timestamp: "2024-04-01T12:00:15Z", message: { role: "toolResult", toolCallId: "tc1", toolName: "read", isError: false, content: "weekly report text" } }),
  ].join("\n");
  const fs = memoryFs({ [`${HOME}/.pi/agent/sessions/d1/pi-1.jsonl`]: jsonl });
  const importer = createPiImporter(fs, HOME);

  const summaries = await importer.scan();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].title, "周报整理");
  assert.equal(summaries[0].model, "claude-sonnet-4");

  const converted = await importer.convert(summaries[0]);
  assert.equal(converted.session.providerId, "anthropic");
  assert.equal(converted.messages.length, 2);
  assert.equal(converted.messages[1].toolName, "read");
  assert.equal(converted.messages[1].toolArgs.path, "w.md");
  assert.equal(converted.messages[1].content, "weekly report text");
});

// ==================== 模型配置解析 ====================

test("模型配置：Claude Code settings env 提取 anthropic 网关", () => {
  const drafts = parseClaudeCodeModelConfig(
    { env: { ANTHROPIC_BASE_URL: "https://gw.example.com/", ANTHROPIC_AUTH_TOKEN: "sk-test-123" }, model: "claude-sonnet-4" },
    { env: { ANTHROPIC_MODEL: "claude-haiku-3" } },
  );
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].source, "claude-code");
  assert.equal(drafts[0].baseUrl, "https://gw.example.com");
  assert.equal(drafts[0].apiFormat, "anthropic-messages");
  assert.ok(drafts[0].hasSecret);
  assert.deepEqual(drafts[0].modelIds.sort(), ["claude-haiku-3", "claude-sonnet-4"]);
});

test("模型配置：Codex TOML 子集（表头/注释/env_key 引用/wire_api）", () => {
  const toml = [
    "model = \"gpt-5-codex\"",
    "# comment",
    "[model_providers.custom-gw]",
    "name = \"Custom GW\"",
    "base_url = \"https://api.custom.dev/v1\" # inline comment",
    "env_key = \"CUSTOM_API_KEY\"",
    "wire_api = \"responses\"",
  ].join("\n");
  const drafts = parseCodexModelConfig(toml, { CUSTOM_API_KEY: "csk-123" });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].externalId, "custom-gw");
  assert.equal(drafts[0].baseUrl, "https://api.custom.dev/v1");
  assert.equal(drafts[0].apiFormat, "openai-responses");
  assert.equal(drafts[0].secretValue, "csk-123");
  assert.ok(drafts[0].modelIds.includes("gpt-5-codex"));
});

test("模型配置：OpenCode JSONC（注释+尾逗号）与 auth.json 密钥回退", () => {
  const config = parseJsonDocument(`{
    // provider map
    "provider": {
      "deepseek": {
        "api": "openai-chat",
        "options": { "baseURL": "https://api.deepseek.com/v1", "apiKey": "env:DS_KEY", },
      },
    },
    "model": "deepseek/deepseek-chat",
  }`);
  const drafts = parseOpenCodeModelConfig(config, { deepseek: { type: "api", key: "ds-999" } }, { DS_KEY: "" });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].externalId, "deepseek");
  assert.equal(drafts[0].apiFormat, "openai-chat-completions");
  assert.equal(drafts[0].secretValue, "ds-999");
  assert.deepEqual(drafts[0].modelIds, ["deepseek-chat"]);
});

test("模型配置：Pi models.json（providers 容器 + 裸 map 双形态）", () => {
  const wrapped = { providers: { "custom-1": { baseUrl: "https://p.example.com", api: "anthropic", apiKey: "pk-1", models: [{ id: "m1" }, { id: "m2", reasoning: true }] } } };
  const drafts = parsePiModelConfig(wrapped);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].apiFormat, "anthropic-messages");
  assert.deepEqual(drafts[0].modelIds, ["m1", "m2"]);

  const bare = { "custom-2": { baseUrl: "https://p2.example.com", models: ["m9"] } };
  const drafts2 = parsePiModelConfig(bare);
  assert.equal(drafts2.length, 1);
  assert.equal(drafts2[0].externalId, "custom-2");
});

test("模型配置：CC Switch legacy JSON → claude 行；pi 行跳过（真源在 models.json）", () => {
  const doc = {
    claude: { providers: { p1: { name: "My Claude", settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://cc.example.com", ANTHROPIC_API_KEY: "cc-key" } } } } },
    pi: { providers: { p2: { name: "pi-snapshot", settingsConfig: { env: { ANTHROPIC_API_KEY: "ignored" } } } } },
  };
  const rows = parseCcSwitchConfigJson(doc);
  assert.equal(rows.length, 2);
  const drafts = parseCcSwitchProviders(rows);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].source, "cc-switch");
  assert.equal(drafts[0].externalId, "claude:p1");
  assert.equal(drafts[0].name, "My Claude");
  assert.equal(drafts[0].secretValue, "cc-key");
});

test("去重：endpoint 归一化 + 协议一致 + 凭证相同才算重复；密钥不同不合并", () => {
  const draft = { baseUrl: "https://gw.example.com", apiFormat: "openai-chat-completions", secretValue: "k1", hasSecret: true };
  assert.equal(draftMatchesExisting(draft, [{ baseUrl: "https://gw.example.com/v1/", apiFormat: "openai-chat-completions", apiKey: "k1" }]).valueOf(), false);
  assert.equal(
    draftMatchesExisting(draft, [{ baseUrl: "https://gw.example.com", apiFormat: "openai-chat-completions", apiKey: "k1" }]),
    true,
  );
  assert.equal(
    draftMatchesExisting(draft, [{ baseUrl: "https://gw.example.com", apiFormat: "openai-chat-completions", apiKey: "k2" }]),
    false,
  );
  assert.equal(
    draftMatchesExisting({ ...draft, secretValue: undefined, hasSecret: false }, [{ baseUrl: "https://gw.example.com", apiFormat: "openai-chat-completions", apiKey: "" }]),
    true,
  );
});

test("apiFormat 别名与确定性 id", () => {
  assert.equal(resolveApiFormat("chat_completions"), "openai-chat-completions");
  assert.equal(resolveApiFormat("anthropic-messages"), "anthropic-messages");
  assert.equal(resolveApiFormat("openai-codex-responses"), "openai-responses");
  assert.equal(resolveApiFormat("pi-messages"), "anthropic-messages");
  assert.equal(resolveApiFormat("unknown-protocol"), undefined);
  assert.equal(modelConfigImportId("cc-switch", "claude:p1"), "import-cc-switch-claude:p1");
});
