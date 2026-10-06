// LiveAgent 移植：crates/agent-ui/src/lib/skills/builtin.ts
// 适配（2026-10-06 用户定稿）：两枚首方内置技能（skills-creator / skills-installer）不再
// 「恒启用」——启用/禁用与其他技能同语义（settings.skills.selected），**默认禁用**。
// 本模块判定仅剩展示与管理用途：列表排序置前、删除保护（Rust 侧同样拒绝删除内置）。
const BUILTIN_SKILL_NAMES = ["skills-creator", "skills-installer"] as const;

const builtinSkillNameSet = new Set<string>(BUILTIN_SKILL_NAMES);

/** 是否首方内置技能（Rust 启动播种、管理操作受保护）。 */
export function isBuiltinSkillName(name: string) {
  return builtinSkillNameSet.has(name);
}

function builtinSkillRank(name: string) {
  const rank = BUILTIN_SKILL_NAMES.indexOf(name as (typeof BUILTIN_SKILL_NAMES)[number]);
  return rank === -1 ? Number.POSITIVE_INFINITY : rank;
}

export function sortSkillsForDisplay<T extends { name: string }>(skills: readonly T[]) {
  return [...skills].sort((a, b) => {
    const aRank = builtinSkillRank(a.name);
    const bRank = builtinSkillRank(b.name);
    if (aRank !== bRank) return aRank < bRank ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
