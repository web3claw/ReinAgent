/**
 * usageErrorBoundary —— ZCode ScopedErrorBoundary 的最小替代（P1-7 复刻移植）。
 *
 * 只承担 Usage 图表的局部隔离职责：lazy 加载失败 / Recharts 渲染崩溃时
 * 渲染内联 fallback，不拖垮整个设置页。variant/scope 语义以 props 保留。
 */

import { Component, type ReactNode } from "react";

export function UsageInlineFallback({ children }: { children: ReactNode }) {
  return <div className="px-4 py-6 text-center text-ui-base text-foreground-subtle">{children}</div>;
}

interface Props {
  scope: string;
  resetKeys: readonly unknown[];
  variant?: "inline";
  children: ReactNode;
}

interface State {
  failed: boolean;
  resetSignature: string;
}

export class UsageScopedErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { failed: false, resetSignature: UsageScopedErrorBoundary.signature(props.resetKeys) };
  }

  static signature(resetKeys: readonly unknown[]): string {
    return JSON.stringify(resetKeys);
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    const nextSignature = UsageScopedErrorBoundary.signature(props.resetKeys);
    if (nextSignature !== state.resetSignature) {
      // resetKeys 变化（如刷新后 generatedAt 更新）→ 给边界一次重试机会
      return { failed: false, resetSignature: nextSignature };
    }
    return null;
  }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.warn(`[usage-stats] boundary ${this.props.scope} caught:`, error);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return <UsageInlineFallback>图表加载失败</UsageInlineFallback>;
    }
    return this.props.children;
  }
}
