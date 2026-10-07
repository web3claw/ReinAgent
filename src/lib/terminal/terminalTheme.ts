/**
 * terminalTheme.ts —— 终端配色读取（LiveAgent crates/agent-ui/src/lib/terminal/theme.ts
 * 同款做法）：xterm 只吃具体颜色值，不入 CSS 变量，因此从 `--terminal-{theme}-*`
 * 语义 token 解析后喂给 xterm；色板定义见 src/styles/global.css。
 */

/** xterm ITheme 子集（我们实际下发的键；与 global.css token 一一对应）。 */
export interface TerminalThemeColors {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionInactiveBackground: string;
  scrollbarSliderBackground: string;
  scrollbarSliderHoverBackground: string;
  scrollbarSliderActiveBackground: string;
  overviewRulerBorder: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

const COLOR_KEYS: readonly (keyof TerminalThemeColors)[] = [
  "background",
  "foreground",
  "cursor",
  "cursorAccent",
  "selectionBackground",
  "selectionInactiveBackground",
  "scrollbarSliderBackground",
  "scrollbarSliderHoverBackground",
  "scrollbarSliderActiveBackground",
  "overviewRulerBorder",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
];

/** camelCase → kebab-case（`brightGreen` → `bright-green`，LiveAgent 同款键名规则）。 */
function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * 读取某主题的终端色板（`--terminal-dark-*` / `--terminal-light-*`）。
 * 缺 token（样式未加载/旧样式表）时回退空串——xterm 以默认色渲染，绝不猜色。
 */
export function readTerminalTheme(
  theme: "dark" | "light",
  style: Pick<CSSStyleDeclaration, "getPropertyValue"> = getComputedStyle(
    document.documentElement,
  ),
): TerminalThemeColors {
  const out = {} as TerminalThemeColors;
  for (const key of COLOR_KEYS) {
    out[key] = style.getPropertyValue(`--terminal-${theme}-${kebab(key)}`).trim();
  }
  return out;
}
