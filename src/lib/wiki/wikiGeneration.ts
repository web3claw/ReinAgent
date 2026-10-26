/**
 * Wiki 生成编排器（ROADMAP ⑨，Hetu RunGenerationCoreAsync 的 TS 版）：
 * 采集（Rust wiki_collect_context）→ 规划（一次调用 + 原文重试 + 模块兜底）→
 * 并行成页（并发 4 + 失败重试 1 + completeOneShotText 内建续写 ≤4 轮）→
 * 总览页（强制 mermaid 架构图）→ 全程进度写库（wiki_job_update）。
 * 用量经 usageSource="wiki" 记账；页面写库走 wiki_write_page（set+sort 唯一）。
 */

import { invoke } from "@tauri-apps/api/core";
import { completeOneShotText } from "../promptEnhancement/enhance";
import type { ProviderConfig } from "../providers/modelFactory";
import {
  buildOverviewPrompt,
  buildPagePrompt,
  buildPlanPrompt,
  buildPlanRepairPrompt,
  fallbackPlanFromModules,
  parseWikiPlan,
  sanitizeWikiContent,
  WIKI_ARCHITECT_SYSTEM_PROMPT,
  WIKI_PAGE_SYSTEM_PROMPT,
  WIKI_OVERVIEW_SYSTEM_PROMPT,
  type WikiContextMaterial,
  type WikiPagePlan,
} from "./wikiLogic";

const PAGE_CONCURRENCY = 4;
const PAGE_RETRY = 1;
const RETRY_BACKOFF_MS = 800;
const CONTINUE_ROUNDS = 4;

export interface WikiJobUpdate {
  status?: number;
  stage?: string;
  progress?: number;
  totalPages?: number;
  donePages?: number;
  setId?: string;
  warning?: string;
  error?: string;
}

function updateJob(jobId: string, patch: WikiJobUpdate): void {
  void invoke("wiki_job_update", { args: { id: jobId, ...patch } }).catch(() => {
    /* 进度写库失败不影响生成 */
  });
}

/** 模型未配置错误（UI 据此引导到场景设置） */
export class WikiModelUnavailableError extends Error {
  constructor() {
    super("Wiki 模型未配置（设置 ▸ 通用 ▸ 场景默认模型 ▸ Wiki 生成），且聊天默认也不可用");
  }
}

export interface WikiRunResult {
  setId: string;
  pageTitles: string[];
  failedPages: string[];
}

