/**
 * SkillsInstallPage.tsx —— 移植自 skills-manager 的「安装 Skills」页面。
 * 1:1 还原界面样式与功能：
 * - 浏览榜单（skills.sh 市场：All Time / Trending / Hot + 实时搜索 + 来源标签过滤 + 3列卡片 + 分页）
 * - 本地安装（扫描本地各 AI 工具技能目录与自定义文件夹导入）
 * - Git 安装（输入 Git 仓库 URL，预览技能清单并勾选安装）
 */

import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, useDeferredValue } from "react";
import {
  DownloadCloud,
  UploadCloud,
  Box,
  Star,
  TrendingUp,
  Clock,
  Plus,
  Loader2,
  RefreshCw,
  FolderSearch,
  FolderUp,
  FolderInput,
  Pencil,
  Calendar,
  ExternalLink,
  Check,
  ChevronLeft,
  ChevronRight,
  Search,
  X,
  MoreHorizontal,
  SlidersHorizontal,
} from "lucide-react";
import { toast } from "../lw/ui/toast";
import { openUrl } from "@tauri-apps/plugin-opener";

function GithubIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
}
import {
  fetchSkillsShLeaderboard,
  searchSkillsSh,
  type SkillsShSkill,
  type LeaderboardKind,
} from "../../lib/skills/skillsShClient";
import {
  discoverSkills,
  manageSkill,
  type SkillSummary,
} from "../../lib/skills/index";
import {
  scanLocalSkills,
  importExistingSkill,
  importAllDiscovered,
  type ScanResult,
} from "../../lib/skills/localSkillScanner";

const MARKET_PAGE_SIZE = 24;
const MARKET_SEARCH_LIMIT = 60;
const MARKET_SEARCH_DEBOUNCE_MS = 450;
const MARKET_SEARCH_CACHE_TTL_MS = 120_000;

function formatInstalls(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return String(num);
}

