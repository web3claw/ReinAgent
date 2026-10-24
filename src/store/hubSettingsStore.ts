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
import { markBackupDirty } from "../lib/backup/backupSync";

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
}

export interface MemorySettings {
  organizerModel?: { customProviderId?: string; model: string } | null;
  organizerEnabled: boolean;
  organizerSchedule: MemoryScheduleSettings;
  organizerScope: "all" | "global" | "projects" | "current-project";
  organizerMode: "conservative" | "standard" | "aggressive";
  organizerLastRunAt?: number | null;
  organizerNextRunAt?: number | null;
  /** 记忆升级包：Dream 数值巩固开关（24h 自动 + 手动；纯数值零 token） */
  dreamEnabled: boolean;
}

/** 知识库（RAG v1，docs/ROADMAP.md ①）：embedding 绑定 + 注入参数 */
export interface KnowledgeSettings {
  /** 绑定服务商 id（provider_config.json 中的 provider.id） */
  providerId: string;
  /** embedding 模型 id（如 Ollama 的 bge-m3；手填，不依赖 /models 列表） */
  modelId: string;
  /** 任务未显式选择时的注入默认值（composer「知识库」开关的草稿态） */
  injectEnabledGlobal: boolean;
  /** 注入/检索 topK（1-20） */
  topK: number;
}

/** 会话级 worktree 隔离（ROADMAP ②）全局默认 */
export interface WorktreeSettings {
  /** 新任务默认启用 worktree 隔离（仅 git 仓库生效；任务级显式选择优先） */
  enabledByDefault: boolean;
}

export interface HubAppSettings {
  skills: SkillsSettings;
  mcp: McpSettings;
  memory: MemorySettings;
  knowledge: KnowledgeSettings;
  worktree: WorktreeSettings;
}

const SKILLS_KEY = "reinagent-skills-settings";
const MEMORY_KEY = "reinagent-memory-settings";
const KNOWLEDGE_KEY = "reinagent-knowledge-settings";
const WORKTREE_KEY = "reinagent-worktree-settings";

/**
 * 旧版「恒启用」内置技能名（迁移用）：2026-10-06 之前这两枚会被强制并入 selected；
 * 现改为普通启用语义、默认禁用——加载时剔除遗留污染并写回一次，尊重用户显式选择。
 */
const LEGACY_ALWAYS_ENABLED_SKILL_NAMES = ["skills-creator", "skills-installer"];

function defaultSkillsSettings(): SkillsSettings {
  const saved = kvGet(SKILLS_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as SkillsSettings;
      if (typeof parsed.enabled === "boolean" && Array.isArray(parsed.selected)) {
        const cleaned = Array.from(
          new Set(
            parsed.selected
              .map((name) => String(name).trim())
              .filter(
                (name) => name.length > 0 && !LEGACY_ALWAYS_ENABLED_SKILL_NAMES.includes(name),
              ),
          ),
        );
        if (cleaned.length !== parsed.selected.length) {
          kvSetJSON(SKILLS_KEY, { enabled: parsed.enabled, selected: cleaned });
        }
        return { enabled: parsed.enabled, selected: cleaned };
      }
    } catch {
      // 损坏则落到默认（如实 console，不静默装作没事）
      console.error("[hubSettings] skills settings parse failed");
    }
  }
  // 全局开关缺省开；选中列表缺省为空 ⇒ 内置技能默认禁用（用户定稿 2026-10-06）
  return { enabled: true, selected: [] };
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
    organizerEnabled: false,
    organizerSchedule: { frequency: "none", timeLocal: "03:00", weekday: 1 },
    organizerScope: "all",
    organizerMode: "standard",
    organizerLastRunAt: null,
    organizerNextRunAt: null,
    dreamEnabled: true,
  };
}

function defaultKnowledgeSettings(): KnowledgeSettings {
  const saved = kvGet(KNOWLEDGE_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as Partial<KnowledgeSettings>;
      return { ...defaultKnowledgeShape(), ...parsed };
    } catch {
      console.error("[hubSettings] knowledge settings parse failed");
    }
  }
  return defaultKnowledgeShape();
}

function defaultWorktreeSettings(): WorktreeSettings {
  const saved = kvGet(WORKTREE_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as Partial<WorktreeSettings>;
      return { ...defaultWorktreeShape(), ...parsed };
    } catch {
      console.error("[hubSettings] worktree settings parse failed");
    }
  }
  return defaultWorktreeShape();
}

function defaultWorktreeShape(): WorktreeSettings {
  return {
    enabledByDefault: false,
  };
}

