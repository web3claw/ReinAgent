/**
 * ThemeMenu —— ZCode WebRemoteControlThemeMenu 直移适配：
 * Theme 三档 system/dark/light（zai-* 命名 → 本仓 data-theme 语义），按设备 localStorage 记忆。
 */
import { Check, Palette } from "lucide-react";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui";
import { useRemoteT } from "../i18n";
import type { LocalePreference } from "../i18n";
import { cn } from "../lib/cn";

export type RemoteTheme = "system" | "dark" | "light";

const THEME_STORAGE_KEY = "reinagent-remote-theme";
const MOBILE_THEME_OPTIONS: RemoteTheme[] = ["system", "dark", "light"];

export function readRemoteTheme(): RemoteTheme {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "dark" || saved === "light" || saved === "system") return saved;
  } catch {
    /* ignore */
  }
  return "system";
}

export function persistRemoteTheme(theme: RemoteTheme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
}

/** system → 跟随 prefers-color-scheme；返回落盘的最终档。 */
export function applyRemoteTheme(theme: RemoteTheme): "dark" | "light" {
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  document.documentElement.setAttribute("data-theme", resolved);
  // 强制深色豁免声明随主题更新（ZCode 同款）
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", resolved);
  return resolved;
}

export function watchSystemTheme(onChange: () => void): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

const LOCALE_OPTIONS: LocalePreference[] = ["system", "zh-CN", "en-US"];

/** 调色板菜单 = 移动端设置入口：主题（深/浅/跟随系统）+ 语言（跟随系统/中文/English），按设备记忆。 */
export function RemoteThemeMenu({
  theme,
  onThemeChange,
  localePref,
  onLocaleChange,
  className,
}: {
  theme: RemoteTheme;
  onThemeChange: (theme: RemoteTheme) => void;
  localePref: LocalePreference;
  onLocaleChange: (pref: LocalePreference) => void;
  className?: string;
}) {
  const t = useRemoteT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("webRemoteControl.themeMenu.trigger")}
          className={className}
        >
          <Palette className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {MOBILE_THEME_OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option}
            className={cn(option === theme && "bg-selected")}
            onSelect={() => {
              onThemeChange(option);
            }}
          >
            <span className="min-w-0 flex-1">{t(`remote.theme.${option}`)}</span>
            {option === theme ? <Check className="size-4 shrink-0 text-foreground-subtle" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("remote.locale.title")}</DropdownMenuLabel>
        {LOCALE_OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option}
            className={cn(option === localePref && "bg-selected")}
            onSelect={() => {
              onLocaleChange(option);
            }}
          >
            <span className="min-w-0 flex-1">{t(`remote.locale.${option}`)}</span>
            {option === localePref ? <Check className="size-4 shrink-0 text-foreground-subtle" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
