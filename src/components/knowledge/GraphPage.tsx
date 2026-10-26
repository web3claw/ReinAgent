/**
 * GraphPage —— 知识图谱可视化（ROADMAP ⑩，Hetu GraphPage 移植的紧凑自绘版）：
 * Canvas 力导向（手写仿真：库仑斥力 + 弹簧 + 向心，alpha 衰减停机；零依赖），
 * 节点按实体类型分色、半径随关系数增长；拖拽节点 / 滚轮缩放 / 点击选中；
 * 右侧详情面板（描述 + 关系列表 + 删除实体 / 删除关系 / 合并实体）。
 * 数据经 Rust graph_get；提取入口在知识库设置页（笔记源「提取图谱」）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Network, RefreshCw, Search } from "lucide-react";
import { useTranslation, type TranslationKey } from "../../i18n";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store/useAppStore";

interface GraphEntity {
  id: string;
  name: string;
  type: string;
  description: string;
  relationCount: number;
  createdAt: number;
  updatedAt: number;
}
interface GraphRelation {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  sourceEntityName: string;
  targetEntityName: string;
  type: string;
  description: string;
  confidence: number;
  sourceId: string | null;
  createdAt: number;
}
interface GraphData {
  entities: GraphEntity[];
  relations: GraphRelation[];
}

/** Canvas 不识别 CSS var()：经 getComputedStyle 读主题语义变量（类型色复用 usage
 * 图表色板 chart-1..5，边/文字/高亮走 --border/--text-dim/--brand），随 data-theme 切换重读 */
function readCanvasPalette() {
  const cs = getComputedStyle(document.documentElement);
  const pick = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  const chart = (i: number) => pick(`--color-usage-chart-${i}`, "#8b9cf5");
  return {
    types: { concept: chart(1), person: chart(2), organization: chart(3), technology: chart(4), project: chart(5) } as Record<string, string>,
    line: pick("--border", "#3c3c3c"),
    lineDim: pick("--bg-hover", "#262b36"),
    text: pick("--text-dim", "#808080"),
    brand: pick("--brand", "#fab283"),
  };
}

const ENTITY_TYPE_KEYS: Record<string, TranslationKey> = {
  concept: "graphTypeConcept",
  person: "graphTypePerson",
  organization: "graphTypeOrganization",
  technology: "graphTypeTechnology",
  project: "graphTypeProject",
};
const RELATION_TYPE_KEYS: Record<string, TranslationKey> = {
  belong_to: "graphRelBelongTo",
  related_to: "graphRelRelatedTo",
  depends_on: "graphRelDependsOn",
  contains: "graphRelContains",
  compared_with: "graphRelComparedWith",
};

interface SimNode {
  entity: GraphEntity;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed: boolean;
}

const fmtG = (template: string, params: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? ""));

