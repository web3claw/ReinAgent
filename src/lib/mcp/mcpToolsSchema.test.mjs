import test from "node:test";
import assert from "node:assert/strict";
import { buildMcpTool } from "./mcpTools.ts";
import { validateToolArguments } from "@earendil-works/pi-ai";

const mockServer = {
  id: "jadx",
  label: "JADX Decompiler",
  enabled: true,
  command: "jadx-mcp-server",
  args: [],
  env: {},
};

test("buildMcpTool 保留完整的 MCP 服务器 inputSchema (包含 properties 与 required)", () => {
  const jadxSchema = {
    type: "object",
    properties: {
      class_name: {
        type: "string",
        description: "Target class name to decompile",
      },
      line_number: {
        type: "integer",
        description: "Optional line number",
      },
    },
    required: ["class_name"],
  };

  const tool = buildMcpTool(mockServer, {
    serverId: "jadx",
    serverLabel: "JADX Decompiler",
    name: "get_class_source",
    description: "Get source code of decompiled class",
    inputSchema: jadxSchema,
  });

  assert.equal(tool.name, "mcp__jadx__get_class_source");
  assert.equal(tool.parameters, jadxSchema);
  assert.deepEqual(tool.parameters.required, ["class_name"]);
  assert.equal(tool.parameters.properties.class_name.type, "string");
});

test("buildMcpTool 在缺少 inputSchema 时回退为 Type.Object 兜底", () => {
  const tool = buildMcpTool(mockServer, {
    serverId: "jadx",
    serverLabel: "JADX Decompiler",
    name: "get_cache_stats",
    description: "Get decompiler cache stats",
    inputSchema: null,
  });

  assert.equal(tool.name, "mcp__jadx__get_cache_stats");
  assert.ok(tool.parameters);
  assert.equal(typeof tool.parameters, "object");
});

test("真实校验与破坏变异测试 (Red Check): validateToolArguments 对缺失必填参数精准拦截", () => {
  const jadxSchema = {
    type: "object",
    properties: {
      class_name: {
        type: "string",
      },
    },
    required: ["class_name"],
  };

  const tool = buildMcpTool(mockServer, {
    serverId: "jadx",
    serverLabel: "JADX Decompiler",
    name: "get_class_source",
    description: "Get source code",
    inputSchema: jadxSchema,
  });

  // 1. 正向验证：传必填参数通过校验
  const validCall = {
    name: tool.name,
    arguments: { class_name: "com.example.MainActivity" },
  };
  const validated = validateToolArguments(tool, validCall);
  assert.equal(validated.class_name, "com.example.MainActivity");

  // 2. 破坏变异验证 (Red Check): 模拟模型不传参数（空字典），必须真实报错而不是静默放行
  const brokenCall = {
    name: tool.name,
    arguments: {},
  };
  assert.throws(
    () => {
      validateToolArguments(tool, brokenCall);
    },
    (err) => {
      // 验证精准捕捉到缺少必填参数
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("class_name") || err.message.includes("required"),
        `Expected error to mention class_name or required, got: ${err.message}`
      );
      return true;
    }
  );
});
