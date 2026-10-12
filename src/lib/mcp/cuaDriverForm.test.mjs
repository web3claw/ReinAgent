import { describe, it, expect, beforeEach } from "bun:test";
import {
  findCuaDriverServer,
  findCuaDriverServerIndex,
  buildCuaServerConfig,
  clampCuaTimeoutMs,
  cuaCommandDrift,
  cuaDisplayCommand,
  realignCuaServerConfig,
  readCuaProbeCache,
  writeCuaProbeCache,
  resetCuaProbeCache,
  CUA_DRIVER_SERVER_ID,
  CUA_DEFAULT_TIMEOUT_MS,
  CUA_MIN_TIMEOUT_MS,
  CUA_MAX_TIMEOUT_MS,
  CUA_PROBE_CACHE_TTL_MS,
} from "./cuaDriverForm.ts";

describe("cuaDriverForm logic and helpers", () => {
  beforeEach(() => {
    resetCuaProbeCache();
  });

  it("findCuaDriverServer 能够不区分大小写和空白找到 cua-driver 条目", () => {
    const servers = [
      { id: "filesystem", enabled: true },
      { id: " CUA-DRIVER ", command: "/opt/bin/cua-driver", enabled: true },
    ];
    const found = findCuaDriverServer(servers);
    expect(found).toBeDefined();
    expect(found?.id).toBe(" CUA-DRIVER ");
    expect(findCuaDriverServerIndex(servers)).toBe(1);
  });

  it("buildCuaServerConfig 正确生成 stdio 类型的 MCP 配置", () => {
    const probe = {
      installed: true,
      path: "/usr/local/bin/cua-driver",
      mcpCommand: "/usr/local/bin/cua-driver",
      mcpArgs: ["mcp", "--log-level", "info"],
    };
    const config = buildCuaServerConfig(probe);
    expect(config.id).toBe(CUA_DRIVER_SERVER_ID);
    expect(config.enabled).toBe(true);
    expect(config.transport).toBe("stdio");
    expect(config.command).toBe("/usr/local/bin/cua-driver");
    expect(config.args).toEqual(["mcp", "--log-level", "info"]);
    expect(config.timeoutMs).toBe(CUA_DEFAULT_TIMEOUT_MS);
  });

  it("clampCuaTimeoutMs 正确限制在合法区间内", () => {
    expect(clampCuaTimeoutMs("60000", 60000)).toBe(60000);
    // 低于下限 clamp 到 MIN
    expect(clampCuaTimeoutMs("500", 60000)).toBe(CUA_MIN_TIMEOUT_MS);
    // 高于上限 clamp 到 MAX
    expect(clampCuaTimeoutMs("9999999", 60000)).toBe(CUA_MAX_TIMEOUT_MS);
    // 非法数字回落 fallback
    expect(clampCuaTimeoutMs("not a number", 60000)).toBe(60000);
  });

  it("cuaCommandDrift 能准确识别配置路径与探测路径的分叉", () => {
    const entry = { id: CUA_DRIVER_SERVER_ID, command: "/old/path/cua-driver", enabled: true };
    const probe = { installed: true, path: "/new/path/cua-driver", mcpCommand: "/new/path/cua-driver" };

    const drift = cuaCommandDrift(entry, probe);
    expect(drift).not.toBeNull();
    expect(drift?.configured).toBe("/old/path/cua-driver");
    expect(drift?.probed).toBe("/new/path/cua-driver");

    // 路径相同时无漂移
    const sameProbe = { installed: true, path: "/old/path/cua-driver", mcpCommand: "/old/path/cua-driver" };
    expect(cuaCommandDrift(entry, sameProbe)).toBeNull();
  });

  it("cuaDisplayCommand 优先显示条目中的命令，无条目时显示探测到的路径", () => {
    const entry = { id: CUA_DRIVER_SERVER_ID, command: "/custom/cua-driver", enabled: true };
    const probe = { installed: true, path: "/probed/cua-driver" };
    expect(cuaDisplayCommand(entry, probe)).toBe("/custom/cua-driver");
    expect(cuaDisplayCommand(undefined, probe)).toBe("/probed/cua-driver");
    expect(cuaDisplayCommand(undefined, null)).toBeNull();
  });

  it("realignCuaServerConfig 将已有条目的命令和参数对齐到新探测结果", () => {
    const entry = { id: CUA_DRIVER_SERVER_ID, command: "/old", args: ["old"], timeoutMs: 90000, enabled: true };
    const probe = { installed: true, path: "/fresh", mcpArgs: ["mcp", "fresh"] };
    const realigned = realignCuaServerConfig(entry, probe);
    expect(realigned.command).toBe("/fresh");
    expect(realigned.args).toEqual(["mcp", "fresh"]);
    expect(realigned.timeoutMs).toBe(90000); // 保留用户自选的超时
  });

  it("进程内探测缓存具备 TTL 超期机制", () => {
    const probe = { installed: true };
    const now = 1000000;
    writeCuaProbeCache(probe, null, now);

    // 未超期
    expect(readCuaProbeCache(now + 10000)).not.toBeNull();
    // 超出 TTL
    expect(readCuaProbeCache(now + CUA_PROBE_CACHE_TTL_MS + 1)).toBeNull();
  });
});
