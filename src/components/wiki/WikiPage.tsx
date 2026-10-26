/**
 * WikiPage —— 项目 Wiki 文档生成（ROADMAP ⑨，Hetu WikiPage 紧凑版）：
 * 工作区选择（最近任务工作区 + 手动输入）→ 生成（job 落库 → TS 编排器执行 →
 * 2s 轮询进度）→ 套件列表 → 章节分组文档树 → 正文查看（Markdown + mermaid）→
 * 单页重生成 / 删除套件 / 一键提取图谱。
 */

import { BookText, Loader2, Network, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "../../i18n";
import { MarkdownText } from "../chat/MarkdownText";
import { toast } from "../lw/ui/toast";
import { useAppStore } from "../../store/useAppStore";
import { WIKI_MODEL_KV_KEY, scenarioBindingToProviderConfig } from "../../lib/settings/scenarioModels";
import { kvGetJSON } from "../../lib/storage/db";
import { loadProvidersConfigFromDisk, type ProviderItem } from "../settings/model-provider/types";
import { useSettings } from "../../lib/settings/useSettings";
import { runWikiGeneration, regenerateWikiPage } from "../../lib/wiki/wikiGeneration";

interface WikiSetInfo {
  setId: string;
  workspace: string;
  title: string;
  pageCount: number;
  generatedAt: number;
}
interface WikiDocMeta {
  id: string;
  setId: string;
  sortOrder: number;
  chapter: string;
  title: string;
  brief: string;
  updatedAt: number;
}
interface WikiJob {
  id: string;
  workspace: string;
  status: number;
  stage: string;
  progress: number;
  totalPages: number | null;
  donePages: number;
  setId: string | null;
  warning: string | null;
  error: string | null;
}
interface WikiDocFull extends WikiDocMeta {
  workspace: string;
  content: string;
}
/** mermaid 围栏拆分渲染（notes 链的 mermaid.render 同源，独立轻量实现） */
function WikiMarkdown({ text }: { text: string }) {
  const theme = useAppStore((s) => s.theme);
  const segments = useMemo(() => {
    const out: { type: "md" | "mermaid"; text: string }[] = [];
    let buffer: string[] = [];
    let inMermaid = false;
    for (const line of text.split("\n")) {
      if (line.trim() === "```mermaid") {
        if (buffer.length) out.push({ type: "md", text: buffer.join("\n") });
        buffer = [];
        inMermaid = true;
        continue;
      }
      if (inMermaid && line.trim() === "```") {
        out.push({ type: "mermaid", text: buffer.join("\n") });
        buffer = [];
        inMermaid = false;
        continue;
      }
      buffer.push(line);
    }
    if (buffer.length) out.push({ type: inMermaid ? "mermaid" : "md", text: buffer.join("\n") });
    return out;
  }, [text]);

  return (
    <div className="wiki-md md">
      {segments.map((seg, i) =>
        seg.type === "md" ? (
          <MarkdownText key={i} text={seg.text} />
        ) : (
          <MermaidBlock key={i} code={seg.text} dark={theme !== "light"} />
        ),
      )}
    </div>
  );
}

function MermaidBlock({ code, dark }: { code: string; dark: boolean }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: dark ? "dark" : "default",
        });
        const { svg: out } = await mermaid.render(`wiki-mmd-${Math.random().toString(36).slice(2)}`, code);
        if (!cancelled) {
          setSvg(out);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, dark]);
  if (error) {
    // 渲染失败如实显示源码（模型可能输出了不支持的图类型）
    return <pre className="overflow-x-auto rounded-lg bg-[var(--bg-elev)] p-3 text-xs text-[var(--warn-text)]">{code}</pre>;
  }
  if (!svg) return <p className="text-xs text-[var(--text-dim)]">渲染图表中…</p>;
  return <div className="my-3 overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] p-3" dangerouslySetInnerHTML={{ __html: svg }} />;
}

const fmtW = (template: string, params: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? ""));