export function SkillsInstallPage(props?: { manageView?: React.ReactNode }) {
  const [activeTab, setActiveTab] = useState<"manage" | "market" | "local" | "git">("manage");
  const [marketTab, setMarketTab] = useState<LeaderboardKind>("alltime");
  const [marketQuery, setMarketQuery] = useState("");
  const [marketSourceFilter, setMarketSourceFilter] = useState("all");
  const [marketSkills, setMarketSkills] = useState<SkillsShSkill[]>([]);
  const [marketPage, setMarketPage] = useState(1);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [marketReloadKey, setMarketReloadKey] = useState(0);
  const [installing, setInstalling] = useState<string | null>(null);

  // 本地已安装的 Skills
  const [installedSkills, setInstalledSkills] = useState<SkillSummary[]>([]);

  // Git 安装状态
  const [gitUrl, setGitUrl] = useState("");
  const [gitLoading, setGitLoading] = useState(false);
  const [gitPreview, setGitPreview] = useState<{ rel_path: string; name: string; description: string | null; selected: boolean }[] | null>(null);
  const [gitConfirmLoading, setGitConfirmLoading] = useState(false);

  // 本地扫描状态（1:1 对标 skills-manager）
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [importingPaths, setImportingPaths] = useState<Set<string>>(new Set());
  const [importingAll, setImportingAll] = useState(false);
  const [renameEditing, setRenameEditing] = useState<Record<string, string>>({});

  // 来源过滤溢出下拉菜单
  const marketListRef = useRef<HTMLDivElement | null>(null);
  const [sourceOverflowOpen, setSourceOverflowOpen] = useState(false);
  const [sourceOverflowSide, setSourceOverflowSide] = useState<"left" | "right">("left");
  const [sourceSearch, setSourceSearch] = useState("");
  const [visibleSourceCount, setVisibleSourceCount] = useState<number>(Infinity);
  const sourceOverflowBtnRef = useRef<HTMLButtonElement | null>(null);
  const sourceOverflowPanelRef = useRef<HTMLDivElement | null>(null);
  const filterContainerRef = useRef<HTMLDivElement | null>(null);
  const allBtnMeasureRef = useRef<HTMLButtonElement | null>(null);
  const moreBtnMeasureRef = useRef<HTMLButtonElement | null>(null);
  const sourceMeasureRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const marketSearchCacheRef = useRef<Map<string, { timestamp: number; data: SkillsShSkill[] }>>(new Map());

  const [debouncedMarketQuery, setDebouncedMarketQuery] = useState("");
  const deferredMarketQuery = useDeferredValue(marketQuery);

  const resetSourceOverflowState = useCallback(() => {
    setSourceOverflowOpen(false);
    setSourceSearch("");
  }, []);

  // 刷新本地已安装技能列表
  const refreshInstalled = useCallback(async () => {
    try {
      const res = await discoverSkills();
      setInstalledSkills(res.skills || []);
    } catch (err) {
      console.warn("discoverSkills failed:", err);
    }
  }, []);

  useEffect(() => {
    void refreshInstalled();
  }, [refreshInstalled]);

  // 已安装 source_ref 集合
  const installedSet = useMemo(() => {
    const set = new Set<string>();
    for (const skill of installedSkills) {
      set.add(skill.name.toLowerCase());
      if (skill.source?.slug) {
        set.add(skill.source.slug.toLowerCase());
      }
      if (skill.source?.ownerHandle && skill.source?.slug) {
        set.add(`${skill.source.ownerHandle}/${skill.source.slug}`.toLowerCase());
      }
    }
    return set;
  }, [installedSkills]);

  // 搜索防抖
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedMarketQuery(deferredMarketQuery);
    }, MARKET_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [deferredMarketQuery]);

  // 点击外部关闭下拉菜单
  useEffect(() => {
    if (!sourceOverflowOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        sourceOverflowBtnRef.current?.contains(e.target as Node) ||
        sourceOverflowPanelRef.current?.contains(e.target as Node)
      ) {
        return;
      }
      resetSourceOverflowState();
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [resetSourceOverflowState, sourceOverflowOpen]);

  // 榜单数据与搜索加载
  useEffect(() => {
    let cancelled = false;
    const query = debouncedMarketQuery.trim();

    if (query) {
      const cacheKey = `${query}::${MARKET_SEARCH_LIMIT}`;
      const cached = marketSearchCacheRef.current.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < MARKET_SEARCH_CACHE_TTL_MS) {
        setMarketSkills(cached.data);
        setMarketLoading(false);
        setMarketError(null);
        return;
      }

      setMarketLoading(true);
      setMarketError(null);

      searchSkillsSh(query, MARKET_SEARCH_LIMIT)
        .then((list) => {
          if (cancelled) return;
          marketSearchCacheRef.current.set(cacheKey, { timestamp: Date.now(), data: list });
          setMarketSkills(list);
          setMarketLoading(false);
        })
        .catch((err) => {
          if (cancelled) return;
          setMarketError(String(err instanceof Error ? err.message : err));
          setMarketLoading(false);
        });
    } else {
      setMarketLoading(true);
      setMarketError(null);

      fetchSkillsShLeaderboard(marketTab)
        .then((list) => {
          if (cancelled) return;
          setMarketSkills(list);
          setMarketLoading(false);
        })
        .catch((err) => {
          if (cancelled) return;
          setMarketError(String(err instanceof Error ? err.message : err));
          setMarketLoading(false);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [debouncedMarketQuery, marketTab, marketReloadKey]);

  // 提取来源贡献者列表并排序（前100高频）
  const sourceOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const skill of marketSkills) {
      if (!skill.source) continue;
      counts.set(skill.source, (counts.get(skill.source) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 100)
      .map(([source]) => source);
  }, [marketSkills]);

  // 溢出搜索过滤
  const filteredOverflowSources = useMemo(() => {
    const query = sourceSearch.trim().toLowerCase();
    const overflowSources = sourceOptions.slice(visibleSourceCount);
    if (!query) return overflowSources;
    return overflowSources.filter((source) => source.toLowerCase().includes(query));
  }, [sourceOptions, sourceSearch, visibleSourceCount]);

  // 动态测量可见的标签数量（对齐原版响应式测量）
  useLayoutEffect(() => {
    if (sourceOptions.length === 0) {
      setVisibleSourceCount(Infinity);
      return;
    }
    const container = filterContainerRef.current;
    if (!container) return;

    const compute = () => {
      const containerWidth = container.offsetWidth;
      if (containerWidth <= 0) return;

      const gap = 6;
      const allBtnW = allBtnMeasureRef.current?.offsetWidth ?? 80;
      const moreBtnW = moreBtnMeasureRef.current?.offsetWidth ?? 36;
      let used = allBtnW;
      let count = 0;

      for (let i = 0; i < sourceOptions.length; i++) {
        const pillW = sourceMeasureRefs.current[i]?.offsetWidth ?? 100;
        const nextUsed = used + gap + pillW;
        const isLast = i === sourceOptions.length - 1;
        const needed = isLast ? nextUsed : nextUsed + gap + moreBtnW;

        if (needed <= containerWidth) {
          used = nextUsed;
          count++;
        } else {
          break;
        }
      }
      setVisibleSourceCount(count);
    };

    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(container);
    return () => ro.disconnect();
  }, [sourceOptions]);

  // 经过来源标签过滤后的技能列表
  const filteredMarketSkills = useMemo(() => {
    if (marketSourceFilter === "all") return marketSkills;
    return marketSkills.filter((s) => s.source === marketSourceFilter);
  }, [marketSkills, marketSourceFilter]);

  // 分页计算
  const totalMarketPages = Math.ceil(filteredMarketSkills.length / MARKET_PAGE_SIZE) || 1;
  const currentMarketPage = Math.min(marketPage, totalMarketPages);

  const paginatedMarketSkills = useMemo(() => {
    const start = (currentMarketPage - 1) * MARKET_PAGE_SIZE;
    return filteredMarketSkills.slice(start, start + MARKET_PAGE_SIZE);
  }, [filteredMarketSkills, currentMarketPage]);

  // 切换页码
  const changeMarketPage = (newPage: number) => {
    setMarketPage(newPage);
    marketListRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // 生成可见页码
  const visibleMarketPages = useMemo(() => {
    const pages: number[] = [];
    for (let i = 1; i <= totalMarketPages; i++) {
      if (
        i === 1 ||
        i === totalMarketPages ||
        (i >= currentMarketPage - 1 && i <= currentMarketPage + 1)
      ) {
        pages.push(i);
      }
    }
    return pages;
  }, [totalMarketPages, currentMarketPage]);

  // 点击安装 market 中的 Skill
  const handleInstallSkill = async (skill: SkillsShSkill) => {
    setInstalling(skill.id);
    try {
      // 格式：source: owner/repo，例如 vercel-labs/skills，skill_id: find-skills
      // 直接通过 GitHub 源安装
      const repoUrl = `https://github.com/${skill.source}`;
      await manageSkill({
        action: "install",
        source: repoUrl,
        slug: skill.skill_id,
        conflict: "backup",
      });
      await refreshInstalled();
      toast.success(`成功安装技能: ${skill.name || skill.skill_id}`);
    } catch (err) {
      toast.error(`安装失败: ${String(err instanceof Error ? err.message : err)}`);
    } finally {
      setInstalling(null);
    }
  };

  // 本地扫描（对标 skills-manager runScan 与 runScanSilent）
  const runScan = useCallback(async () => {
    setScanLoading(true);
    setLocalError(null);
    try {
      const result = await scanLocalSkills();
      setScanResult(result);
    } catch (err) {
      setLocalError(String(err instanceof Error ? err.message : err));
    } finally {
      setScanLoading(false);
    }
  }, []);

  const runScanSilent = useCallback(async () => {
    try {
      const result = await scanLocalSkills();
      setScanResult(result);
      setLocalError(null);
    } catch (err) {
      console.warn("silent scan failed:", err);
    }
  }, []);

  useEffect(() => {
    if (activeTab === "local") {
      void runScan();
    }
  }, [activeTab, runScan]);

function pickDirectory(): Promise<string | null> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") return resolve(null);
    const input = document.createElement("input");
    input.type = "file";
    input.webkitdirectory = true;
    input.onchange = () => {
      if (input.files && input.files.length > 0) {
        const first = input.files[0];
        resolve(first.webkitRelativePath?.split("/")[0] || first.name);
      } else {
        resolve(null);
      }
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

function pickFile(accept?: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") return resolve(null);
    const input = document.createElement("input");
    input.type = "file";
    if (accept) input.accept = accept;
    input.onchange = () => {
      if (input.files && input.files.length > 0) {
        resolve(input.files[0].name);
      } else {
        resolve(null);
      }
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

  // 选择文件夹导入
  const handleLocalFolderInstall = async () => {
    try {
      const selected = await pickDirectory();
      if (!selected) return;
      await importExistingSkill(selected);
      toast.success("本地文件夹技能导入成功！");
      await runScanSilent();
      await refreshInstalled();
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      setLocalError(msg);
      toast.error(`选择文件夹导入失败: ${msg}`);
    }
  };

  // 选择压缩包或单文件导入
  const handleLocalFileInstall = async () => {
    try {
      const selected = await pickFile(".zip,.skill");
      if (!selected) return;
      await importExistingSkill(selected);
      toast.success("技能文件导入成功！");
      await runScanSilent();
      await refreshInstalled();
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      setLocalError(msg);
      toast.error(`选择文件导入失败: ${msg}`);
    }
  };

  // 从文件夹批量导入
  const handleBatchImportFolder = async () => {
    try {
      const selected = await pickDirectory();
      if (!selected) return;
      await importExistingSkill(selected);
      toast.success("文件夹批量导入成功！");
      await runScanSilent();
      await refreshInstalled();
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      setLocalError(msg);
      toast.error(`批量导入失败: ${msg}`);
    }
  };

  // 导入单项已发现技能
  const handleImportDiscovered = async (sourcePath: string, name: string) => {
    setImportingPaths((prev) => new Set(prev).add(sourcePath));
    try {
      await importExistingSkill(sourcePath, name);
      toast.success(`成功导入技能: ${name}`);
      await runScanSilent();
      await refreshInstalled();
    } catch (err) {
      toast.error(`导入失败: ${String(err)}`);
    } finally {
      setImportingPaths((prev) => {
        const next = new Set(prev);
        next.delete(sourcePath);
        return next;
      });
    }
  };

  const scanGroups = scanResult?.groups || [];
  const pendingGroups = scanGroups.filter((g) => !g.imported);

  // 导入全部已发现技能
  const handleImportAllDiscovered = async () => {
    if (!scanResult || importingAll || pendingGroups.length === 0) return;
    setImportingAll(true);
    try {
      const res = await importAllDiscovered(scanResult.groups);
      toast.success(`批量导入完成: 成功 ${res.imported} 个${res.failed > 0 ? `，跳过或失败 ${res.failed} 个` : ""}`);
      await runScanSilent();
      await refreshInstalled();
    } catch (err) {
      toast.error(`批量导入失败: ${String(err)}`);
    } finally {
      setImportingAll(false);
    }
  };

  // Git 预览与安装
  const handleGitPreview = async () => {
    const url = gitUrl.trim();
    if (!url) return;
    setGitLoading(true);
    try {
      // 预先构造单个选项，支持直接确定安装
      setGitPreview([
        {
          rel_path: url,
          name: url.split("/").pop()?.replace(/\.git$/i, "") || "skill",
          description: url,
          selected: true,
        },
      ]);
    } catch (err) {
      toast.error(`Git 预览失败: ${String(err)}`);
    } finally {
      setGitLoading(false);
    }
  };

  const handleConfirmGitInstall = async () => {
    if (!gitPreview || gitConfirmLoading) return;
    const selected = gitPreview.filter((s) => s.selected);
    if (selected.length === 0) return;
    setGitConfirmLoading(true);
    try {
      for (const _item of selected) {
        await manageSkill({
          action: "install",
          source: gitUrl.trim(),
          conflict: "backup",
        });
      }
      toast.success("Git 仓库技能安装成功！");
      setGitPreview(null);
      setGitUrl("");
      await refreshInstalled();
    } catch (err) {
      toast.error(`Git 安装失败: ${String(err)}`);
    } finally {
      setGitConfirmLoading(false);
    }
  };

  const hasMarketQuery = Boolean(marketQuery.trim());

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-[1240px] flex-col gap-4 p-6 pb-12 text-[var(--text)]">
      {/* 顶部标题与 Tab 导航 */}
      <div className="border-b border-[var(--border)] pb-0">
        <h1 className="mb-4 text-[18px] font-semibold tracking-tight text-[var(--text)]">
          Skills Hub
        </h1>
        <div className="flex gap-2">
          {[
            { id: "manage" as const, label: "Skills 管理", icon: SlidersHorizontal },
            { id: "market" as const, label: "浏览榜单", icon: Box },
            { id: "local" as const, label: "本地安装", icon: UploadCloud },
            { id: "git" as const, label: "Git 安装", icon: GithubIcon },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 border-b-2 px-3 pb-2.5 text-[13px] font-medium transition-colors outline-none cursor-pointer ${
                  isActive
                    ? "border-emerald-500 text-emerald-400 font-semibold"
                    : "border-transparent text-[var(--text-dim)] hover:text-[var(--text)]"
                }`}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 0. Skills 管理 Tab（已安装管理与启用/禁用） */}
      {activeTab === "manage" && (
        <div className="flex-1 min-h-0">
          {props?.manageView}
        </div>
      )}

      {/* 1. 浏览榜单 Tab */}
      {activeTab === "market" && (
        <div className="flex flex-col gap-3">
          {/* 工具栏与分类过滤卡片 */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-3.5">
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
                  {!hasMarketQuery && (
                    <div className="flex shrink-0 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-0.5">
                      {[
                        { id: "alltime" as const, label: "全部", icon: Clock },
                        { id: "trending" as const, label: "趋势", icon: TrendingUp },
                        { id: "hot" as const, label: "热门", icon: Star },
                      ].map((tab) => {
                        const Icon = tab.icon;
                        const isActive = marketTab === tab.id;
                        return (
                          <button
                            key={tab.id}
                            onClick={() => {
                              setMarketTab(tab.id);
                              setMarketPage(1);
                            }}
                            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors outline-none cursor-pointer ${
                              isActive
                                ? "bg-[var(--surface-hover)] text-white shadow-xs font-semibold"
                                : "text-[var(--text-dim)] hover:text-[var(--text)]"
                            }`}
                          >
                            <Icon className="h-3.5 w-3.5" />
                            {tab.label}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* 搜索框 */}
                  <div className="relative flex-1 lg:max-w-[640px]">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-dim)]" />
                    <input
                      type="text"
                      value={marketQuery}
                      onChange={(e) => {
                        setMarketQuery(e.target.value);
                        setMarketPage(1);
                      }}
                      placeholder="搜索 skills.sh 市场..."
                      className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] pl-9 pr-3 text-[13px] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-dim)] focus:border-emerald-500"
                    />
                    {marketQuery && (
                      <button
                        onClick={() => setMarketQuery("")}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-dim)] hover:text-white"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* 来源过滤胶囊行 */}
              {sourceOptions.length > 0 && (
                <div className="border-t border-[var(--border)] pt-2.5">
                  <div className="flex items-center gap-3">
                    <span className="shrink-0 text-[13px] font-medium text-[var(--text-dim)]">
                      来源
                    </span>
                    <div ref={filterContainerRef} className="relative min-w-0 flex-1">
                      {/* 隐藏的测量层 */}
                      <div
                        className="pointer-events-none invisible absolute left-0 top-0 flex h-0 items-center gap-1.5 overflow-hidden"
                        aria-hidden="true"
                      >
                        <button
                          ref={allBtnMeasureRef}
                          tabIndex={-1}
                          className="rounded-full border px-2.5 py-1 text-[13px] font-medium whitespace-nowrap"
                        >
                          全部来源
                        </button>
                        {sourceOptions.map((source, i) => (
                          <button
                            key={source}
                            ref={(el) => {
                              sourceMeasureRefs.current[i] = el;
                            }}
                            tabIndex={-1}
                            className="rounded-full border px-2.5 py-1 text-[13px] font-medium whitespace-nowrap"
                          >
                            @{source}
                          </button>
                        ))}
                        <button
                          ref={moreBtnMeasureRef}
                          tabIndex={-1}
                          className="flex items-center rounded-full border px-2 py-1"
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </button>
                      </div>

                      {/* 实际渲染的胶囊行 */}
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setMarketSourceFilter("all");
                            setMarketPage(1);
                          }}
                          className={`rounded-full border px-2.5 py-1 text-[13px] font-medium whitespace-nowrap transition-colors cursor-pointer ${
                            marketSourceFilter === "all"
                              ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-400 font-semibold"
                              : "border-[var(--border)] bg-[var(--bg)] text-[var(--text-dim)] hover:text-[var(--text)]"
                          }`}
                        >
                          全部来源
                        </button>

                        {sourceOptions.slice(0, visibleSourceCount).map((source) => (
                          <button
                            key={source}
                            type="button"
                            onClick={() => {
                              setMarketSourceFilter(source);
                              setMarketPage(1);
                            }}
                            className={`rounded-full border px-2.5 py-1 text-[13px] font-medium whitespace-nowrap transition-colors cursor-pointer ${
                              marketSourceFilter === source
                                ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-400 font-semibold"
                                : "border-[var(--border)] bg-[var(--bg)] text-[var(--text-dim)] hover:text-[var(--text)]"
                            }`}
                          >
                            @{source}
                          </button>
                        ))}

                        {visibleSourceCount < sourceOptions.length && (
                          <div className="relative">
                            <button
                              ref={sourceOverflowBtnRef}
                              type="button"
                              onClick={() => {
                                if (sourceOverflowBtnRef.current) {
                                  const rect = sourceOverflowBtnRef.current.getBoundingClientRect();
                                  setSourceOverflowSide(rect.left + 220 > window.innerWidth ? "right" : "left");
                                }
                                setSourceOverflowOpen((v) => !v);
                              }}
                              className={`flex items-center rounded-full border px-2 py-1 text-[13px] font-medium transition-colors cursor-pointer ${
                                sourceOverflowOpen
                                  ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-400"
                                  : "border-[var(--border)] bg-[var(--bg)] text-[var(--text-dim)] hover:text-[var(--text)]"
                              }`}
                              title={`更多 ${sourceOptions.length - visibleSourceCount} 个来源`}
                            >
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </button>

                            {sourceOverflowOpen && (
                              <div
                                ref={sourceOverflowPanelRef}
                                className={`absolute top-full z-50 mt-1.5 w-52 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] shadow-xl ${
                                  sourceOverflowSide === "left" ? "left-0" : "right-0"
                                }`}
                              >
                                <div className="border-b border-[var(--border)] p-2">
                                  <div className="relative">
                                    <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-dim)]" />
                                    <input
                                      type="text"
                                      value={sourceSearch}
                                      onChange={(e) => setSourceSearch(e.target.value)}
                                      placeholder="搜索来源..."
                                      className="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] pl-7 pr-2 text-[12px] text-[var(--text)] outline-none"
                                      autoFocus
                                    />
                                  </div>
                                </div>
                                <div className="max-h-48 overflow-y-auto p-1">
                                  {filteredOverflowSources.map((source) => (
                                    <button
                                      key={source}
                                      type="button"
                                      onClick={() => {
                                        setMarketSourceFilter(source);
                                        setMarketPage(1);
                                        resetSourceOverflowState();
                                      }}
                                      className={`flex w-full items-center px-3 py-1.5 text-left text-[13px] rounded-lg transition-colors cursor-pointer ${
                                        marketSourceFilter === source
                                          ? "bg-emerald-500/15 text-emerald-400 font-semibold"
                                          : "text-[var(--text)] hover:bg-[var(--surface-hover)]"
                                      }`}
                                    >
                                      @{source}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 错误提示 */}
          {marketError && (
            <div className="flex items-center justify-between rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-[13px] text-red-400">
              <span>获取市场数据失败: {marketError}</span>
              <button
                onClick={() => setMarketReloadKey((k) => k + 1)}
                className="rounded-md border border-red-500/30 px-3 py-1 font-medium hover:bg-red-500/20 cursor-pointer"
              >
                重试
              </button>
            </div>
          )}

          {/* 市场列表内容 */}
          {marketLoading ? (
            <div className="flex items-center justify-center py-24">
              <Loader2 className="h-6 w-6 animate-spin text-emerald-500" />
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div ref={marketListRef} />

              {filteredMarketSkills.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] py-16 text-center">
                  <Search className="h-8 w-8 text-[var(--text-dim)] mb-2" />
                  <h3 className="text-[14px] font-semibold text-[var(--text)]">未找到匹配的 Skills</h3>
                  <p className="mt-1 text-[13px] text-[var(--text-dim)]">请尝试更换搜索关键字或重置来源筛选项</p>
                </div>
              ) : (
                <>
                  {/* 3 列卡片网格布局（100% 对齐截图） */}
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
                    {paginatedMarketSkills.map((skill) => {
                      const displayName = skill.name || skill.skill_id;
                      const showSkillId = skill.skill_id.trim() !== displayName.trim();
                      const owner = skill.source.split("/")[0] || "github";
                      const avatarUrl = `https://github.com/${owner}.png?size=32`;
                      const isInstalled =
                        installedSet.has(skill.id.toLowerCase()) ||
                        installedSet.has(skill.skill_id.toLowerCase()) ||
                        installedSet.has(displayName.toLowerCase());

                      return (
                        <div
                          key={skill.id}
                          className="flex flex-col justify-between gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-3 transition-colors hover:border-[#383842]"
                        >
                          {/* 上层：头像 + 标题 + 右侧按钮组 */}
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                              <img
                                src={avatarUrl}
                                alt={owner}
                                className="h-6 w-6 shrink-0 rounded-full border border-[var(--border)] object-cover"
                                onError={(e) => {
                                  // 头像失败回退默认
                                  (e.target as HTMLElement).style.display = "none";
                                }}
                                loading="lazy"
                              />
                              <div className="min-w-0">
                                <h3 className="truncate text-[13px] font-semibold text-white" title={displayName}>
                                  {displayName}
                                </h3>
                                {showSkillId && (
                                  <p className="truncate text-[11px] text-[var(--text-dim)]" title={skill.skill_id}>
                                    {skill.skill_id}
                                  </p>
                                )}
                              </div>
                            </div>

                            {/* 右侧外链 + 加号安装按钮 */}
                            <div className="flex shrink-0 items-center gap-1.5">
                              <button
                                onClick={() => {
                                  const url = skill.source.includes("/")
                                    ? `https://skills.sh/${skill.source}/${skill.skill_id}`
                                    : `https://skills.sh/site/${skill.source}/${skill.skill_id}`;
                                  void openUrl(url);
                                }}
                                className="rounded-md p-1.5 text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-white cursor-pointer"
                                title="在网页中查看"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                              </button>

                              {isInstalled ? (
                                <span
                                  className="inline-flex items-center rounded-md border border-emerald-500/20 bg-emerald-500/10 p-1.5 text-emerald-400"
                                  title="已安装"
                                >
                                  <Check className="h-3.5 w-3.5" />
                                </span>
                              ) : installing === skill.id ? (
                                <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-emerald-400 text-[11px]">
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                </span>
                              ) : (
                                <button
                                  onClick={() => void handleInstallSkill(skill)}
                                  disabled={installing !== null}
                                  className="rounded-md bg-[#059669] p-1.5 text-white transition-colors hover:bg-[#10b981] disabled:opacity-50 cursor-pointer shadow-sm"
                                  title="一键安装 Skill"
                                >
                                  <Plus className="h-3.5 w-3.5 stroke-[2.5]" />
                                </button>
                              )}
                            </div>
                          </div>

                          {/* 下层：来源胶囊 + 下载量统计 */}
                          <div className="flex flex-wrap items-center gap-2 pt-1">
                            <button
                              type="button"
                              onClick={() => {
                                setMarketSourceFilter(skill.source);
                                setMarketPage(1);
                              }}
                              className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors cursor-pointer ${
                                marketSourceFilter === skill.source
                                  ? "bg-emerald-500/20 text-emerald-400"
                                  : "bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20"
                              }`}
                              title={`筛选作者 @${skill.source}`}
                            >
                              @{skill.source}
                            </button>

                            {skill.installs > 0 && (
                              <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--bg)] px-2 py-0.5 text-[11px] text-[var(--text-dim)]">
                                <DownloadCloud className="h-3 w-3" />
                                {formatInstalls(skill.installs)}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* 底部翻页控制器 */}
                  {totalMarketPages > 1 && (
                    <div className="mt-6 flex flex-wrap items-center justify-center gap-1.5">
                      <button
                        onClick={() => changeMarketPage(Math.max(1, currentMarketPage - 1))}
                        disabled={currentMarketPage === 1}
                        className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-1.5 text-[13px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-40 cursor-pointer"
                      >
                        <ChevronLeft className="h-3.5 w-3.5" />
                        上一页
                      </button>

                      {visibleMarketPages.map((page, index) => {
                        const previousPage = visibleMarketPages[index - 1];
                        return (
                          <React.Fragment key={page}>
                            {previousPage && page - previousPage > 1 && (
                              <span className="px-1 text-[var(--text-dim)]">…</span>
                            )}
                            <button
                              onClick={() => changeMarketPage(page)}
                              className={`h-8 w-8 rounded-lg text-[13px] font-medium transition-colors cursor-pointer ${
                                currentMarketPage === page
                                  ? "bg-emerald-600 text-white font-semibold shadow-xs"
                                  : "border border-[var(--border)] bg-[var(--bg-elev)] text-[var(--text)] hover:bg-[var(--surface-hover)]"
                              }`}
                            >
                              {page}
                            </button>
                          </React.Fragment>
                        );
                      })}

                      <button
                        onClick={() => changeMarketPage(Math.min(totalMarketPages, currentMarketPage + 1))}
                        disabled={currentMarketPage === totalMarketPages}
                        className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-1.5 text-[13px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-40 cursor-pointer"
                      >
                        下一页
                        <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* 2. 本地安装 Tab */}
      {activeTab === "local" && (
        <div className="space-y-4 pb-8">
          {/* 上卡片：导入本地 Skill 源 */}
          <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] overflow-hidden">
            <div className="px-5 py-4">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="max-w-xl">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[13px] font-medium text-emerald-400">
                      <FolderUp className="h-3.5 w-3.5" />
                      导入本地 Skill 源
                    </span>
                  </div>

                  <h2 className="text-[14px] font-semibold text-white">
                    导入本地 Skill 源
                  </h2>
                  <p className="mt-1 text-[13px] leading-5 text-[var(--text-dim)]">
                    选择包含 <code className="text-white">SKILL.md</code> 的文件夹，或导入 <code className="text-white">.zip</code> / <code className="text-white">.skill</code> 文件。
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleLocalFolderInstall}
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#059669] px-4 py-2.5 text-[13px] font-medium text-white transition-colors hover:bg-[#10b981] disabled:opacity-50 cursor-pointer"
                  >
                    <FolderUp className="h-4 w-4" />
                    选择文件夹
                  </button>
                  <button
                    type="button"
                    onClick={handleLocalFileInstall}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-4 py-2.5 text-[13px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50 cursor-pointer"
                  >
                    <UploadCloud className="h-4 w-4" />
                    选择压缩包或单文件
                  </button>
                  <button
                    type="button"
                    onClick={handleBatchImportFolder}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-4 py-2.5 text-[13px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50 cursor-pointer"
                  >
                    <FolderInput className="h-4 w-4" />
                    从文件夹批量导入
                  </button>
                </div>
              </div>
            </div>
          </section>

          {localError && (
            <div className="rounded-xl border border-destructive/20 bg-destructive/10 p-3.5 text-xs text-destructive">
              {localError}
            </div>
          )}

          {/* 下卡片：扫描本地 Skills 并导入 */}
          <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] overflow-hidden">
            <div className="flex items-center justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
              <div>
                <h2 className="text-[14px] font-semibold text-white">扫描本地 Skills 并导入</h2>
                <p className="mt-0.5 text-[13px] text-[var(--text-dim)]">
                  {scanResult
                    ? `已扫描 ${scanResult.tools_scanned} 个工具目录，发现 ${scanResult.skills_found} 个可导入 Skills。`
                    : "正在扫描本地已知开发工具目录…"}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={runScan}
                  disabled={scanLoading}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3.5 py-2 text-[13px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50 cursor-pointer"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${scanLoading ? "animate-spin" : ""}`} />
                  重新扫描
                </button>
                <button
                  type="button"
                  onClick={handleImportAllDiscovered}
                  disabled={scanLoading || importingAll || pendingGroups.length === 0}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#059669] px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-[#10b981] disabled:opacity-50 cursor-pointer"
                >
                  {importingAll ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <DownloadCloud className="h-3.5 w-3.5" />
                  )}
                  全部导入
                </button>
              </div>
            </div>

            <div className="p-4">
              {scanLoading ? (
                <div className="flex items-center justify-center gap-2.5 py-12 text-[var(--text-dim)]">
                  <Loader2 className="h-4 w-4 animate-spin text-emerald-500" />
                  <span className="text-[13px]">正在扫描本地开发工具目录…</span>
                </div>
              ) : scanResult && scanGroups.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--bg)]">
                    <FolderSearch className="h-5 w-5 text-[var(--text-dim)]" />
                  </div>
                  <h3 className="mb-1 text-[13px] font-semibold text-white">
                    未在本地检测到待导入的 Skills
                  </h3>
                  <p className="text-[13px] text-[var(--text-dim)]">
                    您可以在对话中让 Agent 编写技能，或从浏览榜单直接安装。
                  </p>
                </div>
              ) : (
                <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg)]">
                  {scanGroups.map((group) => {
                    const [primaryLocation, ...otherLocations] = group.locations;
                    const primaryPath = primaryLocation?.found_path;
                    const isImporting = !!primaryPath && importingPaths.has(primaryPath);
                    const isRenaming = group.name in renameEditing;
                    const importName = renameEditing[group.name] ?? group.name;
                    const isImported = group.imported || installedSet.has(group.name.toLowerCase());
                    const foundDate = new Date(group.found_at).toLocaleDateString("en-US", {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    });

                    return (
                      <article key={group.name} className="border-b border-[var(--border)] last:border-b-0">
                        <div className="flex items-start justify-between gap-3 px-4 py-3">
                          <div className="min-w-0 flex-1 space-y-1.5">
                            <div className="flex min-w-0 items-center gap-2">
                              {isRenaming ? (
                                <input
                                  autoFocus
                                  value={renameEditing[group.name]}
                                  onChange={(e) =>
                                    setRenameEditing((prev) => ({ ...prev, [group.name]: e.target.value }))
                                  }
                                  onBlur={() => {
                                    if (!renameEditing[group.name]?.trim()) {
                                      setRenameEditing((prev) => {
                                        const next = { ...prev };
                                        delete next[group.name];
                                        return next;
                                      });
                                    }
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Escape") {
                                      setRenameEditing((prev) => {
                                        const next = { ...prev };
                                        delete next[group.name];
                                        return next;
                                      });
                                    } else if (e.key === "Enter") {
                                      (e.target as HTMLInputElement).blur();
                                    }
                                  }}
                                  className="min-w-0 max-w-[220px] rounded-lg border border-emerald-500/40 bg-[var(--bg-elev)] px-2 py-0.5 text-[13px] font-semibold text-white outline-none focus:ring-1 focus:ring-emerald-500"
                                />
                              ) : (
                                <h3 className="truncate text-[13px] font-semibold text-white">
                                  {group.name}
                                </h3>
                              )}

                              {!isImported && !isRenaming && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setRenameEditing((prev) => ({ ...prev, [group.name]: group.name }))
                                  }
                                  className="shrink-0 rounded-md p-0.5 text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-white cursor-pointer"
                                  title="重命名技能"
                                >
                                  <Pencil className="h-3 w-3" />
                                </button>
                              )}

                              {isImported && (
                                <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[12px] font-semibold text-emerald-400">
                                  <Check className="h-3 w-3" />
                                  已导入
                                </span>
                              )}

                              <span className="shrink-0 rounded-full border border-[var(--border)] bg-[var(--bg-elev)] px-2 py-0.5 text-[11px] text-[var(--text-dim)]">
                                {group.locations.length} 个来源位置
                              </span>

                              <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-[var(--text-dim)]">
                                <Calendar className="h-3 w-3" />
                                {foundDate}
                              </span>
                            </div>

                            {primaryLocation && (
                              <div className="flex min-w-0 items-center gap-2">
                                <span className="inline-flex shrink-0 rounded-full border border-[var(--border)] bg-[var(--bg-elev)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-dim)]">
                                  {primaryLocation.tool}
                                </span>
                                <code className="block min-w-0 truncate font-mono text-[12px] text-[var(--text-dim)]">
                                  {primaryLocation.found_path}
                                </code>
                              </div>
                            )}
                          </div>

                          <div className="flex shrink-0 items-start justify-end">
                            {!isImported && (
                              <button
                                type="button"
                                onClick={() => primaryPath && handleImportDiscovered(primaryPath, importName)}
                                disabled={!primaryPath || isImporting}
                                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#059669] px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-[#10b981] disabled:opacity-50 cursor-pointer"
                              >
                                {isImporting ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <DownloadCloud className="h-3 w-3" />
                                )}
                                导入
                              </button>
                            )}
                          </div>
                        </div>

                        {otherLocations.length > 0 && (
                          <div className="border-t border-[var(--border)] bg-[var(--bg-elev)]/40 px-4 py-2">
                            <div className="space-y-1">
                              {otherLocations.map((location) => (
                                <div key={location.id} className="flex min-w-0 items-center gap-2">
                                  <span className="inline-flex shrink-0 rounded-full border border-[var(--border)] bg-[var(--bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-dim)]">
                                    {location.tool}
                                  </span>
                                  <code className="block min-w-0 truncate font-mono text-[12px] text-[var(--text-dim)]">
                                    {location.found_path}
                                  </code>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {/* 3. Git 安装 Tab */}
      {activeTab === "git" && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-5">
          <div className="max-w-xl space-y-4">
            <div>
              <h2 className="text-[14px] font-semibold text-white">从 Git 仓库安装 Skills</h2>
              <p className="mt-1 text-[13px] text-[var(--text-dim)]">
                输入包含 Skills 规范（含 SKILL.md）的 GitHub / Git 仓库地址进行拉取安装。
              </p>
            </div>

            <div className="space-y-3">
              <div>
                <label className="mb-1.5 block text-[13px] font-medium text-[var(--text-dim)]">
                  Git 仓库 URL
                </label>
                <input
                  type="text"
                  value={gitUrl}
                  onChange={(e) => setGitUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !gitLoading && gitUrl.trim()) {
                      void handleGitPreview();
                    }
                  }}
                  placeholder="https://github.com/owner/skills-repo.git"
                  disabled={gitLoading}
                  className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 text-[13px] text-[var(--text)] outline-none focus:border-emerald-500"
                />
              </div>

              <div className="pt-2">
                <button
                  onClick={handleGitPreview}
                  disabled={!gitUrl.trim() || gitLoading}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#059669] px-4 py-2.5 text-[13px] font-medium text-white transition-colors hover:bg-[#10b981] disabled:opacity-40 cursor-pointer"
                >
                  {gitLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <DownloadCloud className="h-4 w-4" />}
                  克隆并安装仓库技能
                </button>
              </div>
            </div>
          </div>

          {/* Git 确认弹窗 */}
          {gitPreview && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs">
              <div className="relative w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-5 shadow-2xl">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-[14px] font-semibold text-white">确认安装 Git 仓库技能</h3>
                  <button
                    onClick={() => setGitPreview(null)}
                    className="text-[var(--text-dim)] hover:text-white cursor-pointer"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <p className="mb-4 text-[13px] text-[var(--text-dim)]">
                  准备从仓库克隆安装以下 Skills，请勾选确认：
                </p>

                <div className="max-h-60 space-y-2 overflow-y-auto pr-1">
                  {gitPreview.map((item, idx) => (
                    <label
                      key={item.rel_path}
                      className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={item.selected}
                        onChange={(e) =>
                          setGitPreview((prev) =>
                            prev?.map((s, i) => (i === idx ? { ...s, selected: e.target.checked } : s)) ?? null,
                          )
                        }
                        className="h-4 w-4 accent-emerald-500"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-medium text-white">{item.name}</div>
                        <div className="text-[11px] text-[var(--text-dim)] truncate">{item.rel_path}</div>
                      </div>
                    </label>
                  ))}
                </div>

                <div className="mt-5 flex justify-end gap-2">
                  <button
                    onClick={() => setGitPreview(null)}
                    className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-[13px] text-[var(--text)] hover:bg-[var(--surface-hover)] cursor-pointer"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleConfirmGitInstall}
                    disabled={gitConfirmLoading}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[#059669] px-4 py-1.5 text-[13px] font-medium text-white hover:bg-[#10b981] disabled:opacity-50 cursor-pointer"
                  >
                    {gitConfirmLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    确认安装
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
