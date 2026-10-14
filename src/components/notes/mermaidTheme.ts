import type { MermaidConfig } from "mermaid";

/**
 * mermaid 图表主题：支持亮暗模式自适应
 */
const BASE_THEME_VARIABLES = {
  fontFamily:
    'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  fontSize: "14px",
};

const LIGHT_THEME_VARIABLES = {
  ...BASE_THEME_VARIABLES,
  background: "transparent",
  mainBkg: "#eef2ff",
  primaryColor: "#eef2ff",
  primaryBorderColor: "#a5b4fc",
  primaryTextColor: "#3730a3",
  secondaryColor: "#e0e7ff",
  secondaryBorderColor: "#c7d2fe",
  secondaryTextColor: "#4338ca",
  tertiaryColor: "#f5f3ff",
  tertiaryBorderColor: "#ddd6fe",
  tertiaryTextColor: "#6d28d9",
  lineColor: "#94a3b8",
  textColor: "#334155",
  nodeBorder: "#a5b4fc",
  nodeTextColor: "#334155",
  titleColor: "#1e293b",
  edgeLabelBackground: "#ffffff",
  edgeLabelTextColor: "#475569",
  clusterBkg: "#f8fafc",
  clusterBorder: "#e2e8f0",
  actorBkg: "#eef2ff",
  actorBorder: "#a5b4fc",
  actorTextColor: "#334155",
  signalColor: "#64748b",
  signalTextColor: "#334155",
  labelBoxBkgColor: "#eef2ff",
  labelBoxBorderColor: "#a5b4fc",
  labelTextColor: "#3730a3",
  loopTextColor: "#475569",
  activationBorderColor: "#818cf8",
  activationBkgColor: "#e0e7ff",
  sequenceNumberColor: "#ffffff",
  altBackground: "#f8fafc",
  altBorder: "#e2e8f0",
  pieStrokeColor: "#ffffff",
  pieOuterStrokeColor: "#e2e8f0",
  pieTitleTextSize: "16px",
  pieTitleTextColor: "#1e293b",
  pieSectionTextSize: "13px",
  pieSectionTextColor: "#334155",
  pieLegendTextSize: "13px",
  pieLegendTextColor: "#475569",
  pieStrokeWidth: "2px",
};

const DARK_THEME_VARIABLES = {
  ...BASE_THEME_VARIABLES,
  background: "transparent",
  mainBkg: "rgba(99, 102, 241, 0.16)",
  primaryColor: "rgba(99, 102, 241, 0.16)",
  primaryBorderColor: "#818cf8",
  primaryTextColor: "#e0e7ff",
  secondaryColor: "rgba(139, 92, 246, 0.16)",
  secondaryBorderColor: "#a78bfa",
  secondaryTextColor: "#ede9fe",
  tertiaryColor: "rgba(56, 189, 248, 0.14)",
  tertiaryBorderColor: "#7dd3fc",
  tertiaryTextColor: "#e0f2fe",
  lineColor: "#64748b",
  textColor: "#cbd5e1",
  nodeBorder: "#818cf8",
  nodeTextColor: "#cbd5e1",
  titleColor: "#e2e8f0",
  edgeLabelBackground: "#1e293b",
  edgeLabelTextColor: "#cbd5e1",
  clusterBkg: "rgba(255, 255, 255, 0.03)",
  clusterBorder: "rgba(255, 255, 255, 0.12)",
  actorBkg: "rgba(99, 102, 241, 0.16)",
  actorBorder: "#818cf8",
  actorTextColor: "#cbd5e1",
  signalColor: "#94a3b8",
  signalTextColor: "#cbd5e1",
  labelBoxBkgColor: "rgba(99, 102, 241, 0.16)",
  labelBoxBorderColor: "#818cf8",
  labelTextColor: "#e0e7ff",
  loopTextColor: "#94a3b8",
  activationBorderColor: "#818cf8",
  activationBkgColor: "rgba(99, 102, 241, 0.25)",
  sequenceNumberColor: "#1e293b",
  altBackground: "rgba(255, 255, 255, 0.02)",
  altBorder: "rgba(255, 255, 255, 0.08)",
  pieStrokeColor: "#0f172a",
  pieOuterStrokeColor: "rgba(255, 255, 255, 0.12)",
  pieTitleTextSize: "16px",
  pieTitleTextColor: "#e2e8f0",
  pieSectionTextSize: "13px",
  pieSectionTextColor: "#cbd5e1",
  pieLegendTextSize: "13px",
  pieLegendTextColor: "#94a3b8",
  pieStrokeWidth: "2px",
};

/** 生成 mermaid 配置：扁平布局 + 应用主题变量 */
export function mermaidConfig(isDark: boolean): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: "loose",
    suppressErrorRendering: true,
    theme: "base",
    themeVariables: isDark ? DARK_THEME_VARIABLES : LIGHT_THEME_VARIABLES,
    flowchart: {
      htmlLabels: true,
      curve: "basis",
      padding: 14,
      nodeSpacing: 44,
      rankSpacing: 52,
      diagramPadding: 10,
      useMaxWidth: true,
    },
    sequence: {
      useMaxWidth: true,
      actorFontFamily: BASE_THEME_VARIABLES.fontFamily,
      noteFontFamily: BASE_THEME_VARIABLES.fontFamily,
      messageFontFamily: BASE_THEME_VARIABLES.fontFamily,
    },
    gantt: {
      useMaxWidth: true,
      fontSize: 13,
    },
  };
}

/** 是否处于暗色模式 */
export function isDarkTheme(): boolean {
  if (typeof document === "undefined") return false;
  return (
    document.documentElement.classList.contains("dark") ||
    document.documentElement.getAttribute("data-theme") === "dark" ||
    document.body.getAttribute("data-theme") === "dark"
  );
}

/**
 * mermaid 对 CJK 标签的宽度度量偏小，
 * foreignObject 默认 overflow:hidden 会裁掉末字。渲染后按文本实际尺寸撑开标签框。
 */
export function fitMermaidLabels(container: HTMLElement): void {
  const objects = container.querySelectorAll<SVGForeignObjectElement>("foreignObject");
  for (const fo of objects) {
    const div = fo.firstElementChild as HTMLElement | null;
    if (!div) continue;
    const needW = Math.ceil(div.scrollWidth) + 2;
    const needH = Math.ceil(div.scrollHeight) + 2;
    const curW = Number(fo.getAttribute("width") ?? "0");
    const curH = Number(fo.getAttribute("height") ?? "0");
    if (needW <= curW && needH <= curH) continue;
    const x = Number(fo.getAttribute("x") ?? "0");
    const y = Number(fo.getAttribute("y") ?? "0");
    fo.setAttribute("width", String(needW));
    fo.setAttribute("height", String(needH));
    fo.setAttribute("x", String(x - (needW - curW) / 2));
    fo.setAttribute("y", String(y - (needH - curH) / 2));
    div.style.width = `${needW}px`;
    div.style.height = `${needH}px`;
  }
}
