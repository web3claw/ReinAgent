// LiveAgent 移植：crates/agent-ui/src/components/hub/ToolPolicyToggle.tsx
// 适配：ToolPolicy 类型从 @liveagent/app/lib/settings 收敛为本组件本地定义；
// i18n 铁律：LA 内部的 t(`settings.toolPolicy.${option}`) 改为必填 labels props，
// 页面层负责传入 i18n 值。
import { SettingsToggleGroup, SettingsToggleGroupItem } from "../settings/SettingsToggleGroup";

/** 三态审批策略（与 LA app/lib/settings 的 ToolPolicy 同形）。 */
export type ToolPolicy = "allow" | "ask" | "deny";

const POLICY_ORDER: readonly ToolPolicy[] = ["allow", "ask", "deny"];

/**
 * 三态审批策略切换。value 为当前生效策略,onChange 回传所选。ariaLabel 给无障碍
 * 定位(工具名 / server id / 组名)。labels 需传 i18n 值（allow/ask/deny 的展示文案）。
 */
export function ToolPolicyToggle(props: {
  value: ToolPolicy;
  ariaLabel: string;
  /** 各策略的展示文案（页面需传 i18n 值，LA 源码为 t("settings.toolPolicy.*")）。 */
  labels: Readonly<Record<ToolPolicy, string>>;
  onChange: (next: ToolPolicy) => void;
}) {
  const { value, ariaLabel, labels, onChange } = props;
  return (
    <SettingsToggleGroup
      value={[value]}
      aria-label={ariaLabel}
      onValueChange={(values) => {
        const next = values[0];
        if (next === "allow" || next === "ask" || next === "deny") onChange(next);
      }}
    >
      {POLICY_ORDER.map((option) => (
        <SettingsToggleGroupItem key={option} value={option}>
          {labels[option]}
        </SettingsToggleGroupItem>
      ))}
    </SettingsToggleGroup>
  );
}
