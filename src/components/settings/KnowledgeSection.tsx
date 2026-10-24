/**
 * 设置 ▸ 知识库（RAG v1，docs/ROADMAP.md ①）：
 * - embedding 绑定（服务商/模型 ModelPicker + 手填模型 id）+ 真实「测试 embeddings」；
 * - 索引状态卡（源数/块数/维度/模型/失败源错误列表）；
 * - 「扫描并索引」（带进度）/「清空索引」（二次确认）；
 * - 注入参数（topK）与全局默认开关（composer 任务级开关的兜底值）。
 *
 * No-Fallback：维度从真实响应学习；模型变更 → 警示条 + 显式重建（不混维写入）；
 * 失败源错误原文展示，绝不静默。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import { useHubSettings } from "../../store/hubSettingsStore";
import { ModelPicker, type ModelPickerOption } from "../lw/settings/ModelPicker";
import { createMemoryTranslate } from "../memory/panelModel";
import { embedInputs } from "../../lib/knowledge/embeddingClient";
import { resolveKnowledgeEmbeddingTarget } from "../../lib/knowledge/providerBinding";
import { knowledgeSweep } from "../../lib/knowledge/indexingService";
import { PlugZap, RefreshCw, Trash2, Loader2 } from "lucide-react";

interface KnowledgeStats {
  noteCount: number;
  importCount: number;
  chunkCount: number;
  errorCount: number;
  dims: number | null;
  modelId: string;
  lastIndexedAt: number | null;
}

interface KnowledgeSourceMeta {
  sourceId: string;
  sourceType: "note" | "import";
  title: string;
  status: "ok" | "error";
  error: string | null;
  chunkCount: number;
}

export function KnowledgeSection({ modelOptions }: { modelOptions: Array<{ value: string; label: string; group?: string }> }) {
  const { t: translate, locale } = useTranslation();
  // hub 缺失键先查 extra-memory 词典（chat.searchModel 等 LA 键，同 MemoryPanel）
  const t = useMemo(() => createMemoryTranslate(translate, locale), [translate, locale]);
  const knowledge = useHubSettings((s) => s.settings.knowledge);
  const setSettings = useHubSettings((s) => s.setSettings);

  const [stats, setStats] = useState<KnowledgeStats | null>(null);
  const [errorSources, setErrorSources] = useState<KnowledgeSourceMeta[]>([]);
  const [sweeping, setSweeping] = useState(false);
  const [sweepMessage, setSweepMessage] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const refreshStats = useCallback(async () => {
    try {
      const [nextStats, sources] = await Promise.all([
        import("@tauri-apps/api/core").then(({ invoke }) => invoke<KnowledgeStats>("knowledge_stats")),
        import("@tauri-apps/api/core").then(({ invoke }) => invoke<KnowledgeSourceMeta[]>("knowledge_list_sources")),
      ]);
      setStats(nextStats);
      setErrorSources(sources.filter((s) => s.status === "error"));
    } catch (err) {
      // Rust store 打开失败等：如实横幅，不静默
      const message = err instanceof Error ? err.message : String(err);
      setSweepMessage(message);
    }
  }, []);

  useEffect(() => {
    void refreshStats();
  }, [refreshStats]);

  const pickerValue = knowledge.providerId && knowledge.modelId ? `${knowledge.providerId}::${knowledge.modelId}` : "";
  const pickerOptions: ModelPickerOption[] = modelOptions.map((option) => ({
    value: option.value,
    label: option.label,
    providerName: option.group || t("knowledgeModelColumn"),
  }));

  const handleBindingChange = (value: string) => {
    const index = value.indexOf("::");
    const providerId = index > 0 ? value.slice(0, index) : "";
    const modelId = index > 0 ? value.slice(index + 2) : "";
    setSettings((prev) => ({ ...prev, knowledge: { ...prev.knowledge, providerId, modelId } }));
  };

  const handleModelIdInput = (modelId: string) => {
    setSettings((prev) => ({ ...prev, knowledge: { ...prev.knowledge, modelId: modelId.trim() } }));
  };

  const handleTestEmbedding = async () => {
    setTesting(true);
    setTestResult(null);
    const startTime = Date.now();
    try {
      const target = await resolveKnowledgeEmbeddingTarget();
      const { dims } = await embedInputs(target, ["ping"]);
      setTestResult(`OK · ${dims} 维 · ${Date.now() - startTime}ms`);
      await refreshStats();
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  const handleSweep = async (forceRebuild = false) => {
    setSweeping(true);
    setSweepMessage(null);
    try {
      const result = await knowledgeSweep({
        throwOnUnconfigured: true,
        forceRebuild,
        onProgress: (p) => {
          if (p.phase === "embed" && p.totalSources) {
            setSweepMessage(
              `索引中 ${p.doneSources}/${p.totalSources} · ${p.sourceTitle ?? ""}（已向量化 ${p.embeddedChunks ?? 0} 块）`,
            );
          }
        },
      });
      if (result.skippedUnconfigured) {
        setSweepMessage(t("knowledgeUnconfigured"));
      } else {
        const parts = [
          `${t("knowledgeIndexedLabel")} ${result.indexed}`,
          `${t("knowledgeUnchangedLabel")} ${result.unchanged}`,
          `${t("knowledgeDeletedLabel")} ${result.deleted}`,
        ];
        if (result.errors.length > 0) parts.push(`${t("knowledgeFailedLabel")} ${result.errors.length}`);
        setSweepMessage(parts.join(" · "));
        if (result.errors.length > 0) console.error("[knowledge] sweep errors:", result.errors);
      }
      await refreshStats();
    } catch (err) {
      setSweepMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSweeping(false);
      setConfirmClear(false);
    }
  };

  const handleClear = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      window.setTimeout(() => setConfirmClear(false), 3200);
      return;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("knowledge_index_clear");
      setSweepMessage(t("knowledgeCleared"));
    } catch (err) {
      setSweepMessage(err instanceof Error ? err.message : String(err));
    }
    setConfirmClear(false);
    await refreshStats();
  };

  const modelMismatch = stats && stats.modelId && knowledge.modelId && stats.modelId !== knowledge.modelId;

  return (
    <div className="space-y-5">
      {/* 服务商绑定 */}
      <section className="p-4 rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] space-y-3">
        <div className="font-medium">{t("knowledgeBindingTitle")}</div>
        <p className="text-sm text-[var(--text-dim)]">{t("knowledgeBindingDesc")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-64 max-w-md flex-1">
            <ModelPicker
              value={pickerValue}
              onChange={handleBindingChange}
              options={pickerOptions}
              placeholder={t("knowledgeBindingPlaceholder")}
              noneLabel={t("knowledgeBindingPlaceholder")}
              ariaLabel={t("knowledgeBindingTitle")}
              variant="quiet"
              searchPlaceholder={t("chat.searchModel")}
              emptyLabel={t("chat.noModelFound")}
              collapseProviderLabel={t("chat.collapseProvider")}
              expandProviderLabel={t("chat.expandProvider")}
            />
          </div>
          <input
            value={knowledge.modelId}
            onChange={(e) => handleModelIdInput(e.target.value)}
            placeholder={t("knowledgeModelInputPlaceholder")}
            className="h-9 w-56 rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none focus:border-[var(--accent)]"
          />
          <button
            type="button"
            onClick={handleTestEmbedding}
            disabled={testing || !knowledge.modelId || !knowledge.providerId}
            className="flex items-center gap-1.5 h-9 px-3 rounded-lg border border-[var(--border)] text-sm hover:bg-[var(--surface-hover)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            {testing ? <Loader2 className="w-3.5 h-3.5 animate-pulse" /> : <PlugZap className="w-3.5 h-3.5" />}
            {t("knowledgeTestButton")}
          </button>
        </div>
        {testResult !== null && (
          <p className={`text-sm font-mono break-all ${testResult.startsWith("OK") ? "text-[var(--status-ok,green)]" : "text-[var(--status-err,red)]"}`}>
            {testResult}
          </p>
        )}
        <p className="text-xs text-[var(--text-dim)]">{t("knowledgeModelInputHint")}</p>
      </section>

      {/* 索引状态 */}
      <section className="p-4 rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="font-medium">{t("knowledgeStatsTitle")}</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleSweep(false)}
              disabled={sweeping}
              className="flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[var(--accent)] text-white text-sm hover:bg-[var(--accent-dim)] disabled:opacity-40 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${sweeping ? "animate-spin" : ""}`} />
              {t("knowledgeSweepButton")}
            </button>
            <button
              type="button"
              onClick={() => void handleClear()}
              disabled={sweeping}
              className={`flex items-center gap-1.5 h-8 px-3 rounded-lg border text-sm disabled:opacity-40 cursor-pointer ${
                confirmClear
                  ? "border-[var(--status-err,red)] text-[var(--status-err,red)]"
                  : "border-[var(--border)] hover:bg-[var(--surface-hover)]"
              }`}
            >
              <Trash2 className="w-3.5 h-3.5" />
              {confirmClear ? t("knowledgeClearConfirm") : t("knowledgeClearButton")}
            </button>
          </div>
        </div>
        {modelMismatch ? (
          <div className="rounded-lg border border-[var(--status-warn)] p-3 text-sm space-y-2">
            <p>
              {t("knowledgeModelMismatchPrefix")} {stats?.modelId} → {knowledge.modelId}
            </p>
            <button
              type="button"
              onClick={() => void handleSweep(true)}
              disabled={sweeping}
              className="h-8 px-3 rounded-lg bg-[var(--accent)] text-white text-sm disabled:opacity-40 cursor-pointer"
            >
              {t("knowledgeRebuildButton")}
            </button>
          </div>
        ) : null}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <StatCell label={t("knowledgeStatNotes")} value={String(stats.noteCount)} />
            <StatCell label={t("knowledgeStatImports")} value={String(stats.importCount)} />
            <StatCell label={t("knowledgeStatChunks")} value={String(stats.chunkCount)} />
            <StatCell label={t("knowledgeStatDims")} value={stats.dims ? `${stats.dims}` : t("knowledgeNotIndexed")} />
          </div>
        )}
        {stats?.modelId ? (
          <p className="text-xs text-[var(--text-dim)]">
            {t("knowledgeModelIndexed")}: {stats.modelId}
          </p>
        ) : null}
        {sweepMessage && <p className="text-sm text-[var(--text-dim)] break-all">{sweepMessage}</p>}
        {errorSources.length > 0 && (
          <div className="space-y-1.5">
            {errorSources.map((source) => (
              <p key={source.sourceId} className="text-xs text-[var(--status-err,red)] font-mono break-all">
                {source.title || source.sourceId}: {source.error}
              </p>
            ))}
          </div>
        )}
      </section>

      {/* 注入参数 */}
      <section className="p-4 rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] space-y-3">
        <div className="font-medium">{t("knowledgeInjectTitle")}</div>
        <label className="flex items-center justify-between gap-4">
          <span>
            <span className="block text-sm">{t("knowledgeInjectDefault")}</span>
            <span className="block text-xs text-[var(--text-dim)]">{t("knowledgeInjectDefaultDesc")}</span>
          </span>
          <input
            type="checkbox"
            checked={knowledge.injectEnabledGlobal}
            onChange={(e) =>
              setSettings((prev) => ({ ...prev, knowledge: { ...prev.knowledge, injectEnabledGlobal: e.target.checked } }))
            }
            className="size-4 accent-[var(--accent)]"
          />
        </label>
        <label className="flex items-center justify-between gap-4">
          <span className="text-sm">{t("knowledgeTopK")}</span>
          <input
            type="number"
            min={1}
            max={20}
            value={knowledge.topK}
            onChange={(e) => {
              const next = Math.min(Math.max(Number(e.target.value) || 5, 1), 20);
              setSettings((prev) => ({ ...prev, knowledge: { ...prev.knowledge, topK: next } }));
            }}
            className="h-9 w-24 rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none focus:border-[var(--accent)]"
          />
        </label>
        <p className="text-xs text-[var(--text-dim)]">{t("knowledgeToolHint")}</p>
      </section>
    </div>
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] px-3 py-2">
      <div className="text-xs text-[var(--text-dim)]">{label}</div>
      <div className="text-lg font-medium">{value}</div>
    </div>
  );
}