export function WikiPage() {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const tasks = useAppStore((s) => s.tasks);
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  const [workspace, setWorkspace] = useState("");
  const [, setProviders] = useState<ProviderItem[]>([]);
  const [sets, setSets] = useState<WikiSetInfo[]>([]);
  const [activeSetId, setActiveSetId] = useState<string | null>(null);
  const [docs, setDocs] = useState<WikiDocMeta[]>([]);
  const [currentDoc, setCurrentDoc] = useState<WikiDocFull | null>(null);
  const [job, setJob] = useState<WikiJob | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const recentWorkspaces = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const task of tasks) {
      const ws = (task.project ?? "").trim();
      if (ws && !seen.has(ws)) {
        seen.add(ws);
        list.push(ws);
      }
    }
    return list.slice(0, 8);
  }, [tasks]);

  const refreshProviders = useCallback(async () => {
    try {
      setProviders(await loadProvidersConfigFromDisk(settings));
    } catch (err) {
      console.warn("[wiki] load providers failed:", err);
    }
  }, [settings]);
  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  const loadSets = useCallback(async () => {
    try {
      const list = await invoke<WikiSetInfo[]>("wiki_sets_list");
      setSets(list);
      setActiveSetId((prev) => prev ?? list[0]?.setId ?? null);
    } catch (err) {
      console.warn("[wiki] sets load failed:", err);
    }
  }, []);
  useEffect(() => {
    if (isTauri) void loadSets();
  }, [isTauri, loadSets]);

  const loadDocs = useCallback(async (setId: string | null) => {
    if (!setId) {
      setDocs([]);
      return;
    }
    const list = await invoke<WikiDocMeta[]>("wiki_documents_by_set", { setId });
    setDocs(list);
    setCurrentDoc((prev) => (prev && list.some((d) => d.id === prev.id) ? prev : null));
  }, []);
  useEffect(() => {
    void loadDocs(activeSetId);
  }, [activeSetId, loadDocs]);

  const openDoc = useCallback(async (meta: WikiDocMeta) => {
    const full = await invoke<WikiDocFull | null>("wiki_get_document", { id: meta.id });
    if (full) setCurrentDoc(full);
  }, []);

  // 运行中 job 轮询（2s）：进度条 + 完成后刷新套件
  useEffect(() => {
    if (!running || !job?.id) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await invoke<WikiJob | null>("wiki_job_get", { id: job.id });
        if (!next) return;
        setJob(next);
        if (next.status === 2 || next.status === 3) {
          setRunning(false);
          await loadSets();
          if (next.setId) setActiveSetId(next.setId);
          if (next.status === 2) toast.success(t("wikiGenDone"));
          else setError(next.error ?? t("wikiGenFailed"));
        }
      } catch {
        /* 轮询失败下一轮重试 */
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [running, job?.id, loadSets, t]);

  const resolveConfig = useCallback(async () => {
    const list = await loadProvidersConfigFromDisk(settings).catch(() => [] as ProviderItem[]);
    const binding = kvGetJSON<{ providerId: string; modelId: string }>(WIKI_MODEL_KV_KEY);
    const { config } = scenarioBindingToProviderConfig(
      binding && binding.providerId ? binding : null,
      list,
      { provider: settings.provider, modelId: settings.modelId, apiKey: settings.apiKey, baseUrl: settings.baseUrl },
    );
    return config;
  }, [settings]);

  const startGeneration = useCallback(async () => {
    const ws = workspace.trim();
    if (!ws || running) return;
    setError(null);
    const config = await resolveConfig();
    if (!config) {
      setError(t("wikiNoModel"));
      return;
    }
    try {
      const created = await invoke<WikiJob>("wiki_job_create", { workspace: ws });
      setJob(created);
      setRunning(true);
      const projectName = ws.split(/[\\/]/).filter(Boolean).pop() ?? "项目";
      const controller = new AbortController();
      abortRef.current = controller;
      void runWikiGeneration({
        jobId: created.id,
        workspacePath: ws,
        projectName,
        config: config as never,
        signal: controller.signal,
      }).catch((err) => {
        setRunning(false);
        const message = String(err);
        void invoke("wiki_job_update", { args: { id: created.id, status: 3, error: message } }).catch(() => {});
        setError(message);
      });
    } catch (err) {
      setError(String(err));
    }
  }, [workspace, running, resolveConfig, t]);

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
    if (job?.id) {
      void invoke("wiki_job_update", { args: { id: job.id, status: 3, error: "已手动中止" } }).catch(() => {});
    }
    setRunning(false);
  }, [job?.id]);

  const regenerate = useCallback(
    async (meta: WikiDocMeta) => {
      if (regenerating !== null || running) return;
      const config = await resolveConfig();
      if (!config) {
        setError(t("wikiNoModel"));
        return;
      }
      setRegenerating(meta.sortOrder);
      setError(null);
      try {
        const workspacePath = currentDoc?.workspace || sets.find((s) => s.setId === meta.setId)?.workspace || workspace;
        const projectName = workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? "项目";
        await regenerateWikiPage({
          setId: meta.setId,
          sortOrder: meta.sortOrder,
          workspacePath,
          projectName,
          page: { chapter: meta.chapter, title: meta.title, brief: meta.brief, covers: [] },
          siblingTitles: docs.map((d) => d.title),
          config: config as never,
          signal: new AbortController().signal,
        });
        await loadDocs(meta.setId);
        if (currentDoc?.id === meta.id) await openDoc(meta);
        toast.success(t("wikiRegenDone"));
      } catch (err) {
        setError(String(err));
      } finally {
        setRegenerating(null);
      }
    },
    [regenerating, running, resolveConfig, t, currentDoc, sets, workspace, docs, loadDocs, openDoc],
  );

  const extractGraph = useCallback(
    async (meta: WikiDocMeta) => {
      try {
        const full = await invoke<WikiDocFull | null>("wiki_get_document", { id: meta.id });
        if (!full) return;
        const { runGraphExtraction, applyGraphExtraction } = await import("../../lib/knowledge/graphExtract");
        const { GRAPH_MODEL_KV_KEY } = await import("../../lib/settings/scenarioModels");
        const list = await loadProvidersConfigFromDisk(settings).catch(() => [] as ProviderItem[]);
        const binding = kvGetJSON<{ providerId: string; modelId: string }>(GRAPH_MODEL_KV_KEY);
        const { config } = scenarioBindingToProviderConfig(
          binding && binding.providerId ? binding : null,
          list,
          { provider: settings.provider, modelId: settings.modelId, apiKey: settings.apiKey, baseUrl: settings.baseUrl },
        );
        if (!config) {
          setError(t("graphExtractNoModel"));
          return;
        }
        const extracted = await runGraphExtraction(config as never, meta.title, full.content, new AbortController().signal);
        const res = await applyGraphExtraction(`wiki:${meta.id}`, extracted);
        toast.success(fmtW(t("graphExtractDone"), { e: res.newEntities, r: res.newRelations, se: res.skippedEntities, sr: res.skippedRelations }));
      } catch (err) {
        setError(String(err));
      }
    },
    [settings, t],
  );

  const deleteSet = useCallback(
    async (setId: string) => {
      await invoke("wiki_delete_set", { setId });
      await loadSets();
      if (activeSetId === setId) {
        setActiveSetId(null);
        setDocs([]);
        setCurrentDoc(null);
      }
    },
    [loadSets, activeSetId],
  );

  if (!isTauri) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-[var(--text-dim)]">{t("wikiDesktopOnly")}</p>
      </div>
    );
  }

  const chapters = useMemo(() => {
    const groups: { chapter: string; items: WikiDocMeta[] }[] = [];
    for (const d of docs) {
      const last = groups[groups.length - 1];
      if (last && last.chapter === d.chapter) last.items.push(d);
      else groups.push({ chapter: d.chapter, items: [d] });
    }
    return groups;
  }, [docs]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏：工作区 + 生成 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] p-3">
        <BookText className="h-4 w-4 shrink-0 text-[var(--text-dim)]" />
        <span className="text-sm font-semibold">{t("wikiNav")}</span>
        <span className="flex-1" />
        <select
          value={recentWorkspaces.includes(workspace) ? workspace : recentWorkspaces[0] ?? ""}
          onChange={(e) => setWorkspace(e.target.value)}
          className="max-w-72 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-2 py-1.5 text-xs text-[var(--text)] focus:outline-none"
        >
          {recentWorkspaces.length === 0 ? <option value="">{t("wikiNoWorkspaces")}</option> : null}
          {recentWorkspaces.map((ws) => (
            <option key={ws} value={ws}>
              {ws}
            </option>
          ))}
        </select>
        <input
          value={workspace}
          onChange={(e) => setWorkspace(e.target.value)}
          placeholder={t("wikiWorkspacePlaceholder")}
          className="w-64 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-2 py-1.5 text-xs text-[var(--text)] focus:outline-none"
        />
        {running ? (
          <button type="button" onClick={stopGeneration} className="rounded-lg border border-[var(--danger)] px-3 py-1.5 text-xs text-[var(--danger)] hover:bg-[var(--surface-hover)]">
            {t("wikiStop")}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void startGeneration()}
            disabled={!workspace.trim() || recentWorkspaces.length + (workspace.trim() ? 0 : 1) === 0}
            className="rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-1.5 text-xs font-medium text-[var(--brand)] hover:bg-[var(--surface-hover)] disabled:opacity-40"
          >
            {t("wikiGenerate")}
          </button>
        )}
      </div>

      {/* 进度条 */}
      {job && (running || job.status === 1) ? (
        <div className="border-b border-[var(--border)] px-3 py-2">
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 text-[var(--text-dim)]">
              <Loader2 className="h-3 w-3 animate-spin" />
              {job.stage || t("wikiStageRunning")}
            </span>
            <span className="tabular-nums text-[var(--text-dim)]">
              {job.progress}%{job.totalPages ? ` · ${job.donePages}/${job.totalPages}` : ""}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-hover)]">
            <div className="h-full rounded-full bg-[var(--brand)] transition-all" style={{ width: `${job.progress}%` }} />
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="mx-3 mt-2 whitespace-pre-wrap rounded-lg border border-[var(--danger)] bg-[var(--bg-elev)] p-2 text-xs text-[var(--danger)]">{error}</p>
      ) : null}
      {job?.warning ? (
        <p className="mx-3 mt-2 rounded-lg border border-[var(--warn-text)] bg-[var(--bg-elev)] p-2 text-xs text-[var(--warn-text)]">{job.warning}</p>
      ) : null}

      {/* 套件选择 */}
      {sets.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-3 py-2">
          {sets.map((s) => (
            <span key={s.setId} className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${activeSetId === s.setId ? "border-[var(--brand)] text-[var(--brand)]" : "border-[var(--border)] text-[var(--text-dim)]"}`}>
              <button type="button" onClick={() => setActiveSetId(s.setId)} className="max-w-56 truncate" title={s.workspace}>
                {s.title} · {s.pageCount}
              </button>
              <button type="button" onClick={() => void deleteSet(s.setId)} aria-label={t("wikiDeleteSet")} className="text-[10px] hover:text-[var(--danger)]">
                ✕
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {/* 主体：文档树 + 查看器 */}
      <div className="flex min-h-0 flex-1">
        <div className="w-64 shrink-0 overflow-y-auto border-r border-[var(--border)] p-2">
          {docs.length === 0 ? (
            <p className="p-2 text-xs text-[var(--text-dim)]">{t("wikiEmptyHint")}</p>
          ) : (
            chapters.map(({ chapter, items }) => (
              <div key={chapter || "(root)"} className="mb-2">
                {chapter ? <div className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-dim)]">{chapter}</div> : null}
                {items.map((d) => (
                  <div key={d.id} className={`group flex items-center justify-between gap-1 rounded-lg px-2 py-1 ${currentDoc?.id === d.id ? "bg-[var(--surface-hover)]" : "hover:bg-[var(--surface-hover)]"}`}>
                    <button type="button" onClick={() => void openDoc(d)} className="min-w-0 flex-1 truncate text-left text-xs text-[var(--text)]" title={d.title}>
                      {d.sortOrder === 0 ? "📖 " : ""}
                      {d.title}
                    </button>
                    <span className="hidden shrink-0 gap-0.5 group-hover:flex">
                      <button type="button" onClick={() => void regenerate(d)} title={t("wikiRegen")} className="rounded p-0.5 text-[10px] text-[var(--text-dim)] hover:text-[var(--text)]">
                        {regenerating === d.sortOrder ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                      </button>
                      <button type="button" onClick={() => void extractGraph(d)} title={t("graphExtractAction")} className="rounded p-0.5 text-[10px] text-[var(--text-dim)] hover:text-[var(--text)]">
                        <Network className="h-3 w-3" />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto p-4">
          {currentDoc ? (
            <>
              <div className="mb-3">
                <h1 className="text-lg font-semibold text-[var(--text)]">{currentDoc.title}</h1>
                {currentDoc.brief ? <p className="mt-0.5 text-xs text-[var(--text-dim)]">{currentDoc.brief}</p> : null}
                <p className="mt-1 text-[10px] text-[var(--text-dim)]">
                  {fmtW(t("wikiGeneratedAt"), { time: new Date(currentDoc.updatedAt).toLocaleString() })}
                  {currentDoc.workspace ? ` · ${currentDoc.workspace}` : ""}
                </p>
              </div>
              <WikiMarkdown text={currentDoc.content} />
            </>
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="max-w-md text-center text-sm text-[var(--text-dim)]">{t("wikiViewerHint")}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
