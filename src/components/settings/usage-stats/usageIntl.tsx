/**
 * usageIntl —— ZCode `useZCodeIntl` 的兼容层（P1-7 复刻移植）。
 *
 * ZCode 用 react-intl 的 `intl.formatMessage({id}, values)`；我们用 t(key) + {占位}。
 * 这里把差异收进一个同名 hook：签名与用法与 ZCode 完全一致（{intl, locale}），
 * 移植的图表组件因此零逻辑改动。values 的占位符沿用 react-intl 的 {name} 形式。
 */

import { useTranslation } from "../../../i18n";

export interface UsageIntl {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string | number>) => string;
}

export function useZCodeIntl(): { intl: UsageIntl; locale: string } {
  const { t, locale } = useTranslation();
  const intl: UsageIntl = {
    formatMessage: (descriptor, values) => {
      // settings.usage.* 键是动态复制自 ZCode locale 的字符串，不在 t() 的键联合类型里
      let text: string = (t as (key: string) => string)(descriptor.id);
      if (values) {
        for (const [key, value] of Object.entries(values)) {
          text = text.split(`{${key}}`).join(String(value));
        }
      }
      return text;
    },
  };
  return { intl, locale };
}
