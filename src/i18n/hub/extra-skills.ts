// LiveAgent 移植：<crates/agent-ui/src/i18n/translations/{zhCNSettings,enUSSettings,zhCNCommon,enUSCommon}.ts>
// Skills Hub 移植页用到、但 src/i18n/hub/{zh,en}.ts 尚未收录的补充键。
// 仅本文件持有双语值；页面经 src/components/skills/useLocale.ts 合并查询，
// 不改动受保护的 zh.ts / en.ts / i18n/index.ts。

export const hubExtraSkills: Record<string, string> = {
  "settings.cancel": "取消",
  "settings.delete": "删除",
  "settings.cronViewClose": "关闭",
  "settings.switchToAgentMode": "切换至 Agent 模式",
};

export const hubExtraSkillsEn: Record<string, string> = {
  "settings.cancel": "Cancel",
  "settings.delete": "Delete",
  "settings.cronViewClose": "Close",
  "settings.switchToAgentMode": "Switch to Agent mode",
};
