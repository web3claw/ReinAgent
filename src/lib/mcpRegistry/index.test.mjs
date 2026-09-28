import test from "node:test";
import assert from "node:assert/strict";
import {
  applyMcpRegistryInstallConfig,
  createUniqueMcpServerId,
  mcpRegistryConfigInputKey,
  searchMcpRegistry,
  withUniqueMcpServerId,
} from "./index.ts";
import { resolveMcpDocsHref } from "../hub/mcpServerMetadata.ts";

const jsonStub = (payload) => ({
  ok: true,
  status: 200,
  json: async () => payload,
  text: async () => "",
});

// ---- resolveMcpDocsHref 白名单 ----

test("resolveMcpDocsHref：http(s) 与裸域名放行", () => {
  assert.equal(resolveMcpDocsHref("https://example.com/docs"), "https://example.com/docs");
  assert.equal(resolveMcpDocsHref("http://example.com"), "http://example.com");
  assert.equal(resolveMcpDocsHref("example.com/docs"), "https://example.com/docs");
  assert.equal(resolveMcpDocsHref("//example.com"), "https://example.com");
  assert.equal(resolveMcpDocsHref("example.com:8443/path"), "https://example.com:8443/path");
  assert.equal(resolveMcpDocsHref("[::1]:9000"), "https://[::1]:9000");
});

test("resolveMcpDocsHref：非 http 协议、控制字符、空白拒绝", () => {
  assert.equal(resolveMcpDocsHref("javascript:alert(1)"), null);
  assert.equal(resolveMcpDocsHref("file:///etc/passwd"), null);
  assert.equal(resolveMcpDocsHref("ftp://example.com"), null);
  assert.equal(resolveMcpDocsHref("bad url with space"), null);
  assert.equal(resolveMcpDocsHref("tab\tchar"), null);
  assert.equal(resolveMcpDocsHref(""), null);
  assert.equal(resolveMcpDocsHref("   "), null);
  assert.equal(resolveMcpDocsHref(undefined), null);
});

// ---- official registry：npm 包安装草稿 ----

const officialPayload = {
  servers: [
    {
      name: "demo-server",
      description: "Demo MCP server",
      version: "1.0.0",
      websiteUrl: "https://example.com",
      repository: { url: "https://github.com/x/demo-server" },
      packages: [
        {
          registryType: "npm",
          identifier: "demo-server",
          transport: { type: "stdio" },
          runtimeArguments: [],
          environmentVariables: [{ name: "DEMO_TOKEN", isRequired: true, isSecret: true }],
          packageArguments: [],
        },
      ],
      remotes: [],
    },
  ],
  metadata: { count: 1, nextCursor: "" },
};

test("official npm 包推导 npx 草稿，必填 env 进入 needs_config", async () => {
  const result = await searchMcpRegistry({
    source: "official",
    query: "demo",
    fetchImpl: () => jsonStub(officialPayload),
  });
  assert.equal(result.source, "official");
  assert.equal(result.items.length, 1);
  const card = result.items[0];
  assert.equal(card.name, "demo-server");
  assert.equal(card.verified, false, "缺 official _meta 时不标注 verified");
  assert.equal(card.transportHints[0], "stdio");

  const draft = card.installDraft;
  assert.ok(draft);
  assert.equal(draft.server.transport, "stdio");
  assert.equal(draft.server.command, "npx");
  assert.ok(draft.server.args.includes("demo-server"), "identifier 进 args");
  assert.equal(draft.server.env.DEMO_TOKEN, "...", "无值的必填 env 落占位符");
  assert.equal(draft.status, "needs_config");
  assert.equal(draft.server.enabled, false, "needs_config 草稿默认不启用");
  assert.equal(draft.requiredConfig.length, 1);
  assert.equal(draft.requiredConfig[0].name, "DEMO_TOKEN");
  assert.equal(draft.requiredConfig[0].target, "env");
  assert.equal(draft.requiredConfig[0].secret, true);
});

// ---- createUniqueMcpServerId 去重 ----

