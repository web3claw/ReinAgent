/**
 * 链接收藏工具（2026-11-02，ReinBot 链接收藏管道）：
 * - fetch_article：抓取网页正文（Rust HTTP + dom_query 启发式提取），供大模型总结；
 * - save_clip：总结落盘为「收藏夹」笔记本下的笔记（frontmatter 含来源/渠道/标签），
 *   并调度知识库单源索引（未配置 embedding 时内部如实跳过）。
 *
 * 挂载：IM 三平台（runImTurn extraTools，notify=中间态回执）+ 桌面端 ReinBot 对话。
 * 纯函数（slug/frontmatter）拆在 clipFormat.ts 供 node --test。
 */
import { Type } from "typebox";
import { invoke } from "@tauri-apps/api/core";
import { scheduleKnowledgeIndex } from "../knowledge/autoIndex";

export const CLIP_DEFAULT_NOTEBOOK = "收藏夹";

interface FetchArticleResult {
  title: string;
  site: string;
  text: string;
  charCount: number;
  truncated: boolean;
}

interface ClipSavedResult {
  path: string;
  sourceId: string;
  notebook: string;
}

/** 工具运行状态事件（页面渲染工具卡用）。 */
export interface ClipToolStatusEvent {
  tool: "fetch_article" | "save_clip";
  phase: "start" | "done" | "error";
  detail: string;
}

export interface ClipToolsOptions {
  /** 中间态回执（IM 渠道：先发一条「正在处理」；桌面端流式可见无需发）。 */
  notify?: (text: string) => Promise<void>;
  /** 运行状态回调（桌面端渲染工具卡；IM 渠道可不接）。 */
  onStatus?: (ev: ClipToolStatusEvent) => void;
  /** 来源渠道，写入 frontmatter。 */
  channel?: "qq" | "wechat" | "feishu" | "desktop";
  /** 默认归档笔记本（默认「收藏夹」）。 */
  defaultNotebook?: string;
}

export function createClipTools(options?: ClipToolsOptions) {
  const notify = options?.notify;
  const fetchArticleTool = {
    name: "fetch_article",
    label: "抓取网页文章",
    description:
      "Fetch the main text content of a web page (blog article). Use this when the user sends a URL alone (clip/archive intent) or explicitly asks to summarize/clip a link. Returns the extracted title and plain text. Handles both static and JS-rendered (SPA) pages via a built-in browser fallback (may take 10-40s). NOT for images, videos or download links. If it fails, tell the user the real reason — never claim success.",
    parameters: Type.Object({
      url: Type.String({
        description: "The article URL (must start with http:// or https://)",
        minLength: 1,
      }),
    }),
    execute: async (_toolCallId: string, params: unknown) => {
      const args = params as { url?: string };
      const url = (args?.url ?? "").trim();
      if (!url) {
        throw new Error("fetch_article: url 不能为空");
      }
      options?.onStatus?.({ tool: "fetch_article", phase: "start", detail: new URL(url).host });
      // 中间态回执（尽力而为：失败不打断主流程）
      if (notify) {
        await notify("📖 正在阅读链接并总结，稍候…").catch((err) =>
          console.warn("[clip] 中间态回执失败（忽略）：", err),
        );
      }
      let res: FetchArticleResult;
      try {
        res = await invoke<FetchArticleResult>("im_article_fetch", {
          args: { url },
        });
      } catch (err) {
        options?.onStatus?.({
          tool: "fetch_article",
          phase: "error",
          detail: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      options?.onStatus?.({
        tool: "fetch_article",
        phase: "done",
        detail: `${res.charCount.toLocaleString()} 字 · ${res.site}`,
      });
      return {
        title: res.title,
        site: res.site,
        charCount: res.charCount,
        truncated: res.truncated,
        text: res.text,
      };
    },
  };

  const saveClipTool = {
    name: "save_clip",
    label: "收藏文章归档",
    description:
      "Save the article summary produced from fetch_article into the clip notebook (creates it if missing), with frontmatter (source url/channel/tags), and schedule knowledge-base indexing. Call this AFTER fetch_article and after writing the summary. Returns the saved file path.",
    parameters: Type.Object({
      title: Type.String({
        description: "Article title (used for the file name)",
        minLength: 1,
      }),
      summary: Type.String({
        description:
          "The summary markdown: 核心观点 / 关键要点 / 可行动项. Write in the user's language.",
        minLength: 1,
      }),
      source_url: Type.String({
        description: "The original article URL from fetch_article",
        minLength: 1,
      }),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: "2-4 short topical tags (e.g. [\"rust\", \"架构\"])",
        }),
      ),
      notebook: Type.Optional(
        Type.String({
          description:
            "Target notebook name. Default is the clip notebook. Use only when the user explicitly asks for a specific notebook.",
        }),
      ),
    }),
    execute: async (_toolCallId: string, params: unknown) => {
      const args = params as {
        title?: string;
        summary?: string;
        source_url?: string;
        tags?: string[];
        notebook?: string;
      };
      const title = (args?.title ?? "").trim();
      const summary = (args?.summary ?? "").trim();
      const sourceUrl = (args?.source_url ?? "").trim();
      if (!title || !summary || !sourceUrl) {
        throw new Error("save_clip: title/summary/source_url 均不能为空");
      }
      options?.onStatus?.({ tool: "save_clip", phase: "start", detail: args?.notebook?.trim() || options?.defaultNotebook || "收藏夹" });
      let saved: ClipSavedResult;
      try {
        saved = await invoke<ClipSavedResult>("im_clip_save", {
          args: {
            title,
            summary,
            source_url: sourceUrl,
            tags: (args?.tags ?? []).map((t) => String(t).trim()).filter(Boolean),
            notebook: args?.notebook?.trim() || options?.defaultNotebook || null,
            channel: options?.channel ?? "desktop",
          },
        });
      } catch (err) {
        options?.onStatus?.({
          tool: "save_clip",
          phase: "error",
          detail: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      options?.onStatus?.({
        tool: "save_clip",
        phase: "done",
        detail: saved.path,
      });
      // 知识库自动索引（未配置 embedding 时内部如实跳过）
      scheduleKnowledgeIndex(saved.sourceId);
      return {
        saved: true,
        path: saved.path,
        notebook: saved.notebook,
        sourceId: saved.sourceId,
      };
    },
  };

  return [fetchArticleTool, saveClipTool];
}

