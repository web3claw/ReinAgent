// LiveAgent 移植：crates/agent-ui/src/components/ProviderBrandIcon.tsx
// 适配：type 形参收敛为本组件本地 ProviderBrandType（LA 为 app 侧 ProviderId 枚举，
// 数据接线由页面层负责注入）。
import { cn } from "../lib/utils";
import { ClaudeIcon, DeepseekIcon, GrokIcon, OpenaiChatgptIcon } from "../icons/logos-icons";
import { GeminiIcon } from "../icons/brand-icons";

/** LA KNOWN_PROVIDER_IDS 同形的品牌 id 子集。 */
export type ProviderBrandType = "codex" | "claude_code" | "gemini" | "xai" | "deepseek";

const KNOWN_PROVIDER_IDS: readonly ProviderBrandType[] = [
  "codex",
  "claude_code",
  "gemini",
  "xai",
  "deepseek",
];

// Sidebar rows carry providerId as a wide string: legacy rows persist "",
// GUI optimistic rows may fall back to "pending", and web optimistic rows
// store a custom provider *instance* id. Only enum hits may reach the icon —
// anything else would render as the OpenAI fallback below.
export function isKnownProviderId(value: string | undefined): value is ProviderBrandType {
  return (KNOWN_PROVIDER_IDS as readonly string[]).includes(value ?? "");
}

// Unmatched types (including "codex") fall through to the OpenAI icon; callers
// that need "unknown renders nothing" must guard with isKnownProviderId first.
export function ProviderBrandIcon({
  type,
  className,
}: { type?: ProviderBrandType; className?: string }) {
  const cls = cn("size-4 shrink-0", className);
  if (type === "claude_code") return <ClaudeIcon className={cls} />;
  if (type === "gemini") return <GeminiIcon className={cls} />;
  if (type === "xai") return <GrokIcon className={cls} />;
  if (type === "deepseek") return <DeepseekIcon className={cls} />;
  return <OpenaiChatgptIcon className={cn(cls, "fill-current dark:text-white")} />;
}
