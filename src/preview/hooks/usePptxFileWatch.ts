/**
 * usePptxFileWatch 适配层 —— 宿主（Tauri）未实现文件监视服务，
 * PPTX 自动刷新降级为「就绪但不监视」：文件变更后可手动重新打开预览。
 */
export function usePptxFileWatch(_options?: {
  filePath?: string | null;
  fileWatcherService?: unknown;
  enabled?: boolean;
}) {
  return { ready: true, reloadGeneration: 0 };
}