function defaultKnowledgeShape(): KnowledgeSettings {
  return {
    providerId: "",
    modelId: "",
    injectEnabledGlobal: false,
    topK: 5,
  };
}

/**
 * 启动水合（main.tsx bootstrap 在 initStorage 之后调用）：本 store 创建于模块
 * 求值期，早于 kv 缓存填充——skills/memory/knowledge 三切片的 kv 初值在创建时
 * 读到的恒为空（潜在 bug，2026-10-24 知识库绑定 E2E 实证），必须在启动时补读。
 */
export function rehydrateHubKvSlices(): void {
  useHubSettings.setState((prev) => ({
    settings: {
      ...prev.settings,
      skills: defaultSkillsSettings(),
      memory: defaultMemorySettings(),
      knowledge: defaultKnowledgeSettings(),
      worktree: defaultWorktreeSettings(),
    },
  }));
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
  /**
   * F19：MCP 配置读取失败态（文件损坏等）。非 null 时**禁止任何整表回写**
   * （setSettings / updateMcpOps 一律跳过 mcp_save_servers），避免把内存里的
   * 空表覆盖到磁盘，丢失用户真实的 MCP 配置。null = 正常。
   */
  mcpDegradedError: string | null;
  /** 启动/首次进入 Hub 时装载 MCP 服务器列表（Rust JSON 为真相源） */
  hydrateMcp: () => Promise<void>;
  setSettings: (updater: (prev: HubAppSettings) => HubAppSettings) => void;
  /** LA updateMcp 同语义便捷入口（applyMcpOps + 写盘） */
  updateMcpOps: (ops: Parameters<typeof applyMcpOps>[1]) => void;
}

export const useHubSettings = create<HubSettingsState>((set, get) => ({
  mcpEnumNotice: null,
  setMcpEnumNotice: (message) => set({ mcpEnumNotice: { message, at: Date.now() } }),
  mcpDegradedError: null,
  settings: {
    skills: defaultSkillsSettings(),
    mcp: { servers: [] },
    memory: defaultMemorySettings(),
    knowledge: defaultKnowledgeSettings(),
    worktree: defaultWorktreeSettings(),
  },

  hydrateMcp: async () => {
    try {
      const servers = await invoke<McpServerConfig[]>("mcp_list_servers");
      set((state) => ({
        mcpDegradedError: null,
        settings: {
          ...state.settings,
          mcp: { servers },
        },
      }));
    } catch (err) {
      // F19：后端把「文件损坏/读取失败」与「无服务器」区分开了——这里收到的 Err
      // 意味着磁盘上的配置出了问题，进入 degraded 态：保留空列表，但**禁止写盘**，
      // 并如实上抛错误供 UI 显示横幅（不再静默吞掉）。
      const message = err instanceof Error ? err.message : String(err);
      console.error("[hubSettings] mcp_list_servers 读取失败（进入保护态，禁止回写）:", message);
      set({ mcpDegradedError: message });
    }
  },

  setSettings: (updater) => {
    const next = updater(get().settings);
    // skills / memory / knowledge 切片写透 kv
    kvSetJSON(SKILLS_KEY, next.skills);
    kvSetJSON(MEMORY_KEY, next.memory);
    kvSetJSON(KNOWLEDGE_KEY, next.knowledge);
    kvSetJSON(WORKTREE_KEY, next.worktree);
    // mcp 切片整表写回 Rust（防抖由调用频度决定：页面级操作非高频，直接写）
    // F19：读取失败态下跳过写盘，避免用空表覆盖用户真实配置。
    if (get().mcpDegradedError) {
      console.error("[hubSettings] MCP 处于读取失败保护态，跳过 mcp_save_servers");
    } else {
      void invoke("mcp_save_servers", { servers: next.mcp.servers }).catch((err) =>
        console.error("[hubSettings] mcp_save_servers failed:", err),
      );
    }
    // 备份标脏：skills（kv）与 mcp（Rust 文件）都是快照域；memory 切片不是。
    markBackupDirty();
    set({ settings: next });
  },

  updateMcpOps: (ops) => {
    const prev = get().settings;
    const mcp = applyMcpOps(prev.mcp, ops);
    kvSetJSON(SKILLS_KEY, prev.skills);
    // F19：同上，读取失败保护态下禁止整表写盘。
    if (get().mcpDegradedError) {
      console.error("[hubSettings] MCP 处于读取失败保护态，跳过 mcp_save_servers");
    } else {
      void invoke("mcp_save_servers", { servers: mcp.servers }).catch((err) =>
        console.error("[hubSettings] mcp_save_servers failed:", err),
      );
    }
    markBackupDirty();
    set({ settings: { ...prev, mcp } });
  },
}));
