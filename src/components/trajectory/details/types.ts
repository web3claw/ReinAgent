// LiveAgent 移植：crates/agent-ui/src/components/trajectory/details/types.ts
// 适配：一期无 header/分段池（system 记录不产生）——DetailTabProps 去掉 section/header 体系，
// i18n 由各 tab 内部调 useTranslation 获取（避免键联合类型传参摩擦）。
import type { TrajectoryRecord } from "../../../lib/trajectory/types";

export type DetailTabId =
  | "overview"
  | "rendered"
  | "raw"
  | "source"
  | "input"
  | "output"
  | "options"
  | "usage"
  | "timing";

export type DetailTabProps = {
  record: TrajectoryRecord;
  /** 打开文件预览（右侧面板）；无则文件块不可点。 */
  onOpenFileLink?: (path: string) => void;
};