/** 执行整套生成。job 由调用方先 wiki_job_create 落库（status 0）。 */
export async function runWikiGeneration(input: {
  jobId: string;
  workspacePath: string;
  projectName: string;
  config: ProviderConfig;
  signal: AbortSignal;
}): Promise<WikiRunResult> {
  const { jobId, workspacePath, projectName, config, signal } = input;
  if (!config) throw new WikiModelUnavailableError();

  // ---- 采集（5%）----
  updateJob(jobId, { status: 1, stage: "采集中", progress: 5 });
  const material = await invoke<WikiContextMaterial>("wiki_collect_context", { workspace: workspacePath });
  if (material.failure) throw new Error(material.failure);
  if (!material.baseContext.trim() && !material.sources.trim()) {
    throw new Error("未能从工作区采集到可用资料（空目录或全部被忽略规则排除）");
  }

  // ---- 规划（10%）：解析失败带原文重试一次，仍失败走模块兜底大纲 ----
  updateJob(jobId, { stage: "规划中", progress: 10 });
  let plans: WikiPagePlan[] | null = null;
  let lastRaw = "";
  try {
    lastRaw = await completeOneShotText(
      config,
      WIKI_ARCHITECT_SYSTEM_PROMPT,
      buildPlanPrompt(projectName, material),
      "off",
      signal,
      "wiki",
    );
    plans = parseWikiPlan(lastRaw);
  } catch (err) {
    if (signal.aborted) throw err;
    lastRaw = String(err);
  }
  if (!plans) {
    try {
      const repair = await completeOneShotText(
        config,
        WIKI_ARCHITECT_SYSTEM_PROMPT,
        buildPlanRepairPrompt(lastRaw),
        "off",
        signal,
        "wiki",
      );
      plans = parseWikiPlan(repair);
    } catch (err) {
      if (signal.aborted) throw err;
    }
  }
  if (!plans || plans.length === 0) {
    plans = fallbackPlanFromModules(material.topLevelModules);
  }
  const setId = `wset-${jobId}`;
  updateJob(jobId, { totalPages: plans.length + 1 });

  // ---- 并行成页（15–85%）：并发池 + 重试 + 内建续写 ----
  const failedPages: string[] = [];
  let done = 0;
  const titles = plans.map((p) => p.title);
  let cursor = 0;
  const worker = async () => {
    while (cursor < plans!.length) {
      if (signal.aborted) return;
      const plan = plans![cursor++];
      let content = "";
      for (let attempt = 0; attempt <= PAGE_RETRY; attempt++) {
        try {
          const raw = await completeOneShotText(
            config,
            WIKI_PAGE_SYSTEM_PROMPT,
            buildPagePrompt({ projectName, plan, siblingTitles: titles, material }),
            "off",
            signal,
            "wiki",
            CONTINUE_ROUNDS,
          );
          content = sanitizeWikiContent(raw);
          break;
        } catch (err) {
          if (signal.aborted) return;
          if (attempt === PAGE_RETRY) break;
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
        }
      }
      if (content.trim()) {
        await invoke("wiki_write_page", {
          args: {
            id: null,
            setId,
            workspace: workspacePath,
            sortOrder: plan.index + 1,
            chapter: plan.chapter,
            title: plan.title,
            brief: plan.brief,
            content,
          },
        }).catch((err) => {
          failedPages.push(plan.title);
          console.warn("[wiki] write page failed:", err);
        });
      } else {
        failedPages.push(plan.title);
      }
      done += 1;
      updateJob(jobId, {
        donePages: done,
        progress: 15 + Math.floor((done * 70) / Math.max(1, plans!.length)),
        stage: `生成页面 ${done}/${plans!.length}`,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(PAGE_CONCURRENCY, plans.length) }, worker));
  if (signal.aborted) throw new Error("已中止");
  if (done === 0 || failedPages.length === plans.length) {
    throw new Error("全部页面生成失败（模型不可用或资料不足）");
  }

  // ---- 总览页（90%）----
  updateJob(jobId, { stage: "生成总览", progress: 90 });
  const generatedMeta = plans
    .filter((p) => !failedPages.includes(p.title))
    .map((p) => ({ chapter: p.chapter, title: p.title, brief: p.brief }));
  const overviewRaw = await completeOneShotText(
    config,
    WIKI_OVERVIEW_SYSTEM_PROMPT,
    buildOverviewPrompt({ projectName, material, generatedPages: generatedMeta }),
    "off",
    signal,
    "wiki",
    CONTINUE_ROUNDS,
  );
  const overviewContent = sanitizeWikiContent(overviewRaw);
  if (!overviewContent.trim()) throw new Error("总览页生成失败（返回空内容）");
  const overviewId = await invoke<string>("wiki_write_page", {
    args: {
      id: null,
      setId,
      workspace: workspacePath,
      sortOrder: 0,
      chapter: "",
      title: projectName,
      brief: "总览",
      content: overviewContent,
    },
  });
  void overviewId;

  // ---- 完成（100%）----
  updateJob(jobId, {
    status: 2,
    stage: "已完成",
    progress: 100,
    donePages: plans.length - failedPages.length + 1,
    setId,
    warning: failedPages.length > 0 ? `${failedPages.length} 页失败：${failedPages.join("、")}` : undefined,
  });
  return { setId, pageTitles: generatedMeta.map((p) => p.title), failedPages };
}

/** 单页重生成（复用既有规划 Brief；workspace 上下文重新采集，保证内容新鲜） */
export async function regenerateWikiPage(input: {
  setId: string;
  sortOrder: number;
  workspacePath: string;
  projectName: string;
  page: { chapter: string; title: string; brief: string; covers: string[] };
  siblingTitles: string[];
  config: ProviderConfig;
  signal: AbortSignal;
}): Promise<string> {
  const { config, signal } = input;
  if (!config) throw new WikiModelUnavailableError();
  const material = await invoke<WikiContextMaterial>("wiki_collect_context", { workspace: input.workspacePath });
  if (material.failure) throw new Error(material.failure);
  const raw = await completeOneShotText(
    config,
    WIKI_PAGE_SYSTEM_PROMPT,
    buildPagePrompt({
      projectName: input.projectName,
      plan: { index: input.sortOrder - 1, chapter: input.page.chapter, title: input.page.title, brief: input.page.brief, covers: input.page.covers },
      siblingTitles: input.siblingTitles,
      material,
    }),
    "off",
    signal,
    "wiki",
    CONTINUE_ROUNDS,
  );
  const content = sanitizeWikiContent(raw);
  if (!content.trim()) throw new Error("重生成返回空内容");
  await invoke("wiki_write_page", {
    args: {
      id: null,
      setId: input.setId,
      workspace: input.workspacePath,
      sortOrder: input.sortOrder,
      chapter: input.page.chapter,
      title: input.page.title,
      brief: input.page.brief,
      content,
    },
  });
  return content;
}
