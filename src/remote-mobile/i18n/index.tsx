/**
 * i18n —— 轻量双语层：桌面字典做底（复用 approvalCard / planCard 等键），
 * 远控增补键覆盖其上。语言跟随手机系统（zh 兜底 zh-CN）。
 */
import { createContext, useContext, type ReactNode } from "react";
import { remoteZhOverrides } from "./zh";
import { remoteEnOverrides } from "./en";

export type RemoteLocale = "zh-CN" | "en-US";

// 自包含双字典（不引桌面 i18n → 不拖 useAppStore/conversationPool 桌面依赖链进手机包）；
// 桌面共用键（审批卡/计划卡/提问卡/加载文案）已复制进 overrides。
const dictionaries: Record<RemoteLocale, Record<string, string>> = {
  "zh-CN": { ...remoteZhOverrides },
  "en-US": { ...remoteEnOverrides },
};

export type LocalePreference = "system" | "zh-CN" | "en-US";

const LOCALE_STORAGE_KEY = "reinagent-remote-locale";

export function readLocalePreference(): LocalePreference {
  try {
    const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (saved === "zh-CN" || saved === "en-US" || saved === "system") return saved;
  } catch {
    /* ignore */
  }
  return "system";
}

export function persistLocalePreference(pref: LocalePreference): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, pref);
  } catch {
    /* ignore */
  }
}

/** 生效语言 = 用户偏好；system 跟随手机系统/浏览器语言（ZCode 网页同语义）。 */
export function resolveEffectiveLocale(pref: LocalePreference): RemoteLocale {
  return pref === "system" ? resolveRemoteLocale() : pref;
}

export function resolveRemoteLocale(): RemoteLocale {
  const langs = typeof navigator !== "undefined" ? navigator.languages ?? [navigator.language] : [];
  for (const lang of langs) {
    if (/^en\b/i.test(lang)) return "en-US";
    if (/^zh\b/i.test(lang)) return "zh-CN";
  }
  return "zh-CN";
}

interface IntlContextValue {
  locale: RemoteLocale;
}

const IntlContext = createContext<IntlContextValue>({ locale: "zh-CN" });

export function RemoteIntlProvider({ locale, children }: { locale: RemoteLocale; children: ReactNode }) {
  return <IntlContext.Provider value={{ locale }}>{children}</IntlContext.Provider>;
}

export function useRemoteIntl(): IntlContextValue {
  return useContext(IntlContext);
}

/** ZCode intl.formatMessage 同语义：{placeholder} 替换，缺键如实回显键名（No-Fallback）。 */
export function formatRemoteMessage(
  locale: RemoteLocale,
  id: string,
  values?: Record<string, string>,
): string {
  const dict = dictionaries[locale] ?? dictionaries["zh-CN"];
  const template = dict[id] ?? dictionaries["zh-CN"][id] ?? id;
  if (!values) return template;
  return Object.entries(values).reduce(
    (acc, [key, value]) => acc.replaceAll(`{${key}}`, value),
    template,
  );
}

export function useRemoteT() {
  const { locale } = useRemoteIntl();
  return (id: string, values?: Record<string, string>) => formatRemoteMessage(locale, id, values);
}
