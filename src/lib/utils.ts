import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// === LiveAgent 移植（crates/agent-ui/src/lib/shared/utils.ts）===
// 教会 class merger 识别 global.css 中定义的 LiveAgent 语义 token：
// text-tiny 必须保持字号语义（与 text-color 同现时不互吞），
// shadow-ui-* / bg-surface-glow-* 等自定义 token 同理。
// 仅「追加识别知识」，对既有标准类的合并行为无任何改变。
const isSizeToken = (value: string) =>
  /^(?:scaled-|minus-)?\d+(?:p\d+)?(?:px|rem|em|ch|d?vh|vw)?$/.test(value);
const isNamedToken = (value: string) => !value.startsWith("[") && !value.startsWith("(");

const styleTokenNames = {
  shadow: [
    "ui-hubchrome-24",
    "ui-hubchrome-25",
    "ui-skillshubpage-51",
    "ui-mcpregistrybrowser-45",
    "ui-mcpregistrybrowser-46",
    "ui-memorysettingsdrawer-50",
    "hub-frost-hero",
    "hub-frost-hero-dark",
  ],
  backgroundImage: [
    "surface-glow-1",
    "surface-glow-2",
    "surface-glow-3",
    "surface-glow-4",
    "surface-glow-5",
    "surface-glow-6",
    "hub-frost-hero",
    "hub-frost-hero-dark",
  ],
} as const;

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["tiny", isSizeToken],
      spacing: [isNamedToken],
      animate: [isNamedToken],
      ease: [isNamedToken],
      leading: [isSizeToken],
      radius: [isSizeToken, "half"],
      tracking: [isSizeToken],
      blur: [isSizeToken],
      shadow: [...styleTokenNames.shadow],
    },
    classGroups: {
      "ring-w": [{ ring: [isSizeToken] }],
      "bg-image": [{ bg: [...styleTokenNames.backgroundImage] }],
      "vertical-align": ["align-minus-0p05em"],
      "grid-cols": [{ "grid-cols": [isNamedToken] }],
      "grid-rows": [{ "grid-rows": [isNamedToken] }],
      duration: [{ duration: [(value: string) => /^\d+ms$/.test(value)] }],
      "underline-offset": [{ "underline-offset": [isSizeToken] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
