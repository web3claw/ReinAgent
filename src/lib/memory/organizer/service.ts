// Organizer service (P1-8, adapted from LiveAgent memory/organizer/service.ts):
// a plain TS engine that owns scheduling and run execution. Scheduling is a
// single one-shot timer armed from organizerNextRunAt — nothing is armed while
// the organizer is disabled, and there is no mount-time forced claim: Run Now
// (poke) is the only entry then.
//
// Adaptations vs LiveAgent: the hidden LLM rounds run through our runTurn
// (agentRuntime nested loop, same as subagents/extraction) instead of LA's
// runAssistantWithTools; provider resolution is injected via `resolveModelDeps`
// (the mount layer reads provider config from disk); debug stream loggers are
// dropped in favour of console warnings.

import {
  type MemoryBatchResponse,
  type MemoryOrganizeRun,
  memoryApplyBatch,
  memoryList,
  memoryOrganizeDueClaim,
  memoryOrganizeDueComplete,
  memoryOrganizeRunUpdate,
  memoryQuotaSummary,
  memoryRead,
} from "../api";
import { ORGANIZER_MAX_WAKE_DELAY_MS, ORGANIZER_RAW_PROTOCOL_CHARS } from "../config";
import { deriveQuotaLadder } from "./quota";
import {
  appliedBatchCount,
  createEmptyRunReport,
  type OrganizeRunReportV4,
} from "./runRecord";
import {
  buildClusterPrompt,
  buildGlobalInventory,
  buildMetaClusterPrompt,
  clipText,
  ORGANIZER_PLAN_TOOL_NAME,
  ORGANIZER_SYSTEM_PROMPT,
  ORGANIZER_TOPIC_TOOL_NAME,
  TOPIC_CLUSTER_SYSTEM_PROMPT,
} from "../prompts/organizer";
import {
  buildDecisions,
  buildStructuralClusters,
  buildTopicClustersFromArgs,
  normalizeOrganizerMode,
  normalizeOrganizerPlanArgs,
  ORGANIZER_PLAN_TOOL,
  ORGANIZER_TOPIC_TOOL,
  type OrganizerCluster,
  type OrganizerClusterPlan,
  type OrganizerEntry,
  type ParsedClusterResult,
  scopeMatchesRun,
} from "./pipeline";
import type { ExtractionModelDeps } from "../extraction/extractionEngine.js";
import type { MemorySettings } from "../../../store/hubSettingsStore";

type OrganizerStats = {
  inputCount: number;
  clusterCount: number;
  safeApplied: number;
  pendingSafeDecisions: number;
  reviewSkipped: number;
  createdCount: number;
  updatedCount: number;
  deletedCount: number;
  mergedCount: number;
  parseFailures: number;
};

function emptyStats(): OrganizerStats {
  return {
    inputCount: 0,
    clusterCount: 0,
    safeApplied: 0,
    pendingSafeDecisions: 0,
    reviewSkipped: 0,
    createdCount: 0,
    updatedCount: 0,
    deletedCount: 0,
    mergedCount: 0,
    parseFailures: 0,
  };
}

function assistantText(assistant: unknown): string {
  const message = assistant as { content?: unknown } | null;
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .map((block: any) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();
}

async function listOrganizerEntries(run: MemoryOrganizeRun, workdir: string) {
  const entries: any[] = [];
  let offset = 0;
  for (;;) {
    const page = await memoryList({
      workdir,
      includeAllProjects: run.scope !== "current-project",
      includeDaily: false,
      limit: 1000,
      offset,
    });
    entries.push(...(page.entries ?? []));
    if (!page.truncated) break;
    offset += (page.entries ?? []).length;
    if ((page.entries ?? []).length === 0) break;
  }
  return entries.filter((entry) => scopeMatchesRun(entry, run, workdir));
}

async function readOrganizerEntries(entries: any[], workdir: string): Promise<OrganizerEntry[]> {
  const out: OrganizerEntry[] = [];
  for (const entry of entries) {
    const read = await memoryRead({
      slug: entry.slug,
      scope: entry.scope,
      workdir: entry.scope === "project" ? entry.workdirPath || workdir : workdir,
      workdirHash: entry.scope === "project" ? entry.workdirHash : undefined,
    });
    out.push({ ...entry, body: read.body });
  }
  return out;
}

/** One hidden LLM round for the organizer; token usage accumulates into `tokens`. */
async function runOrganizerModelPrompt(params: {
  model: ExtractionModelDeps;
  run: MemoryOrganizeRun;
  prompt: string;
  systemPrompt: string;
  tools: unknown[];
  tokens: { total: number };
  signal?: AbortSignal;
}) {
  const { runTurn } = await import("../../agent/agentRuntime.js");
  const result = await runTurn({
    model: params.model.model,
    stream: params.model.stream,
    api: params.model.api,
    label: params.model.label,
    getApiKey: params.model.getApiKey,
    systemPrompt: params.systemPrompt,
    messages: [{ role: "user", content: params.prompt, timestamp: Date.now() }],
    tools: params.tools as any[],
    signal: params.signal,
    thinkingLevel: (params.model.thinkingLevel ?? "off") as any,
    onEvent: () => {},
  });
  for (const message of result.messages) {
    if (message.role === "assistant" && (message as any).usage) {
      const usage = (message as any).usage;
      params.tokens.total += usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0);
    }
  }
  const lastAssistant = [...result.messages].reverse().find((m) => m.role === "assistant");
  return assistantText(lastAssistant);
}

