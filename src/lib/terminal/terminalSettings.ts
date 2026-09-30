/**
 * terminalSettings —— 终端 Shell 配置（P2-G2 尾巴，精简版：仅 Shell）。
 *
 * 存 kv `reinagent-terminal-settings`（{shell}）；TerminalPane 挂载时传给
 * terminal_create——空 = 平台默认（win: powershell.exe / unix: $SHELL）。
 */

import { kvGet, kvSet } from "../storage/db";

const SETTINGS_KEY = "reinagent-terminal-settings";

export interface TerminalSettings {
  /** PTY shell 可执行文件路径；空 = 平台默认 */
  shell: string;
}

export function getTerminalSettings(): TerminalSettings {
  try {
    const raw = kvGet(SETTINGS_KEY);
    if (!raw) return { shell: "" };
    const parsed = JSON.parse(raw) as Partial<TerminalSettings>;
    return { shell: typeof parsed.shell === "string" ? parsed.shell : "" };
  } catch {
    return { shell: "" };
  }
}

export function saveTerminalSettings(settings: TerminalSettings): void {
  kvSet(SETTINGS_KEY, JSON.stringify({ shell: settings.shell.trim() }));
}
