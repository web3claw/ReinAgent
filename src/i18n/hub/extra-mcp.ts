/**
 * LiveAgent 移植 i18n 增补 —— src/components/mcp/ 移植页面用到、但
 * hub/zh.ts 与 hub/en.ts 尚未收录的键（多代理并行防冲突，本文件由
 * 集成方在 src/i18n/index.ts 里把 hubExtraMcp / hubExtraMcpEn 分别
 * spread 进 zh-CN / en-US 字典后再生效；收录前 t() 会原样回显键名）。
 *
 * 值机械取自 LiveAgent 原文：
 * - zh：crates/agent-ui/src/i18n/translations/zh-CN（zhCNCommon 同名键）
 * - en：crates/agent-ui/src/i18n/translations/en-US（enUSCommon 同名键）
 */

/** zh-CN 增补键 */
export const hubExtraMcp: Record<string, string> = {
  "settings.cancel": "取消",
  "settings.delete": "删除",
  "settings.disable": "禁用",
  "settings.edit": "编辑",
  "settings.enable": "启用",
  "mcpHub.glamaApiKey": "Glama API Key",
  "mcpHub.glamaApiKeyDesc": "Glama 的服务器目录接口自 2026 年 9 月起强制要求 API Key（免费创建：glama.ai/settings/api-keys）。粘贴后 Glama 源即可正常搜索；未配置时该源会如实显示 401。",
  "mcpHub.glamaApiKeyPlaceholder": "粘贴 Glama API Key…",
  "mcpHub.save": "保存",
  "mcpHub.clearKey": "清除",
  "mcpHub.keySaved": "已保存。",
  "mcpHub.cardTestOk": "连接成功 · {n} 个工具",
  "mcpHub.cardTestFailed": "连接失败",
};

/** en-US 增补键（与 hubExtraMcp 键集一一对应） */
export const hubExtraMcpEn: Record<string, string> = {
  "settings.cancel": "Cancel",
  "settings.delete": "Delete",
  "settings.disable": "Disable",
  "settings.edit": "Edit",
  "settings.enable": "Enable",
  "mcpHub.glamaApiKey": "Glama API Key",
  "mcpHub.glamaApiKeyDesc": "The Glama server-directory API has required an API key since Sep 2026 (create one free at glama.ai/settings/api-keys). Paste it here to search the Glama source; without a key that source honestly reports a 401.",
  "mcpHub.glamaApiKeyPlaceholder": "Paste Glama API key…",
  "mcpHub.save": "Save",
  "mcpHub.clearKey": "Clear",
  "mcpHub.keySaved": "Saved.",
  "mcpHub.cardTestOk": "Connected · {n} tools",
  "mcpHub.cardTestFailed": "Connection failed",
};