test("createUniqueMcpServerId：slug 化与 -2/-3 递增", () => {
  assert.equal(createUniqueMcpServerId("demo-server", []), "demo-server");
  assert.equal(createUniqueMcpServerId("demo-server", ["demo-server"]), "demo-server-2");
  assert.equal(
    createUniqueMcpServerId("demo-server", ["demo-server", "demo-server-2"]),
    "demo-server-3",
  );
  assert.equal(createUniqueMcpServerId("@scope/Thing Name!", []), "thing-name");
  assert.equal(createUniqueMcpServerId("", ["x"]), "mcp-server");
});

test("withUniqueMcpServerId 重写 id 并刷新 commandPreview", () => {
  const draft = {
    server: {
      id: "demo-server",
      enabled: true,
      transport: "stdio",
      command: "npx",
      args: ["-y", "demo-server"],
      url: "",
      timeoutMs: 60_000,
    },
    status: "ready",
    requiredConfig: [],
    warnings: [],
    commandPreview: "npx -y demo-server",
  };
  const next = withUniqueMcpServerId(draft, [{ id: "demo-server" }]);
  assert.equal(next.server.id, "demo-server-2");
  assert.equal(next.commandPreview, "npx -y demo-server");
});

// ---- 必填配置回填 ----

const draftWithRequired = {
  server: {
    id: "t",
    enabled: false,
    transport: "stdio",
    command: "npx",
    args: ["-y", "pkg", "--port", "...", "--config", "{}"],
    url: "https://example.com/mcp",
    env: undefined,
    headers: undefined,
    timeoutMs: 60_000,
  },
  status: "needs_config",
  requiredConfig: [
    { name: "API_KEY", targetName: "API_KEY", required: true, secret: true, target: "env" },
    { name: "X-Token", targetName: "X-Token", required: true, secret: true, target: "header" },
    { name: "port", targetName: "port", required: true, secret: false, target: "argument" },
    { name: "q", targetName: "q", required: true, secret: false, target: "url" },
    { name: "mode", targetName: "mode", required: true, secret: false, target: "config" },
  ],
  warnings: [],
  commandPreview: "",
};

test("applyMcpRegistryInstallConfig 按 target 回填 env/header/argument/url/config", () => {
  const applied = applyMcpRegistryInstallConfig(draftWithRequired, {
    [mcpRegistryConfigInputKey(draftWithRequired.requiredConfig[0])]: "k",
    [mcpRegistryConfigInputKey(draftWithRequired.requiredConfig[1])]: "t",
    [mcpRegistryConfigInputKey(draftWithRequired.requiredConfig[2])]: "8080",
    [mcpRegistryConfigInputKey(draftWithRequired.requiredConfig[3])]: "a b",
    [mcpRegistryConfigInputKey(draftWithRequired.requiredConfig[4])]: "fast",
  });
  assert.equal(applied.status, "ready");
  assert.equal(applied.server.enabled, true);
  assert.deepEqual(applied.requiredConfig, []);
  assert.equal(applied.server.env.API_KEY, "k");
  assert.equal(applied.server.headers["X-Token"], "t");
  assert.deepEqual(applied.server.args, [
    "-y",
    "pkg",
    "--port",
    "8080",
    "--config",
    '{"mode":"fast"}',
  ]);
  const url = new URL(applied.server.url);
  assert.equal(url.searchParams.get("q"), "a b");
});

test("applyMcpRegistryInstallConfig 支持 URL 模板 {name} 替换", () => {
  const draft = {
    server: {
      id: "r",
      enabled: false,
      transport: "http",
      command: "",
      args: [],
      url: "https://example.com/{team}/mcp",
      timeoutMs: 60_000,
    },
    status: "needs_config",
    requiredConfig: [{ name: "team", targetName: "team", required: true, secret: false, target: "url" }],
    warnings: [],
    commandPreview: "",
  };
  const applied = applyMcpRegistryInstallConfig(draft, { "url:team": "a b" });
  assert.equal(applied.server.url, "https://example.com/a%20b/mcp");
});

test("未提供值的必填项保持 needs_config", () => {
  const applied = applyMcpRegistryInstallConfig(draftWithRequired, {});
  assert.equal(applied.status, "ready", "apply 后恒为 ready，缺省值不回填");
  assert.equal(applied.server.env, undefined);
  assert.ok(applied.server.args.includes("..."), "占位符保留");
});
