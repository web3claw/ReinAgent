/**
 * hubSettingsStore —— Hub 三页（Skills / MCP / 记忆）的设置状态层。
 *
 * 对齐 LiveAgent 的 AppSettings 三个切片（settings.skills / settings.mcp /
 * settings.memory），页面props 形状保持 `settings` + `setSettings(updater)`，
 * 便于移植代码最小改动。持久化映射：
 * - skills → kv "reinagent-skills-settings"
 * - memory → kv "reinagent-memory-settings"（organizer 等配置，二期接线）
 * - mcp   → Rust 侧 ~/.ReinAgent/mcp_servers.json（mcp_save_servers/list_servers，
 *   单一真相源在 Rust；本 store 只持有内存副本，更新时整表写回）
 */

import { create } from "zustand";
import { kvGet, kvSetJSON } from "../lib/storage/db";
import { invoke } from "@tauri-apps/api/core";
import type { McpServerConfig, McpSettings } from "../lib/hub/mcpTypes";
import { applyMcpOps } from "../lib/hub/mcpTypes";

/** LA settings/types.ts SkillsSettings 同构 */
export interface SkillsSettings {
  enabled: boolean;
  selected: string[];
}

/** LA settings/types.ts MemorySettings 同构（organizer 本期仅持久化，执行引擎二期） */
export interface MemoryScheduleSettings {
  frequency: "none" | "daily" | "weekly";
  timeLocal: string;
  weekday: number;
  timezone: string;
}

export interface MemorySettings {
  organizerModel?: { customProviderId?: string; model: string } | null;
  summaryModel?: { customProviderId?: string; model: string } | null;
  organizerEnabled: boolean;
  organizerSchedule: MemoryScheduleSettings;
  organizerScope: "all" | "global" | "projects" | "current-project";
  organizerMode: "conservative" | "standard" | "aggressive";
  organizerLastRunAt?: number | null;
  organizerNextRunAt?: number | null;
}

export interface HubAppSettings {
  skills: SkillsSettings;
  mcp: McpSettings;
  memory: MemorySettings;
}

const SKILLS_KEY = "reinagent-skills-settings";
const MEMORY_KEY = "reinagent-memory-settings";

/** LA settings 默认值：skills 恒启用 + 内置技能常在 selected（builtin.ts 同值） */
const ALWAYS_ENABLED_SKILL_NAMES = ["skills-creator", "skills-installer"];

function defaultSkillsSettings(): SkillsSettings {
  const saved = kvGet(SKILLS_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as SkillsSettings;
      if (typeof parsed.enabled === "boolean" && Array.isArray(parsed.selected)) {
        // always-enabled 恒在列（对齐 LA mergeAlwaysEnabledSkillNames）
        return {
          enabled: parsed.enabled,
          selected: Array.from(new Set([...ALWAYS_ENABLED_SKILL_NAMES, ...parsed.selected])),
        };
      }
    } catch {
      // 损坏则落到默认（如实 console，不静默装作没事）
      console.error("[hubSettings] skills settings parse failed");
    }
  }
  return { enabled: true, selected: [...ALWAYS_ENABLED_SKILL_NAMES] };
}

function defaultMemorySettings(): MemorySettings {
  const saved = kvGet(MEMORY_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as Partial<MemorySettings>;
      return { ...defaultMemoryShape(), ...parsed };
    } catch {
      console.error("[hubSettings] memory settings parse failed");
    }
  }
  return defaultMemoryShape();
}

function defaultMemoryShape(): MemorySettings {
  return {
    organizerModel: null,
    summaryModel: null,
    organizerEnabled: false,
    organizerSchedule: { frequency: "none", timeLocal: "03:00", weekday: 1, timezone: "local" },
    organizerScope: "all",
    organizerMode: "standard",
    organizerLastRunAt: null,
    organizerNextRunAt: null,
  };
}

/** MCP 工具枚举失败通知（发送链路产生；UI 层订阅后 toast，内存态不持久化） */
export interface McpEnumNotice {
  message: string;
  at: number;
}

interface HubSettingsState {
  mcpEnumNotice: McpEnumNotice | null;
  setMcpEnumNotice: (message: string) => void;
  settings: HubAppSettings;
  /** 启动/首次进入 Hub 时装载 MCP 服务器列表（Rust JSON 为真相源） */
  hydrateMcp: () => Promise<void>;
  setSettings: (updater: (prev: HubAppSettings) => HubAppSettings) => void;
  /** LA updateMcp 同语义便捷入口（applyMcpOps + 写盘） */
  updateMcpOps: (ops: Parameters<typeof applyMcpOps>[1]) => void;
}

export const useHubSettings = create<HubSettingsState>((set, get) => ({
  mcpEnumNotice: null,
  setMcpEnumNotice: (message) => set({ mcpEnumNotice: { message, at: Date.now() } }),
  settings: {
    skills: defaultSkillsSettings(),
    mcp: { servers: [], selected: [] },
    memory: defaultMemorySettings(),
  },

  hydrateMcp: async () => {
    try {
      const servers = await invoke<McpServerConfig[]>("mcp_list_servers");
      set((state) => ({
        settings: {
          ...state.settings,
          // serverPolicy 是纯前端字段，从上一份 mcp 切片保留（hydrate 不覆盖用户配置）
          mcp: { servers, selected: [], serverPolicy: state.settings.mcp.serverPolicy },
        },
      }));
    } catch (err) {
      // Web/无头环境后端不可达：保留空列表（页面会用空态），如实告警
      console.warn("[hubSettings] mcp_list_servers unavailable:", err);
    }
  },

  setSettings: (updater) => {
    const next = updater(get().settings);
    // skills / memory 切片写透 kv
    kvSetJSON(SKILLS_KEY, next.skills);
    kvSetJSON(MEMORY_KEY, next.memory);
    // mcp 切片整表写回 Rust（防抖由调用频度决定：页面级操作非高频，直接写）
    void invoke("mcp_save_servers", { servers: next.mcp.servers }).catch((err) =>
      console.error("[hubSettings] mcp_save_servers failed:", err),
    );
    set({ settings: next });
  },

  updateMcpOps: (ops) => {
    const prev = get().settings;
    const mcp = applyMcpOps(prev.mcp, ops);
    kvSetJSON(SKILLS_KEY, prev.skills);
    void invoke("mcp_save_servers", { servers: mcp.servers }).catch((err) =>
      console.error("[hubSettings] mcp_save_servers failed:", err),
    );
    set({ settings: { ...prev, mcp } });
  },
}));
