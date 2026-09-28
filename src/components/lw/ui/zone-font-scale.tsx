// LiveAgent 移植：crates/agent-ui/src/components/ui/zone-font-scale.tsx
import * as React from "react";

/**
 * Font-scale zone that portaled popups inherit.
 *
 * `--zone-font-scale` is a CSS custom property, so it stops at the portal
 * boundary: a Select or Dropdown opened from inside a dialog renders under
 * <body> and falls back to 1.0 while its trigger paints at the dialog's 0.9.
 * React context does cross portals, so a zone publishes its scale here and the
 * popup wrappers re-declare it on their own root. `null` means "no zone" and
 * leaves the popup untouched.
 */
export const ZoneFontScaleContext = React.createContext<number | null>(null);

/**
 * Reads a `--zone-font-scale` override from an inline style, else the fallback.
 */
export function resolveZoneFontScale(style: unknown, fallback: number): number {
  const raw =
    style !== null && typeof style === "object"
      ? (style as Record<string, unknown>)["--zone-font-scale"]
      : undefined;
  const parsed =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Inline style for a popup wrapper that carries the enclosing zone's scale
 * across the portal. `.layer-popover` (见 global.css 的 @utility) already
 * re-declares the text-size variables from `--zone-font-scale`, so setting the
 * property on the popup root is all a popup needs; with no zone the variable
 * stays unset and the popup renders at 1.0 as before.
 */
export function useZoneFontScaleStyle(): React.CSSProperties | undefined {
  const scale = React.useContext(ZoneFontScaleContext);
  if (scale === null) return undefined;
  return { "--zone-font-scale": scale } as React.CSSProperties;
}
