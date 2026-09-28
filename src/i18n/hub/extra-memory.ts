// LiveAgent 移植：记忆页缺失键补充（不改 zh.ts / en.ts，独立 extra 词典）。
// - settings.close / settings.cancel / settings.delete / chat.*：LA 翻译原文，
//   hub/zh.ts 未收录，记忆页各弹层与删除确认、模型选择器需要；
// - settings.memoryOrganizerPhase2：Organizer 二期边界诚实提示（用户定档文案）。
export const hubExtraMemory: Record<string, string> = {
  "settings.close": "关闭",
  "settings.cancel": "取消",
  "settings.delete": "删除",
  "chat.searchModel": "搜索模型...",
  "chat.noModelFound": "未找到匹配的模型",
  "chat.collapseProvider": "收起该提供商的模型",
  "chat.expandProvider": "展开该提供商的模型",
  "settings.memoryOrganizerPhase2": "记忆整理器将在后续版本提供，敬请期待",
};

export const hubExtraMemoryEn: Record<string, string> = {
  "settings.close": "Close",
  "settings.cancel": "Cancel",
  "settings.delete": "Delete",
  "chat.searchModel": "Search models...",
  "chat.noModelFound": "No matching models found",
  "chat.collapseProvider": "Collapse provider models",
  "chat.expandProvider": "Expand provider models",
  "settings.memoryOrganizerPhase2":
    "The memory organizer will be available in an upcoming version.",
};
