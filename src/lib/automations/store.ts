/**
 * automations/store —— 自动化定时任务的 zustand 状态（对齐 ZCode
 * automationManagementStore 的职责面：列表缓存 + CRUD + 过期响应守卫）。
 * IPC 命令由 Rust `automation.rs` 提供。
 */

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Automation, AutomationDuePayload, AutomationUpsert } from "./types";

interface AutomationState {
  automations: Automation[];
  loading: boolean;
  error: string | null;
  /** 递增序号：慢响应丢弃（切页前发出的 list 晚到不覆盖新数据） */
  loadSeq: number;
  /** silent=true：定时轮询/派发后的自动刷新，不触发 loading 态（图标不闪烁） */
  refresh: (silent?: boolean) => Promise<void>;
  create: (upsert: AutomationUpsert) => Promise<Automation>;
  update: (automationId: string, upsert: AutomationUpsert) => Promise<Automation>;
  remove: (automationId: string) => Promise<void>;
  setEnabled: (automationId: string, enabled: boolean) => Promise<void>;
  /** 立即运行：创建 manual 运行并返回派发负载（由调用方执行派发） */
  runNow: (automationId: string) => Promise<AutomationDuePayload>;
}

export const useAutomationStore = create<AutomationState>((set, get) => ({
  automations: [],
  loading: false,
  error: null,
  loadSeq: 0,

  refresh: async (silent = false) => {
    const seq = get().loadSeq + 1;
    // silent 模式（定时轮询/派发后的自动刷新）不触发 loading 态，避免刷新图标频繁闪烁
    set({ loading: !silent, loadSeq: seq });
    try {
      const list = await invoke<Automation[]>("automation_list");
      if (get().loadSeq === seq) {
        set({ automations: list, loading: false, error: null });
      }
    } catch (err) {
      if (get().loadSeq === seq) {
        set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  },

  create: async (upsert) => {
    const created = await invoke<Automation>("automation_create", { upsert });
    await get().refresh();
    return created;
  },

  update: async (automationId, upsert) => {
    const updated = await invoke<Automation>("automation_update", { automationId, upsert });
    await get().refresh();
    return updated;
  },

  remove: async (automationId) => {
    await invoke("automation_delete", { automationId });
    await get().refresh();
  },

  setEnabled: async (automationId, enabled) => {
    await invoke("automation_set_enabled", { automationId, enabled });
    await get().refresh();
  },

  runNow: async (automationId) => {
    return invoke<AutomationDuePayload>("automation_run_now", { automationId });
  },
}));