async function runTopicClusterPrompt(params: {
  model: ExtractionModelDeps;
  run: MemoryOrganizeRun;
  prompt: string;
  tokens: { total: number };
  signal?: AbortSignal;
}) {
  let submittedArgs: Record<string, unknown> | null = null;
  const topicTool = {
    ...ORGANIZER_TOPIC_TOOL,
    execute: async (_toolCallId: string, args: unknown) => {
      submittedArgs =
        args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      return {
        content: [
          { type: "text" as const, text: "Topic clusters received. No further protocol output is needed." },
        ],
        details: submittedArgs,
      };
    },
  };
  const rawText = await runOrganizerModelPrompt({
    ...params,
    systemPrompt: TOPIC_CLUSTER_SYSTEM_PROMPT,
    tools: [topicTool],
  });
  if (!submittedArgs) {
    throw new Error(`${ORGANIZER_TOPIC_TOOL_NAME} was not called`);
  }
  return {
    args: submittedArgs,
    raw: clipText(
      [rawText, "", `[${ORGANIZER_TOPIC_TOOL_NAME}]`, JSON.stringify(submittedArgs, null, 2)]
        .filter((part) => part.trim().length > 0)
        .join("\n"),
      ORGANIZER_RAW_PROTOCOL_CHARS,
    ),
  };
}

async function runOrganizerPlanPrompt(params: {
  model: ExtractionModelDeps;
  run: MemoryOrganizeRun;
  prompt: string;
  workdir: string;
  tokens: { total: number };
  signal?: AbortSignal;
}): Promise<OrganizerClusterPlan> {
  const { createMemoryManagerTool } = await import("../memoryManagerTool.js");
  const readManager = createMemoryManagerTool({
    workdir: params.workdir,
    mode: "ro",
    actor: "extractor",
  });
  const captured: {
    plan?: Omit<OrganizerClusterPlan, "raw">;
    args?: Record<string, unknown>;
  } = {};
  const planTool = {
    ...ORGANIZER_PLAN_TOOL,
    execute: async (_toolCallId: string, args: unknown) => {
      captured.args = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      captured.plan = normalizeOrganizerPlanArgs(captured.args);
      return {
        content: [
          { type: "text" as const, text: "Organization plan received. No further protocol output is needed." },
        ],
        details: captured.plan,
      };
    },
  };
  const rawText = await runOrganizerModelPrompt({
    ...params,
    systemPrompt: ORGANIZER_SYSTEM_PROMPT,
    tools: [planTool, readManager],
  });
  if (!captured.plan) {
    throw new Error(`${ORGANIZER_PLAN_TOOL_NAME} was not called`);
  }
  return {
    ...captured.plan,
    raw: clipText(
      [rawText, "", `[${ORGANIZER_PLAN_TOOL_NAME}]`, JSON.stringify(captured.args, null, 2)]
        .filter((part) => part.trim().length > 0)
        .join("\n"),
      ORGANIZER_RAW_PROTOCOL_CHARS,
    ),
  };
}

