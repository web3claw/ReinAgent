/**
 * previewPlatform —— PreviewPane 的 IPlatformService 宿主实现（Tauri）。
 * openInEditor / openInFileManager 走 tauri-plugin-opener（系统默认应用 / 资源管理器）；
 * 远端 workspace 宿主不支持，connectRemote 如实返回失败。
 */
import { openPath } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import type { IPlatformService } from "./shared";

export const previewPlatform: IPlatformService = {
  async selectDirectory() {
    try {
      return await invoke<string | null>("fs_pick_folder");
    } catch {
      return null;
    }
  },

  async connectRemote() {
    return { success: false, error: "远程工作区在当前宿主中不可用" };
  },

  async openInEditor(editorIdOrInput, openPathArg) {
    const target =
      typeof editorIdOrInput === "string" ? openPathArg : editorIdOrInput.path;
    if (!target) {
      return { success: false, error: "缺少文件路径" };
    }
    try {
      await openPath(target);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  async openInFileManager(path) {
    try {
      await openPath(path);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  async getInstalledEditors() {
    return [];
  },
};
