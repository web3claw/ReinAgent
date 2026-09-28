// LiveAgent 移植：crates/agent-ui/src/pages/settings/shared.tsx（AgentActivationSwitch）
import { cn } from "../lib/utils";
import { Switch } from "../ui/switch";

/** 仅是 Switch 的薄样式包装（LA 同名同形）。 */
export function AgentActivationSwitch(props: {
  checked: boolean;
  title: string;
  disabled?: boolean;
  className?: string;
  onToggle: () => void;
}) {
  const { checked, title, disabled = false, className, onToggle } = props;

  return (
    <Switch
      checked={checked}
      disabled={disabled}
      title={title}
      aria-label={title}
      onCheckedChange={onToggle}
      className={cn(className)}
    />
  );
}
