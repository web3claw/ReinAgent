/**
 * useFileService 适配层 —— 以 Tauri IPC 实现 ZCode IFileService 中 PreviewPane
 * 消费的方法。
 * - readTextFile → fs_read_text_file；
 * - readBinaryPreview → fs_read_base64_file（P2-E 新增：Office/PPTX 预览数据源）；
 * - readMediaPreview / readFileRange / stat → PDF 分段加载需要 readFileRange，
 *   其余如实抛错（No-Fallback）。
 */
import { useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FileBinaryPreview, FileMediaPreview, FileTextSlice } from "../shared";

export function useFileService() {
  const readTextFile = useCallback(
    async (input: { path: string; offset?: number; length?: number }): Promise<FileTextSlice> => {
      return invoke<FileTextSlice>("fs_read_text_file", {
        path: input.path,
        offset: input.offset ?? undefined,
        length: input.length ?? undefined,
      });
    },
    []
  );

  const readBinaryPreview = useCallback(
    async (input: { path: string }): Promise<FileBinaryPreview> => {
      const result = await invoke<{ base64: string; totalBytes: number }>("fs_read_base64_file", {
        path: input.path,
      });
      return { path: input.path, dataBase64: result.base64, totalBytes: result.totalBytes };
    },
    []
  );

  const readMediaPreview = useCallback(
    async (input: { path: string }): Promise<FileMediaPreview> => {
      throw new Error(`媒体预览在当前宿主中不可用: ${input.path}`);
    },
    []
  );

  const readFileRange = useCallback(
    async (input: {
      path: string;
      offset: number;
      length: number;
    }): Promise<Uint8Array> => {
      // PDF range 加载：base64 全量读取后按区间切（小 PDF 已走全量路径，此处兜底）
      const result = await invoke<{ base64: string; totalBytes: number }>("fs_read_base64_file", {
        path: input.path,
      });
      const binary = atob(result.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes.subarray(input.offset, input.offset + input.length);
    },
    []
  );

  const stat = useCallback(
    async (input: { path: string }): Promise<{ size: number }> => {
      const result = await invoke<{ base64: string; totalBytes: number }>("fs_read_base64_file", {
        path: input.path,
      });
      return { size: result.totalBytes };
    },
    []
  );

  // 服务对象必须记忆化：PreviewPane 的文件加载 effect 以 fileService 身份为依赖，
  // 每次渲染新建对象会导致 effect 无限重跑（加载闪烁）。
  return useMemo(
    () => ({ readTextFile, readBinaryPreview, readFileRange, readMediaPreview, stat }),
    [readTextFile, readBinaryPreview, readFileRange, readMediaPreview, stat]
  );
}
