/**
 * useFileService 适配层 —— 以 Tauri IPC（fs_read_text_file）实现 ZCode IFileService
 * 中 PreviewPane 实际消费的 readTextFile。
 * readBinaryPreview / readMediaPreview / readFileRange / stat 宿主未实现：
 * 如实抛错（No-Fallback，PDF/媒体模式显示真实错误），阶段 2 再评估实现。
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
      throw new Error(`二进制预览在当前宿主中不可用: ${input.path}`);
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
      throw new Error(`分段读取在当前宿主中不可用: ${input.path}`);
    },
    []
  );

  const stat = useCallback(
    async (input: { path: string }): Promise<{ size: number }> => {
      throw new Error(`stat 在当前宿主中不可用: ${input.path}`);
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