export function GraphPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mergeSourceId, setMergeSourceId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const theme = useAppStore((st) => st.theme);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const palette = useMemo(() => readCanvasPalette(), [theme]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const simRef = useRef<{ alpha: number; running: boolean }>({ alpha: 1, running: true });
  const viewRef = useRef<{ scale: number; ox: number; oy: number }>({ scale: 1, ox: 0, oy: 0 });
  const dragRef = useRef<{ id: string | null; moved: boolean }>({ id: null, moved: false });
  const rafRef = useRef(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await invoke<GraphData>("graph_get");
      setData(next);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 过滤（搜索 + 类型）——不过滤仿真主体，只影响绘制/详情命中
  const visibleIds = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!data) return new Set<string>();
    return new Set(
      data.entities
        .filter((e) => (!typeFilter || e.type === typeFilter) && (!q || e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q)))
        .map((e) => e.id),
    );
  }, [data, query, typeFilter]);

  // 节点初始化 / 数据变更时重建（保留已拖位置）
  useEffect(() => {
    if (!data) return;
    const prev = new Map(nodesRef.current.map((n) => [n.entity.id, n]));
    const cx = canvasRef.current?.width ?? 800;
    const cy = canvasRef.current?.height ?? 600;
    nodesRef.current = data.entities.map((entity, i) => {
      const old = prev.get(entity.id);
      const angle = (i / Math.max(1, data.entities.length)) * Math.PI * 2;
      return old ?? {
        entity,
        x: cx / 2 + Math.cos(angle) * (120 + (i % 7) * 24),
        y: cy / 2 + Math.sin(angle) * (100 + (i % 5) * 26),
        vx: 0,
        vy: 0,
        fixed: false,
      };
    });
    simRef.current = { alpha: 1, running: true };
  }, [data]);

  // 力导向仿真 + 绘制循环
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(50, rect.width * dpr);
      canvas.height = Math.max(50, rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const nodeRadius = (n: SimNode) => 5 + Math.min(9, Math.sqrt(n.entity.relationCount) * 2.2);

    const step = () => {
      const { scale, ox, oy } = viewRef.current;
      const nodes = nodesRef.current;
      const sim = simRef.current;
      if (sim.running && nodes.length > 0) {
        const alpha = sim.alpha;
        // 库仑斥力（O(n²)，节点量级 ≤2000 时按上限截断保护：>800 关闭仿真只渲染）
        if (nodes.length <= 800) {
          for (let i = 0; i < nodes.length; i++) {
            const a = nodes[i];
            for (let j = i + 1; j < nodes.length; j++) {
              const b = nodes[j];
              let dx = b.x - a.x;
              let dy = b.y - a.y;
              let d2 = dx * dx + dy * dy;
              if (d2 < 1) {
                dx = (Math.random() - 0.5) * 2;
                dy = (Math.random() - 0.5) * 2;
                d2 = 4;
              }
              const minD2 = 900;
              const force = (2600 * alpha) / Math.max(d2, minD2);
              const d = Math.sqrt(d2);
              const fx = (dx / d) * force;
              const fy = (dy / d) * force;
              a.vx -= fx;
              a.vy -= fy;
              b.vx += fx;
              b.vy += fy;
            }
          }
        }
        // 弹簧（关系）+ 向心
        const cx = canvas.width / 2 / (window.devicePixelRatio || 1);
        const cy = canvas.height / 2 / (window.devicePixelRatio || 1);
        const byId = new Map(nodes.map((n) => [n.entity.id, n]));
        if (data) {
          for (const rel of data.relations) {
            const a = byId.get(rel.sourceEntityId);
            const b = byId.get(rel.targetEntityId);
            if (!a || !b) continue;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const d = Math.max(1, Math.hypot(dx, dy));
            const target = 110;
            const force = ((d - target) * 0.015 * alpha * 8) / d;
            const fx = dx * force;
            const fy = dy * force;
            a.vx += fx;
            a.vy += fy;
            b.vx -= fx;
            b.vy -= fy;
          }
        }
        for (const n of nodes) {
          n.vx += (cx - n.x) * 0.0015 * alpha;
          n.vy += (cy - n.y) * 0.0015 * alpha;
          if (!n.fixed) {
            n.vx *= 0.82;
            n.vy *= 0.82;
            n.x += n.vx;
            n.y += n.vy;
          } else {
            n.vx = 0;
            n.vy = 0;
          }
        }
        sim.alpha *= 0.995;
        if (sim.alpha < 0.02) sim.running = false;
      }

      // 绘制（CSS 像素坐标 → dpr 变换）
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.translate(ox, oy);
      ctx.scale(scale, scale);
      if (data) {
        const byId = new Map(nodesRef.current.map((n) => [n.entity.id, n]));
        for (const rel of data.relations) {
          const a = byId.get(rel.sourceEntityId);
          const b = byId.get(rel.targetEntityId);
          if (!a || !b) continue;
          const visible = visibleIds.size === 0 || (visibleIds.has(rel.sourceEntityId) && visibleIds.has(rel.targetEntityId));
          const highlighted = selectedId === rel.sourceEntityId || selectedId === rel.targetEntityId;
          ctx.strokeStyle = highlighted ? palette.brand : visible ? palette.line : palette.lineDim;
          ctx.globalAlpha = visible ? (highlighted ? 0.95 : 0.55) : 0.15;
          ctx.lineWidth = highlighted ? 1.8 : 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        for (const n of nodesRef.current) {
          const dim = visibleIds.size > 0 && !visibleIds.has(n.entity.id);
          const r = nodeRadius(n);
          ctx.globalAlpha = dim ? 0.18 : 1;
          ctx.fillStyle = palette.types[n.entity.type] ?? palette.text;
          ctx.beginPath();
          ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
          ctx.fill();
          if (selectedId === n.entity.id || mergeSourceId === n.entity.id) {
            ctx.strokeStyle = palette.brand;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(n.x, n.y, r + 3, 0, Math.PI * 2);
            ctx.stroke();
          }
          // 标签：缩放足够或选中时绘制
          if (!dim && (scale > 0.75 || selectedId === n.entity.id)) {
            ctx.fillStyle = palette.text;
            ctx.font = "11px system-ui, sans-serif";
            ctx.textAlign = "center";
            const label = n.entity.name.length > 14 ? `${n.entity.name.slice(0, 13)}…` : n.entity.name;
            ctx.fillText(label, n.x, n.y + r + 12);
          }
        }
        ctx.globalAlpha = 1;
      }
      ctx.restore();
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
  }, [data, selectedId, mergeSourceId, visibleIds, palette]);

  // 交互：拖拽节点 / 点击选中 / 滚轮缩放
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const toWorld = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const { scale, ox, oy } = viewRef.current;
      return { x: (clientX - rect.left - ox) / scale, y: (clientY - rect.top - oy) / scale };
    };
    const hit = (x: number, y: number): SimNode | null => {
      let best: SimNode | null = null;
      let bestD = Infinity;
      for (const n of nodesRef.current) {
        const r = 5 + Math.min(9, Math.sqrt(n.entity.relationCount) * 2.2) + 4;
        const d = Math.hypot(n.x - x, n.y - y);
        if (d < r && d < bestD) {
          best = n;
          bestD = d;
        }
      }
      return best;
    };
    const onDown = (e: PointerEvent) => {
      const { x, y } = toWorld(e.clientX, e.clientY);
      const node = hit(x, y);
      if (node) {
        node.fixed = true;
        dragRef.current = { id: node.entity.id, moved: false };
        canvas.setPointerCapture(e.pointerId);
      } else {
        dragRef.current = { id: null, moved: false };
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!dragRef.current.id) return;
      const node = nodesRef.current.find((n) => n.entity.id === dragRef.current.id);
      if (!node) return;
      const { x, y } = toWorld(e.clientX, e.clientY);
      node.x = x;
      node.y = y;
      node.vx = 0;
      node.vy = 0;
      dragRef.current.moved = true;
      simRef.current.alpha = Math.max(simRef.current.alpha, 0.3);
      simRef.current.running = true;
    };
    const onUp = (e: PointerEvent) => {
      const wasDrag = dragRef.current.moved;
      const id = dragRef.current.id;
      if (id && !wasDrag) {
        // 点击（非拖拽）：选中 / 合并目标
        if (mergeSourceId && mergeSourceId !== id) {
          const src = mergeSourceId;
          setMergeSourceId(null);
          void invoke("graph_merge_entities", { args: { keepId: id, mergeId: src } })
            .then(() => refresh())
            .catch((err) => setActionError(String(err)));
        } else {
          setSelectedId((prev) => (prev === id ? null : id));
        }
      }
      if (id) {
        const node = nodesRef.current.find((n) => n.entity.id === id);
        if (node) node.fixed = false;
      }
      dragRef.current = { id: null, moved: false };
      canvas.releasePointerCapture?.(e.pointerId);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const view = viewRef.current;
      const next = Math.min(4, Math.max(0.2, view.scale * factor));
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      view.ox = mx - ((mx - view.ox) * next) / view.scale;
      view.oy = my - ((my - view.oy) * next) / view.scale;
      view.scale = next;
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [mergeSourceId, refresh]);

  const selected = data?.entities.find((e) => e.id === selectedId) ?? null;
  const selectedRelations = useMemo(() => {
    if (!data || !selectedId) return [];
    return data.relations.filter((r) => r.sourceEntityId === selectedId || r.targetEntityId === selectedId);
  }, [data, selectedId]);

  const deleteEntity = async (id: string) => {
    try {
      await invoke("graph_delete_entity", { id });
      setSelectedId(null);
      await refresh();
    } catch (err) {
      setActionError(String(err));
    }
  };
  const deleteRelation = async (id: string) => {
    try {
      await invoke("graph_delete_relation", { id });
      await refresh();
    } catch (err) {
      setActionError(String(err));
    }
  };

  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of data?.entities ?? []) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [data]);

  const labelOf = (keyMap: Record<string, TranslationKey>, key: string): string => {
    const k = keyMap[key];
    return k ? t(k) : key;
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Network className="h-4 w-4 text-[var(--text-dim)]" />
          <span className="text-sm font-semibold">{t("graphTitle")}</span>
          <span className="text-xs text-[var(--text-dim)]">
            {fmtG(t("graphStats"), { n: data?.entities.length ?? 0, r: data?.relations.length ?? 0 })}
          </span>
          <span className="flex-1" />
          <div className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-2 py-1">
            <Search className="h-3.5 w-3.5 text-[var(--text-dim)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("graphSearchPlaceholder")}
              className="w-44 bg-transparent text-xs text-[var(--text)] focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            aria-label={t("gitRefresh")}
            className="rounded p-1.5 text-[var(--text-dim)] hover:text-[var(--text)]"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
        {/* 类型过滤 pills */}
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setTypeFilter("")}
            className={`rounded-full px-2 py-0.5 text-[10px] ${typeFilter === "" ? "bg-[var(--surface-hover)] text-[var(--text)]" : "text-[var(--text-dim)] hover:bg-[var(--surface-hover)]"}`}
          >
            {t("graphAllTypes")}
          </button>
          {typeCounts.map(([type, count]) => (
            <button
              key={type}
              type="button"
              onClick={() => setTypeFilter(type === typeFilter ? "" : type)}
              className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ${typeFilter === type ? "bg-[var(--surface-hover)] text-[var(--text)]" : "text-[var(--text-dim)] hover:bg-[var(--surface-hover)]"}`}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: palette.types[type] ?? palette.text }} />
              {labelOf(ENTITY_TYPE_KEYS, type)} · {count}
            </button>
          ))}
        </div>
        {error ? <p className="mb-2 rounded-lg border border-[var(--danger)] bg-[var(--bg-elev)] p-2 text-xs text-[var(--danger)]">{error}</p> : null}
        {actionError ? <p className="mb-2 rounded-lg border border-[var(--warn-text)] bg-[var(--bg-elev)] p-2 text-xs text-[var(--warn-text)]">{actionError}</p> : null}
        {mergeSourceId ? (
          <p className="mb-2 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] p-2 text-xs text-[var(--text-dim)]">{t("graphMergeHint")}</p>
        ) : null}
        {data && data.entities.length === 0 ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="max-w-md text-center text-sm text-[var(--text-dim)]">{t("graphEmptyHint")}</p>
          </div>
        ) : (
          <div ref={wrapRef} className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg)]">
            <canvas ref={canvasRef} className="block h-full w-full cursor-grab active:cursor-grabbing" />
          </div>
        )}
      </div>

      {/* 详情侧栏 */}
      {selected ? (
        <div className="w-72 shrink-0 overflow-y-auto border-l border-[var(--border)] p-3">
          <div className="mb-1 flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: palette.types[selected.type] ?? palette.text }} />
            <span className="truncate text-sm font-semibold text-[var(--text)]" title={selected.name}>
              {selected.name}
            </span>
          </div>
          <div className="mb-2 text-xs text-[var(--text-dim)]">
            {labelOf(ENTITY_TYPE_KEYS, selected.type)} · {fmtG(t("graphRelationCount"), { n: selected.relationCount })}
          </div>
          {selected.description ? <p className="mb-3 text-xs leading-relaxed text-[var(--text-dim)]">{selected.description}</p> : null}
          <div className="mb-2 text-xs font-medium text-[var(--text)]">{t("graphRelationsTitle")}</div>
          <ul className="mb-3 space-y-1">
            {selectedRelations.map((rel) => {
              const other = rel.sourceEntityId === selected.id ? rel.targetEntityName : rel.sourceEntityName;
              return (
                <li key={rel.id} className="flex items-center justify-between gap-1 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-2 py-1 text-xs">
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-[var(--text-dim)]">{labelOf(RELATION_TYPE_KEYS, rel.type)} →</span> {other}
                  </span>
                  <button type="button" onClick={() => void deleteRelation(rel.id)} title={t("graphDeleteRelation")} className="shrink-0 rounded px-1 text-[10px] text-[var(--text-dim)] hover:text-[var(--danger)]">
                    ✕
                  </button>
                </li>
              );
            })}
            {selectedRelations.length === 0 ? <li className="text-xs text-[var(--text-dim)]">{t("graphNoRelations")}</li> : null}
          </ul>
          <div className="space-y-1.5">
            <button
              type="button"
              onClick={() => {
                setMergeSourceId(selected.id);
                setSelectedId(null);
              }}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-2 py-1.5 text-xs text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            >
              {t("graphMergeStart")}
            </button>
            <button
              type="button"
              onClick={() => void deleteEntity(selected.id)}
              className="w-full rounded-lg border border-[var(--danger)] bg-[var(--bg-elev)] px-2 py-1.5 text-xs text-[var(--danger)] transition-colors hover:bg-[var(--surface-hover)]"
            >
              {t("graphDeleteEntity")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
