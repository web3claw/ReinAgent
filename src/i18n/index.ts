import { useAppStore } from "../store/useAppStore";

export const translations = {
  "zh-CN": {
    appName: "ReinAgent",
    subtitle: "AI 编程工作台",
    demoMode: "演示模式",
    realMode: "在线模式",
    terminal: "终端",
    settings: "设置",
    theme: "主题",
    language: "语言",
    provider: "服务商",
    model: "模型",
    apiKey: "API 密钥",
    apiKeyPlaceholder: "输入 API Key",
    baseUrl: "API 端点",
    save: "保存",
    saved: "已保存",
    saving: "保存中...",
    send: "发送",
    stop: "停止",
    inputPlaceholder: "输入消息，Enter 发送，Shift+Enter 换行...",
    emptyTitle: "有什么我可以帮您的？",
    emptySubtitle: "支持深度对话、代码编写、命令行执行、多模型切换等功能",
    toolsUsed: "已调用工具",
    clearHistory: "清空对话",
    statusIdle: "就绪",
    statusStreaming: "生成中",
    statusError: "错误",
    copied: "已复制",
    copy: "复制",
    lightMode: "浅色模式",
    darkMode: "深色模式",
  },
  "en-US": {
    appName: "ReinAgent",
    subtitle: "AI Coding Workbench",
    demoMode: "Demo Mode",
    realMode: "Live Mode",
    terminal: "Terminal",
    settings: "Settings",
    theme: "Theme",
    language: "Language",
    provider: "Provider",
    model: "Model",
    apiKey: "API Key",
    apiKeyPlaceholder: "Enter API Key",
    baseUrl: "Base URL",
    save: "Save",
    saved: "Saved",
    saving: "Saving...",
    send: "Send",
    stop: "Stop",
    inputPlaceholder: "Type a message, Enter to send, Shift+Enter for new line...",
    emptyTitle: "How can I help you today?",
    emptySubtitle: "Conversations, code editing, terminal execution, multi-model support, and more",
    toolsUsed: "Tools Executed",
    clearHistory: "Clear Chat",
    statusIdle: "Ready",
    statusStreaming: "Streaming",
    statusError: "Error",
    copied: "Copied",
    copy: "Copy",
    lightMode: "Light Mode",
    darkMode: "Dark Mode",
  },
} as const;

export type TranslationKey = keyof typeof translations["zh-CN"];

export function useTranslation() {
  const locale = useAppStore((s) => s.locale);
  const dict = translations[locale] || translations["zh-CN"];

  const t = (key: TranslationKey, fallback?: string): string => {
    return dict[key] || fallback || key;
  };

  return { t, locale };
}
