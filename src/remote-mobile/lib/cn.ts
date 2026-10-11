/** cn —— ZCode components/lib/utils 同款轻实现（clsx 语义 + 合并去重）。 */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
