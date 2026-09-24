/**
 * StoreProvider 适配层 —— ZCode PreviewPane 只消费 theme 与 codePreviewSettings 两个字段。
 * 宿主用最小 zustand store 提供同形状状态；主题默认 dark（与宿主 App 默认一致）。
 */
import { create } from "zustand";
import type { Theme } from "../useTheme";
import type { CodePreviewSettings } from "../lib/codePreviewSettings";

export interface PreviewPaneStoreState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  codePreviewSettings: CodePreviewSettings;
  setCodePreviewSettings: (settings: CodePreviewSettings) => void;
}

export const useZCodeStore = create<PreviewPaneStoreState>((set) => ({
  theme: "dark",
  setTheme: (theme) => set({ theme }),
  codePreviewSettings: {
    lightTheme: "github-light",
    darkTheme: "github-dark",
    showLineNumbers: true,
    wrapLongLines: false,
    fontSizePx: 12,
  },
  setCodePreviewSettings: (codePreviewSettings) => set({ codePreviewSettings }),
}));

/** 兼容旧导出名（若后续移植的文件引用 StoreProvider 包装组件）。 */
export function StoreProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
