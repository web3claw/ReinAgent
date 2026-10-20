import { describe, expect, it } from "bun:test";
import {
  parseMcpJsonImport,
  normalizeStdioCommand,
  shellSplit,
  toMcpServerConfigs,
} from "./mcpJsonImport.ts";

describe("mcpJsonImport", () => {
  it("rejects a bare server object instead of treating fields as server names", () => {
    const result = parseMcpJsonImport({
      command: "npx",
      args: ["-y", "@playwright/mcp"],
    });

    expect(result).toEqual({
      isValid: false,
      errorKey: "mcpHub.importJsonBareServerError",
    });
  });

  it("rejects stdio server config missing command", () => {
    const result = parseMcpJsonImport({
      mcpServers: {
        bad_stdio: {
          transport: "stdio",
          args: ["foo"],
        },
      },
    });

    expect(result).toEqual({
      isValid: false,
      errorKey: "mcpHub.importJsonStdioCommandRequiredError",
    });
  });

  it("rejects http/sse server config missing url", () => {
    const result = parseMcpJsonImport({
      mcpServers: {
        bad_http: {
          type: "http",
        },
      },
    });

    expect(result).toEqual({
      isValid: false,
      errorKey: "mcpHub.importJsonUrlRequiredError",
    });
  });

  it("rejects non-object or empty payload", () => {
    expect(parseMcpJsonImport(null)).toEqual({
      isValid: false,
      errorKey: "mcpHub.importJsonFormatError",
    });
    expect(parseMcpJsonImport("not json")).toEqual({
      isValid: false,
      errorKey: "mcpHub.importJsonFormatError",
    });
    expect(parseMcpJsonImport({})).toEqual({
      isValid: false,
      errorKey: "mcpHub.importJsonFormatError",
    });
  });

  it("parses mcpServers stdio configs", () => {
    const result = parseMcpJsonImport({
      mcpServers: {
        playwright: {
          command: "npx",
          args: ["-y", "@playwright/mcp"],
          env: { DEBUG: "pw:api" },
          description: "Playwright browser automation",
        },
      },
    });

    expect(result.isValid).toBe(true);
    if (!result.isValid) return;
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]).toMatchObject({
      id: "playwright",
      description: "Playwright browser automation",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp"],
      env: { DEBUG: "pw:api" },
    });
  });

  it("normalizes launcher command with inline arguments and quotes", () => {
    const split = shellSplit('uv --directory "/path/to/my folder" run weather.py');
    expect(split).toEqual(["uv", "--directory", "/path/to/my folder", "run", "weather.py"]);

    const normalized = normalizeStdioCommand('uv --directory "/path/to/my folder" run weather.py');
    expect(normalized).toEqual({
      command: "uv",
      args: ["--directory", "/path/to/my folder", "run", "weather.py"],
    });

    const result = parseMcpJsonImport({
      mcpServers: {
        weather: {
          command: 'uv --directory "/path/to/weather" run weather.py',
          description: "Weather information server",
        },
      },
    });

    expect(result.isValid).toBe(true);
    if (!result.isValid) return;
    expect(result.servers[0].command).toBe("uv");
    expect(result.servers[0].args).toEqual(["--directory", "/path/to/weather", "run", "weather.py"]);
  });

  it("maps streamable_http to http and detects /sse endpoint", () => {
    const result = parseMcpJsonImport({
      mcpServers: {
        streamable: {
          type: "streamable_http",
          url: "https://example.com/api/mcp",
          headers: { Authorization: "Bearer token" },
        },
        sse_endpoint: {
          url: "https://example.com/mcp/sse",
        },
      },
    });

    expect(result.isValid).toBe(true);
    if (!result.isValid) return;
    expect(result.servers).toHaveLength(2);
    expect(result.servers[0].transport).toBe("http");
    expect(result.servers[1].transport).toBe("sse");
  });

  it("parses array format server configs", () => {
    const result = parseMcpJsonImport([
      {
        name: "tool_a",
        command: "python",
        args: ["main.py"],
      },
      {
        name: "tool_b",
        url: "http://localhost:8000/sse",
      },
    ]);

    expect(result.isValid).toBe(true);
    if (!result.isValid) return;
    expect(result.servers).toHaveLength(2);
    expect(result.servers[0].id).toBe("tool_a");
    expect(result.servers[1].id).toBe("tool_b");
  });

  it("converts to ReinAgent McpServerConfig and handles duplicate ID resolution", () => {
    const parseResult = parseMcpJsonImport({
      mcpServers: {
        weather: {
          command: "uvx",
          args: ["weather-mcp"],
        },
      },
    });

    expect(parseResult.isValid).toBe(true);
    if (!parseResult.isValid) return;

    const existing = [
      {
        id: "weather",
        enabled: true,
        transport: "stdio",
        command: "old",
        args: [],
        url: "",
        timeoutMs: 60000,
      },
    ];

    const configs = toMcpServerConfigs(parseResult.servers, existing);
    expect(configs).toHaveLength(1);
    expect(configs[0].id).toBe("weather-2");
    expect(configs[0].enabled).toBe(true);
    expect(configs[0].transport).toBe("stdio");
    expect(configs[0].command).toBe("uvx");
    expect(configs[0].args).toEqual(["weather-mcp"]);
  });

  it("真实场景与破坏变异测试 (Red Check): 缺少有效服务器必须被精准拦截", () => {
    // 破坏性输入：空 mcpServers 对象
    const breakResult = parseMcpJsonImport({ mcpServers: {} });
    expect(breakResult.isValid).toBe(false);
    if (!breakResult.isValid) {
      expect(breakResult.errorKey).toBe("mcpHub.importJsonFormatError");
    }

    // 破坏性输入：非对象的无效 server 节点
    const breakResult2 = parseMcpJsonImport({ mcpServers: { broken: null } });
    expect(breakResult2.isValid).toBe(false);
    if (!breakResult2.isValid) {
      expect(breakResult2.errorKey).toBe("mcpHub.importJsonFormatError");
    }
  });
});