async function buildOrganizerClusters(params: {
  entries: OrganizerEntry[];
  run: MemoryOrganizeRun;
  model: ExtractionModelDeps;
  workdir: string;
  tokens: { total: number };
  signal?: AbortSignal;
}): Promise<{ clusters: OrganizerCluster[]; rawMeta: string }> {
  if (params.entries.length <= 8) {
    return { clusters: buildStructuralClusters(params.entries), rawMeta: "" };
  }
  try {
    const topicPlan = await runTopicClusterPrompt({
      model: params.model,
      run: params.run,
      prompt: buildMetaClusterPrompt(params.entries),
      tokens: params.tokens,
      signal: params.signal,
    });
    const clusters = buildTopicClustersFromArgs(topicPlan.args, params.entries);
    return {
      clusters: clusters.length > 0 ? clusters : buildStructuralClusters(params.entries),
      rawMeta: topicPlan.raw,
    };
  } catch (error) {
    console.warn("memory organizer topic clustering failed", error);
    return { clusters: buildStructuralClusters(params.entries), rawMeta: "" };
  }
}

async function executeOrganizerRun(
  run: MemoryOrganizeRun,
  model: ExtractionModelDeps,
  workdir: string,
  advanceScheduled: (run: MemoryOrganizeRun) => void,
  signal?: AbortSignal,
) {
  const startedAt = Date.now();
  const tokens = { total: 0 };
  const stats = emptyStats();
  const report: OrganizeRunReportV4 = createEmptyRunReport();

  // --- scan -----------------------------------------------------------------
  await memoryOrganizeRunUpdate({ runId: run.runId, status: "running", startedAt, phase: "scan" });
  const quotaSummary = await memoryQuotaSummary({ workdir: workdir || undefined }).catch(() => null);
  const ladder = deriveQuotaLadder(quotaSummary);
  const quotaHeadroomAtStart = ladder.tightestScope?.headroom;

  try {
    const metas = await listOrganizerEntries(run, workdir);
    const entries = await readOrganizerEntries(metas, workdir);
    stats.inputCount = entries.length;

    if (entries.length === 0) {
      await memoryOrganizeRunUpdate({
        runId: run.runId,
        status: "skipped",
        finishedAt: Date.now(),
        finalSummary: buildFinalSummary(stats),
        inputCount: 0,
        clusterCount: 0,
        phase: "scan",
        quotaHeadroomAtStart,
        tokenUsageTotal: tokens.total,
        report,
      });
      advanceScheduled(run);
      return;
    }

    // --- cluster --------------------------------------------------------------
    await memoryOrganizeRunUpdate({
      runId: run.runId,
      phase: "cluster",
      inputCount: stats.inputCount,
      quotaHeadroomAtStart,
    });
    const clusterPlan = await buildOrganizerClusters({
      entries,
      run,
      model,
      workdir,
      tokens,
      signal,
    });
    const clusters = clusterPlan.clusters;
    stats.clusterCount = clusters.length;
    const globalInventory = buildGlobalInventory(entries, new Map());
    if (clusterPlan.rawMeta) {
      report.raw.push({ clusterId: "__topic_clustering__", text: clusterPlan.rawMeta });
    }
    report.compressionForecast = {
      from: entries.length,
      toMin: Math.max(0, Math.floor(entries.length * 0.6)),
      toMax: Math.max(0, Math.ceil(entries.length * 0.8)),
    };

    // --- plan -----------------------------------------------------------------
    await memoryOrganizeRunUpdate({
      runId: run.runId,
      phase: "plan",
      clusterCount: stats.clusterCount,
      tokenUsageTotal: tokens.total,
    });
    const mode = normalizeOrganizerMode(run.mode);
    const parsedResults: ParsedClusterResult[] = [];
    for (const cluster of clusters) {
      try {
        const plan = await runOrganizerPlanPrompt({
          model,
          run,
          prompt: buildClusterPrompt({
            trigger: run.trigger,
            mode,
            clusterId: cluster.id,
            entries: cluster.entries,
            globalInventory,
            compressionTarget: ladder.compressionTarget,
          }),
          workdir,
          tokens,
          signal,
        });
        parsedResults.push({ cluster, plan });
        report.clusterSummaries.push(plan.summary);
        report.raw.push({ clusterId: cluster.id, text: plan.raw });
      } catch (error) {
        stats.parseFailures += 1;
        report.reviewItems.push({
          phase: "planning",
          kind: "error",
          severity: "error",
          message: `Cluster ${cluster.id} plan submission failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }

    if (parsedResults.length === 0 && stats.parseFailures > 0) {
      const message = `所有 ${stats.parseFailures} 个分组都未提交有效整理计划，已跳过本次写入。`;
      report.reviewItems.push({ phase: "system", kind: "error", severity: "error", message });
      await memoryOrganizeDueComplete({
        runId: run.runId,
        status: "failed",
        finishedAt: Date.now(),
        inputCount: stats.inputCount,
        clusterCount: stats.clusterCount,
        parseFailures: stats.parseFailures,
        error: message,
        finalSummary: `本次记忆整理失败：${message}请重新运行或调整记忆整理模型。`,
        phase: "plan",
        quotaHeadroomAtStart,
        tokenUsageTotal: tokens.total,
        report,
      });
      advanceScheduled(run);
      return;
    }

    // --- gate -----------------------------------------------------------------
    await memoryOrganizeRunUpdate({ runId: run.runId, phase: "gate" });
    const gated = buildDecisions(parsedResults, run);
    stats.reviewSkipped += gated.reviewSkipped;
    stats.mergedCount = gated.mergedCount;
    report.rejectionBuckets = gated.rejectionBuckets;
    report.reviewItems.push(...gated.reviewItems);

    // --- apply ----------------------------------------------------------------
    await memoryOrganizeRunUpdate({ runId: run.runId, phase: "apply" });
    let batch: MemoryBatchResponse = { created: [], updated: [], deleted: [], warnings: [] };
    if (run.trigger === "manual") {
      stats.pendingSafeDecisions = gated.decisions.length;
      report.safeDecisions = gated.decisions;
      report.manualApplyState = {
        status: "pending",
        appliedDecisionKeys: [],
        failedDecisionKeys: [],
      };
    } else if (gated.decisions.length > 0) {
      batch = await memoryApplyBatch({
        workdir,
        trigger: "memory-organize",
        model: model.label,
        decisions: gated.decisions,
      });
      stats.createdCount = batch.created.length;
      stats.updatedCount = batch.updated.length;
      stats.deletedCount = batch.deleted.length;
      stats.safeApplied = appliedBatchCount(batch);
      stats.reviewSkipped += batch.warnings.length;
      for (const warning of batch.warnings) {
        report.reviewItems.push({ phase: "apply", kind: "error", severity: "error", message: warning });
      }
    }

    const finalCount = Math.max(0, stats.inputCount - stats.deletedCount + stats.createdCount);
    await memoryOrganizeDueComplete({
      runId: run.runId,
      status: "succeeded",
      finishedAt: Date.now(),
      inputCount: stats.inputCount,
      clusterCount: stats.clusterCount,
      safeApplied: stats.safeApplied,
      reviewSkipped: stats.reviewSkipped,
      createdCount: stats.createdCount,
      updatedCount: stats.updatedCount,
      deletedCount: stats.deletedCount,
      mergedCount: stats.mergedCount,
      parseFailures: stats.parseFailures,
      finalSummary: buildFinalSummary(stats),
      phase: "apply",
      finalCount,
      compressionRatio: stats.inputCount > 0 ? finalCount / stats.inputCount : undefined,
      compressionTarget: ladder.compressionTarget,
      quotaHeadroomAtStart,
      tokenUsageTotal: tokens.total,
      report,
    });

    advanceScheduled(run);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await memoryOrganizeDueComplete({
      runId: run.runId,
      status: "failed",
      finishedAt: Date.now(),
      inputCount: stats.inputCount,
      clusterCount: stats.clusterCount,
      safeApplied: stats.safeApplied,
      reviewSkipped: stats.reviewSkipped,
      createdCount: stats.createdCount,
      updatedCount: stats.updatedCount,
      deletedCount: stats.deletedCount,
      mergedCount: stats.mergedCount,
      parseFailures: stats.parseFailures,
      error: message,
      finalSummary: `本次记忆整理失败：${message}`,
      quotaHeadroomAtStart,
      tokenUsageTotal: tokens.total,
      report,
    });
    advanceScheduled(run);
  }
}

function buildFinalSummary(stats: OrganizerStats) {
  if (stats.inputCount === 0) {
    return "本次记忆整理未找到可整理的普通记忆，未进行任何写入。";
  }
  const failureNote =
    stats.parseFailures > 0 ? `；${stats.parseFailures} 个分组未提交有效计划，已局部跳过` : "";
  if (stats.pendingSafeDecisions > 0) {
    return `本次整理覆盖 ${stats.inputCount} 条记忆、${stats.clusterCount} 个分组，已生成 ${stats.pendingSafeDecisions} 条安全建议，等待你在历史记录中确认应用；${stats.reviewSkipped} 条风险建议已跳过并保存在历史详情中${failureNote}。`;
  }
  return `本次整理覆盖 ${stats.inputCount} 条记忆、${stats.clusterCount} 个分组，已应用 ${stats.safeApplied} 条安全建议，新增 ${stats.createdCount} 条、更新 ${stats.updatedCount} 条、删除 ${stats.deletedCount} 条；${stats.reviewSkipped} 条风险建议已跳过并保存在历史详情中${failureNote}。`;
}

export type MemoryOrganizerService = {
  /** Re-arm the wake timer from current settings (call on settings change). */
  configure: () => void;
  /** Run Now / external trigger: claim and execute immediately. */
  poke: () => void;
  dispose: () => void;
};

export type MemoryOrganizerServiceDeps = {
  getSettings: () => MemorySettings;
  /** 推进调度（scheduled 运行收束后回写 organizerLastRunAt/NextRunAt）。 */
  advanceSchedule: (nowMs: number) => void;
  /** 把 settings.memory.organizerModel 解析成可运行的模型依赖（找不到时抛带原因的错误）。 */
  resolveModelDeps: (settings: MemorySettings) => Promise<ExtractionModelDeps>;
  getWorkspaceRoot: () => string;
};

export function createMemoryOrganizerService(deps: MemoryOrganizerServiceDeps): MemoryOrganizerService {
  let disposed = false;
  let running = false;
  let wakeTimeout: ReturnType<typeof setTimeout> | null = null;

  function clearWake() {
    if (wakeTimeout === null) return;
    clearTimeout(wakeTimeout);
    wakeTimeout = null;
  }

  function scheduledDelayMs(): number | null {
    const current = deps.getSettings();
    if (!current.organizerEnabled || current.organizerSchedule.frequency === "none") {
      return null;
    }
    const dueAt = current.organizerNextRunAt;
    if (typeof dueAt !== "number" || !Number.isFinite(dueAt) || dueAt <= 0) {
      return null;
    }
    return Math.max(0, dueAt - Date.now());
  }

  function scheduleNextWake() {
    clearWake();
    if (disposed) return;
    const delay = scheduledDelayMs();
    if (delay === null) return;
    wakeTimeout = setTimeout(() => void tick(false), Math.min(delay, ORGANIZER_MAX_WAKE_DELAY_MS));
  }

  async function tick(forceClaim: boolean) {
    if (disposed || running) return;
    const memory = deps.getSettings();
    const model = memory.organizerModel;
    const delay = scheduledDelayMs();
    // Forced pokes (Run Now) always try to claim; otherwise only a due
    // schedule does. A disabled organizer never claims on its own.
    const shouldClaim =
      forceClaim ||
      delay === 0 ||
      (delay === null && memory.organizerEnabled && Boolean(model));
    if (!shouldClaim) {
      scheduleNextWake();
      return;
    }
    running = true;
    try {
      const claim = await memoryOrganizeDueClaim({
        enabled: memory.organizerEnabled,
        dueAt: memory.organizerNextRunAt ?? undefined,
        now: Date.now(),
        model,
        scope: memory.organizerScope,
        mode: memory.organizerMode,
      });
      if (claim.run) {
        if (claim.run.status === "skipped") {
          deps.advanceSchedule(Date.now());
        } else {
          const modelDeps = await deps.resolveModelDeps(memory);
          await executeOrganizerRun(
            claim.run,
            modelDeps,
            deps.getWorkspaceRoot(),
            () => deps.advanceSchedule(Date.now()),
          );
        }
      }
    } catch (error) {
      console.error("memory organizer service failed", error);
    } finally {
      running = false;
      scheduleNextWake();
    }
  }

  return {
    configure() {
      // Settings changed: re-arm the timer; claim only if already due.
      void tick(false);
    },
    poke() {
      void tick(true);
    },
    dispose() {
      disposed = true;
      clearWake();
    },
  };
}

// ---------------------------------------------------------------------------
// Module singleton so UI surfaces (Run Now button) can poke without prop
// drilling. The hook installs/uninstalls the instance.
// ---------------------------------------------------------------------------

let activeService: MemoryOrganizerService | null = null;

export function installMemoryOrganizerService(service: MemoryOrganizerService | null) {
  activeService = service;
}

/** Run Now entry. Returns false when no organizer service is installed. */
export function pokeMemoryOrganizer(): boolean {
  if (!activeService) return false;
  activeService.poke();
  return true;
}
