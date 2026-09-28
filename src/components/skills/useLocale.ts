// LiveAgent 移植：<crates/agent-ui/src/i18n/index.ts 的 useLocale>
// 适配：ReinAgent 统一走 src/i18n 的 useTranslation（键名字典在 hub/{zh,en}.ts）；
// Skills Hub 移植页有 4 个 zh/en 未收录的键（见 i18n/hub/extra-skills.ts），
// 在此合并查询，保证移植文件内部 `const { t } = useLocale()` 与 LA 完全同形。
import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import { hubExtraSkills, hubExtraSkillsEn } from "../../i18n/hub/extra-skills";

export function useLocale() {
  const { t, locale } = useTranslation();
  const extra = locale === "en-US" ? hubExtraSkillsEn : hubExtraSkills;
  // translate 必须稳定（页面 effect 以 t 为依赖，如技能预览抽屉的 readSkillText）
  const translate = useMemo(
    () => (key: string): string => {
      const fromExtra = extra[key];
      if (fromExtra !== undefined) return fromExtra;
      return t(key as Parameters<typeof t>[0]);
    },
    [extra, t],
  );
  return { t: translate, locale };
}
