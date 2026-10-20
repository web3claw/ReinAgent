import { normalizeMcpServerConfig, type McpServerConfig, type McpTransport } from "../hub/mcpTypes";

export type McpJsonImportErrorKey =
  | "mcpHub.importJsonFormatError"
  | "mcpHub.importJsonBareServerError"
  | "mcpHub.importJsonUrlRequiredError"
  | "mcpHub.importJsonStdioCommandRequiredError";

export type ParsedMcpJsonServer = {
  id: string;
  description: string;
  transport: McpTransport;
  command: string;
  args: string[];
  env?: Record<string, string>;
  url: string;
  headers?: Record<string, string>;
  originalConfig: Record<string, unknown>;
};

export type McpJsonImportResult =
  | {
      isValid: true;
      servers: ParsedMcpJsonServer[];
    }
  | {
      isValid: false;
      errorKey: McpJsonImportErrorKey;
    };

const IMPORTED_DESCRIPTION = "Imported from JSON";

const SPLITTABLE_STDIO_LAUNCHERS = new Set([
  "npx",
  "pnpx",
  "bunx",
  "uvx",
  "uv",
  "node",
  "python",
  "python3",
  "deno",
]);

export const shellSplit = (input: string): string[] => {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (char === "\\" && quote === '"' && index + 1 < input.length) {
        current += input[index + 1];
        index += 1;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "\\" && index + 1 < input.length) {
      current += input[index + 1];
      index += 1;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
};

export const normalizeStdioCommand = (command: string, args?: string[]) => {
  const trimmed = command.trim();
  if (trimmed.length === 0 || (Array.isArray(args) && args.length > 0)) {
    return {
      command,
      args: args || [],
    };
  }

  const firstToken = trimmed.split(/\s+/)[0]?.replace(/^['"]|['"]$/g, "");
  if (!firstToken || !SPLITTABLE_STDIO_LAUNCHERS.has(firstToken) || !/\s/.test(trimmed)) {
    return {
      command,
      args: args || [],
    };
  }

  const tokens = shellSplit(trimmed);
  if (tokens.length < 2) {
    return {
      command,
      args: args || [],
    };
  }

  return {
    command: tokens[0],
    args: tokens.slice(1),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const hasOwn = (value: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const nonEmptyString = (value: unknown): string | undefined => {
  const text = stringOrUndefined(value);
  return text?.trim() ? text : undefined;
};

const toStringRecord = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) return undefined;

  const entries = Object.entries(value);
  if (!entries.every(([, item]) => typeof item === "string")) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
};

const normalizeArgs = (value: unknown): string[] | undefined => {
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  return undefined;
};

const looksLikeBareServer = (value: Record<string, unknown>): boolean =>
  ["command", "args", "env", "url", "headers", "type", "transport", "description"].some((key) =>
    hasOwn(value, key),
  );

const normalizeArrayServer = (
  serverItem: unknown,
):
  | { isValid: true; name: string; config: Record<string, unknown> }
  | { isValid: false; errorKey: McpJsonImportErrorKey } => {
  if (!isRecord(serverItem)) {
    return { isValid: false, errorKey: "mcpHub.importJsonFormatError" };
  }

  const name = nonEmptyString(serverItem.name ?? serverItem.id);
  if (!name) {
    return { isValid: false, errorKey: "mcpHub.importJsonFormatError" };
  }

  const { name: _name, id: _id, ...config } = serverItem;
  return { isValid: true, name, config };
};

const parseTransport = (
  config: Record<string, unknown>,
):
  | {
      isValid: true;
      transport: McpTransport;
      command: string;
      args: string[];
      env?: Record<string, string>;
      url: string;
      headers?: Record<string, string>;
    }
  | { isValid: false; errorKey: McpJsonImportErrorKey } => {
  const transportObject = isRecord(config.transport) ? config.transport : undefined;
  const transportConfig = transportObject ?? config;
  const typeFromTransport = transportObject?.type ?? config.transport;
  const transportType = stringOrUndefined(config.type ?? typeFromTransport);

  if (hasOwn(transportConfig, "command") || transportType === "stdio") {
    const rawCommand = nonEmptyString(transportConfig.command);
    if (!rawCommand) {
      return { isValid: false, errorKey: "mcpHub.importJsonStdioCommandRequiredError" };
    }

    const rawArgs = normalizeArgs(transportConfig.args);
    if (!rawArgs) {
      return { isValid: false, errorKey: "mcpHub.importJsonFormatError" };
    }

    const normalized = normalizeStdioCommand(rawCommand, rawArgs);

    return {
      isValid: true,
      transport: "stdio",
      command: normalized.command,
      args: normalized.args,
      env: toStringRecord(transportConfig.env),
      url: "",
    };
  }

  const url = nonEmptyString(transportConfig.url ?? config.url);
  if (!url) {
    return { isValid: false, errorKey: "mcpHub.importJsonUrlRequiredError" };
  }

  const normalizedType: McpTransport =
    transportType === "sse" || url.includes("/sse") ? "sse" : "http";

  return {
    isValid: true,
    transport: normalizedType,
    command: "",
    args: [],
    url,
    headers: toStringRecord(transportConfig.headers ?? config.headers),
  };
};

const parseServer = (
  name: string,
  config: Record<string, unknown>,
): { isValid: true; server: ParsedMcpJsonServer } | { isValid: false; errorKey: McpJsonImportErrorKey } => {
  const transportResult = parseTransport(config);
  if (transportResult.isValid === false) return transportResult;

  return {
    isValid: true,
    server: {
      id: name,
      description: stringOrUndefined(config.description) || IMPORTED_DESCRIPTION,
      transport: transportResult.transport,
      command: transportResult.command,
      args: transportResult.args,
      env: transportResult.env,
      url: transportResult.url,
      headers: transportResult.headers,
      originalConfig: config,
    },
  };
};

export const parseMcpJsonImport = (config: unknown): McpJsonImportResult => {
  const rawServers =
    isRecord(config) && hasOwn(config, "mcpServers") ? config.mcpServers : config;

  if (Array.isArray(rawServers)) {
    const servers: ParsedMcpJsonServer[] = [];
    for (const rawServer of rawServers) {
      const normalized = normalizeArrayServer(rawServer);
      if (normalized.isValid === false) return normalized;

      const parsed = parseServer(normalized.name, normalized.config);
      if (parsed.isValid === false) return parsed;

      servers.push(parsed.server);
    }

    return servers.length > 0
      ? { isValid: true, servers }
      : { isValid: false, errorKey: "mcpHub.importJsonFormatError" };
  }

  if (!isRecord(rawServers)) {
    return { isValid: false, errorKey: "mcpHub.importJsonFormatError" };
  }

  if (rawServers === config && looksLikeBareServer(rawServers)) {
    return { isValid: false, errorKey: "mcpHub.importJsonBareServerError" };
  }

  const servers: ParsedMcpJsonServer[] = [];
  for (const [name, serverConfig] of Object.entries(rawServers)) {
    if (!name.trim() || !isRecord(serverConfig)) {
      return { isValid: false, errorKey: "mcpHub.importJsonFormatError" };
    }

    const parsed = parseServer(name, serverConfig);
    if (parsed.isValid === false) return parsed;

    servers.push(parsed.server);
  }

  return servers.length > 0
    ? { isValid: true, servers }
    : { isValid: false, errorKey: "mcpHub.importJsonFormatError" };
};

/** 将解析结果转为 ReinAgent 的 McpServerConfig，处理冲突 ID 并归一化 */
export function toMcpServerConfigs(
  servers: ParsedMcpJsonServer[],
  existingServers: McpServerConfig[] = [],
): McpServerConfig[] {
  const usedIds = new Set(existingServers.map((s) => s.id.trim().toLowerCase()));

  return servers.map((item) => {
    let targetId = item.id.trim();
    if (usedIds.has(targetId.toLowerCase())) {
      let counter = 2;
      while (usedIds.has(`${targetId.toLowerCase()}-${counter}`)) {
        counter += 1;
      }
      targetId = `${targetId}-${counter}`;
    }
    usedIds.add(targetId.toLowerCase());

    return normalizeMcpServerConfig({
      id: targetId,
      description: item.description,
      enabled: true,
      transport: item.transport,
      command: item.command,
      args: item.args,
      env: item.env,
      url: item.url,
      headers: item.headers,
      timeoutMs: 60000,
    });
  });
}
