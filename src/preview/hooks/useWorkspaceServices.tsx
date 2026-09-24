/**
 * useWorkspaceServices 适配层 —— 宿主（Tauri）只有一个本地文件服务实现。
 * 远端 workspace / 媒体预览 / 文件监视在宿主中不支持：对应服务为 undefined，
 * PreviewPane 对这些服务均有缺席兜底（显示「不可用」），行为符合 No-Fallback。
 */
import { useMemo } from "react";
import { useFileService } from "./useFileService";
import type { IMediaPreviewService } from "../shared";

export function useWorkspaceServices(
  _workspacePath?: string,
  _workspaceRemoteSessionId?: string,
  _workspaceIdentity?: string
) {
  const fileService = useFileService();

  return useMemo(
    () => ({
      fileService,
      fileWatcherService: undefined as unknown as undefined,
      mediaPreviewService: undefined as IMediaPreviewService | undefined,
    }),
    [fileService]
  );
}
