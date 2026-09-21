import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface TerminalSessionHandle {
  id: number;
  write: (data: string) => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  close: () => Promise<void>;
}

export async function createTerminalSession(options: {
  cols: number;
  rows: number;
  cwd?: string;
  onData: (data: string) => void;
}): Promise<TerminalSessionHandle> {
  const { cols, rows, cwd, onData } = options;

  let id: number;
  try {
    id = await invoke<number>("terminal_create", {
      cols,
      rows,
      cwd: cwd || null,
    });
  } catch (err) {
    console.error("Failed to create terminal session via Tauri:", err);
    throw err;
  }

  let unlisten: UnlistenFn | null = null;
  try {
    unlisten = await listen<string>(`terminal-data-${id}`, (event) => {
      onData(event.payload);
    });
  } catch (err) {
    console.error(`Failed to listen to terminal-data-${id}:`, err);
  }

  return {
    id,
    write: async (data: string) => {
      await invoke("terminal_write", { id, data });
    },
    resize: async (newCols: number, newRows: number) => {
      await invoke("terminal_resize", { id, cols: newCols, rows: newRows });
    },
    close: async () => {
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
      await invoke("terminal_close", { id }).catch(() => {});
    },
  };
}
