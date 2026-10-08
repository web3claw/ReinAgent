import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const DEFAULT_UPDATE_ENDPOINT =
  "https://github.com/web3claw/ReinAgent/releases/latest/download/latest.json";

export type AppUpdateStatus =
  | "idle"
  | "checking"
  | "downloading"
  | "ready"
  | "error_check"
  | "error_download";

export interface UpdateProgressPayload {
  percent: number;
  downloaded: number;
  total: number;
}

export interface CheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  availableVersion?: string;
  notes?: string;
  pubDate?: string;
}

export function isTauriEnvironment(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

interface AppUpdateStoreState {
  status: AppUpdateStatus;
  percent: number;
  currentVersion: string;
  availableVersion?: string;
  notes?: string;
  errorMessage?: string;
  hasAutoChecked: boolean;

  initListener: () => () => void;
  checkAndAutoDownload: () => Promise<void>;
  retry: () => Promise<void>;
  restart: () => Promise<void>;
  setCurrentVersion: (version: string) => void;
}

export const useAppUpdateStore = create<AppUpdateStoreState>((set, get) => ({
  status: "idle",
  percent: 0,
  currentVersion: "",
  availableVersion: undefined,
  notes: undefined,
  errorMessage: undefined,
  hasAutoChecked: false,

  setCurrentVersion: (version: string) => set({ currentVersion: version }),

  initListener: () => {
    if (!isTauriEnvironment()) {
      return () => {};
    }

    let unlisten: (() => void) | undefined;
    void listen<UpdateProgressPayload>("update-progress", (event) => {
      const p = Math.max(0, Math.min(100, Math.round(event.payload.percent)));
      set({ percent: p });
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);

    return () => {
      if (unlisten) unlisten();
    };
  },

  checkAndAutoDownload: async () => {
    const state = get();
    if (state.status === "downloading" || state.status === "ready") {
      return;
    }

    set({
      status: "checking",
      percent: 0,
      errorMessage: undefined,
      hasAutoChecked: true,
    });

    if (!isTauriEnvironment()) {
      set({ status: "idle" });
      return;
    }

    try {
      const res = await invoke<CheckResult>("update_check", {
        args: { feed: DEFAULT_UPDATE_ENDPOINT },
      });

      if (!res.hasUpdate) {
        set({
          status: "idle",
          currentVersion: res.currentVersion || state.currentVersion,
        });
        return;
      }

      // 发现新版本，自动开启下载（defer_restart 延后重启）
      set({
        status: "downloading",
        percent: 0,
        availableVersion: res.availableVersion,
        notes: res.notes,
        currentVersion: res.currentVersion || state.currentVersion,
      });

      try {
        await invoke("update_install", {
          args: {
            feed: DEFAULT_UPDATE_ENDPOINT,
            defer_restart: true,
          },
        });
        set({
          status: "ready",
          percent: 100,
        });
      } catch (dlErr) {
        set({
          status: "error_download",
          errorMessage: String(dlErr),
        });
      }
    } catch (checkErr) {
      set({
        status: "error_check",
        errorMessage: String(checkErr),
      });
    }
  },

  retry: async () => {
    const { status, availableVersion } = get();
    if (status === "error_download" && availableVersion) {
      // 重新下载更新
      set({
        status: "downloading",
        percent: 0,
        errorMessage: undefined,
      });

      if (!isTauriEnvironment()) {
        set({ status: "ready", percent: 100 });
        return;
      }

      try {
        await invoke("update_install", {
          args: {
            feed: DEFAULT_UPDATE_ENDPOINT,
            defer_restart: true,
          },
        });
        set({
          status: "ready",
          percent: 100,
        });
      } catch (err) {
        set({
          status: "error_download",
          errorMessage: String(err),
        });
      }
    } else {
      // 重新检查更新
      await get().checkAndAutoDownload();
    }
  },

  restart: async () => {
    if (!isTauriEnvironment()) {
      console.warn("Web environment, restart simulated");
      return;
    }

    try {
      await invoke("update_restart");
    } catch (err) {
      console.error("update_restart failed:", err);
    }
  },
}));
