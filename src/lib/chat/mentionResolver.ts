/**
 * mentionResolver.ts —— 把输入文本里的 @提及 解析为注入块（读取走 IPC）。
 *
 * 与 Composer 的分工：Composer 负责把 `@路径` 插进输入框；这里负责在**发送时**
 * 读取被提及文件/目录的内容并组装成注入块，由 App 追加到 user 消息尾部。
 *
 * No-Fallback：读取失败的文件不静默丢弃——注入块里如实标注 `[unavailable: ...]`，
 * 让模型知道用户引用了一个读不到的文件。
 */

import {
  buildMentionBlock,
  capMentionContent,
  extractMentions,
  MENTION_MAX_DIR_ENTRIES,
  type MentionRef,
} from "./mentions";
import { resolveWorkspacePath } from "../agent/workspace";

export interface MentionResolveResult {
  /** 注入块（无提及 / 全部无法解析时为空串） */
  block: string;
  /** 实际解析的提及数（含失败项，供 UI/日志） */
  resolved: number;
}

/**
 * 解析并读取文本中的全部 @提及。
 * @param text 用户输入原文（含 `@path` 标记）
 * @param workspaceRoot 工作区根（相对路径的解析基准）
 */
export async function resolveMentions(
  text: string,
  workspaceRoot: string,
): Promise<MentionResolveResult> {
  const refs: MentionRef[] = extractMentions(text);
  if (refs.length === 0) return { block: "", resolved: 0 };

  const { invoke } = await import("@tauri-apps/api/core");
  const entries: Parameters<typeof buildMentionBlock>[0] = [];

  for (const ref of refs) {
    const target = safeResolve(ref.path, workspaceRoot);
    if (!target) {
      entries.push({ path: ref.path, kind: ref.kind, error: "工作区根目录未知，无法解析相对路径" });
      continue;
    }
    try {
      if (ref.kind === "dir") {
        const listing = await invoke<string[]>("fs_list_dir", { path: target });
        const names = Array.isArray(listing) ? listing : [];
        const truncated = names.length > MENTION_MAX_DIR_ENTRIES;
        entries.push({
          path: ref.path,
          kind: "dir",
          entries: names.slice(0, MENTION_MAX_DIR_ENTRIES),
          truncated,
        });
      } else {
        const content = await invoke<string>("fs_read_file", { path: target });
        const capped = capMentionContent(typeof content === "string" ? content : "");
        entries.push({
          path: ref.path,
          kind: "file",
          content: capped.content,
          truncated: capped.truncated,
        });
      }
    } catch (err) {
      // 如实上报（文件不存在 / 是二进制 / 权限不足…）
      entries.push({
        path: ref.path,
        kind: ref.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    block: buildMentionBlock(entries),
    resolved: entries.length,
  };
}

/** resolveWorkspacePath 的安全包装：工作区未知时返回 null（不抛错，由调用方如实标注）。 */
function safeResolve(path: string, workspaceRoot: string): string | null {
  try {
    return resolveWorkspacePath(path, workspaceRoot);
  } catch {
    return null;
  }
}

/**
 * 把注入块拼到用户文本尾部（对齐 ZCode/LiveAgent：挂当轮 user 消息，不进系统提示词）。
 * 无块时原样返回。
 */
export function appendMentionBlock(text: string, block: string): string {
  if (!block) return text;
  return `${text}\n\n${block}`;
}
