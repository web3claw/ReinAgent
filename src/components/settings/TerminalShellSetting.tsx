/**
 * TerminalShellSetting —— 基础配置里的终端 Shell 行（P2-G2 尾巴）。
 *
 * **零写死路径**：可用 shell 由 Rust `shell_detect` 经系统 where/which 从 PATH
 * 实时解析（Windows: pwsh/powershell/cmd/bash；unix: bash/zsh/fish/sh），
 * 未命中 name 的条目不出现在下拉；登录默认 $SHELL（unix）对应的候选排最前。
 * 下拉必须有确定选中值（未配置 = 首个可用）；另有自定义路径兜底入口。
 * 保存写 kv，新建终端面板生效。
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "../../i18n";
import { getTerminalSettings, saveTerminalSettings } from "../../lib/terminal/terminalSettings";
import { getOsInfo } from "../../lib/system/systemInfo";

interface ResolvedShell {
  /** shell 简名（pwsh / powershell / cmd / bash / zsh / fish / sh） */
  name: string;
  /** PATH 解析出的绝对路径 */
  path: string;
}

/** 简名 → 展示名（检测到的按解析结果展示，无写死映射表）。 */
function shellDisplayName(name: string): string {
  switch (name) {
    case "pwsh":
      return "PowerShell 7";
    case "powershell":
      return "Windows PowerShell";
    case "cmd":
      return "CMD";
    default:
      return name;
  }
}

export function TerminalShellSetting() {
  const { t } = useTranslation();
  const tt = t as (key: string) => string;
  const [shell, setShell] = useState("");
  const [preset, setPreset] = useState<string | null>(null);
  const [available, setAvailable] = useState<ResolvedShell[] | null>(null);
  const [osLabel, setOsLabel] = useState<string>("");
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(async () => {
    // 系统 OS 信息（Shell 标签：如 "Shell (Win 11 amd64)"）
    const osInfo = await getOsInfo();
    const osBadge = [osInfo.version, osInfo.arch].filter(Boolean).join(" ");
    setOsLabel(osBadge ? `${osInfo.os === "windows" ? "" : osInfo.os + " "}${osBadge}` : "");
    // PATH 解析可用 shell（零硬编码：交给系统 where/which）
    try {
      const detected = await invoke<Record<string, string>>("shell_detect", {});
      const resolved: ResolvedShell[] = Object.entries(detected).map(([name, path]) => ({
        name,
        path,
      }));
      // unix 登录默认 $SHELL 对应候选排最前
      if (osInfo.os !== "windows" && osInfo.defaultShell) {
        const defaultName = osInfo.defaultShell.split("/").pop() ?? "";
        const idx = resolved.findIndex((r) => r.name === defaultName);
        if (idx > 0) resolved.unshift(resolved.splice(idx, 1)[0]);
      }
      setAvailable(resolved);
    } catch (err) {
      console.warn("[terminal-shell] detect failed:", err);
      setAvailable([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const options = available ?? [];

  // 初次探测完成前不出选择器（避免选中不可用项）；当前存值不在可用列表 → 回退首个可用
  useEffect(() => {
    if (!options.length || preset !== null) return;
    const current = getTerminalSettings().shell;
    const found =
      options.find((o) => o.path.toLowerCase() === current.toLowerCase()) ??
      options.find((o) => current.toLowerCase().includes(o.name));
    if (current && found) {
      setShell(found.path);
      setPreset(found.name);
    } else {
      setShell(options[0].path);
      setPreset(options[0].name);
    }
  }, [options, preset]);

  const apply = (nextPreset: string, nextPath: string) => {
    setPreset(nextPreset);
    setShell(nextPath);
    setSaved(false);
  };

  const save = () => {
    saveTerminalSettings({ shell });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 3000);
  };

  const dirty = (() => {
    const current = getTerminalSettings().shell;
    return current !== shell;
  })();

  return (
    <div className="p-4 bg-[var(--bg-elev)] rounded-xl border border-[var(--border)] flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="font-medium">
          {t('terminalShellLabel')}
          {osLabel ? <span className="ml-1 text-[var(--text-dim)]">({osLabel})</span> : null}
        </div>
        <div className="text-sm text-[var(--text-dim)]">{t('terminalShellDesc')}</div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">
        {options.length === 0 ? (
          <span className="text-xs text-[var(--text-dim)]">{tt("terminalDetecting")}</span>
        ) : null}
        {options.length > 0 ? (
          <select
            value={preset ?? ""}
            onChange={(e) => {
              const found = options.find((o) => o.name === e.target.value);
              if (found) apply(found.name, found.path);
              else apply("custom", shell);
            }}
            className="rounded-lg border border-[var(--border)] bg-transparent px-2 py-1.5 text-sm text-[var(--text)] focus:outline-none"
          >
            {options.map((o) => (
              <option key={o.name} value={o.name}>
                {shellDisplayName(o.name)}
              </option>
            ))}
            <option value="custom">{t('terminalShellCustom')}</option>
          </select>
        ) : null}
        {preset === "custom" ? (
          <input
            type="text"
            value={shell}
            onChange={(e) => apply("custom", e.target.value)}
            placeholder={t('terminalShellCustomPlaceholder')}
            className="w-56 shrink-0 rounded-lg border border-[var(--border)] bg-transparent px-2 py-1.5 font-mono text-xs text-[var(--text)] placeholder-[var(--text-dim)] focus:outline-none"
          />
        ) : null}
        {dirty ? (
          <button
            type="button"
            onClick={save}
            className="flex-shrink-0 rounded-lg bg-[var(--brand)] px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
          >
            {t('terminalSave')}
          </button>
        ) : saved ? (
          <span className="flex-shrink-0 text-xs text-[var(--status-ok)]">{t('terminalSavedNote')}</span>
        ) : null}
      </div>
    </div>
  );
}
