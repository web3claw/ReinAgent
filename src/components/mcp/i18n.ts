// LiveAgent 移植适配：LA 的 useLocale() 接受全量字符串键（点分键名与 LA 完全
// 一致，如 "mcpHub.subtitle"）。本项目的 useTranslation() 参数类型
// TranslationKey 是 src/i18n/index.ts 根字典字面量键的联合，尚未收录
// i18n/hub/*（zh.ts / en.ts / index.ts 均为本次任务的禁改文件）。
// 运行时 translations[locale] 已经 spread 了 hubZh/hubEn 的全部点分键，
// 因此这里只对 t 的签名做一次受控放宽；未收录键走 t 的 fallback 链
// （dict[key] || fallback || key）。
import { useTranslation } from "../../i18n";

export type HubTranslator = (key: string, fallback?: string) => string;

export function useHubTranslation(): { t: HubTranslator; locale: string } {
  const { t, locale } = useTranslation();
  return { t: t as unknown as HubTranslator, locale };
}
