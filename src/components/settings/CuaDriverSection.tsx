import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  Replace,
  ShieldOff,
  Video,
  Accessibility,
} from "lucide-react";
import { useTranslation } from "../../i18n";
import { Button } from "../lw/ui/button";
import { Switch } from "../lw/ui/switch";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../lw/ui/dialog";
import { toast } from "../lw/ui/toast";
import type { McpServerConfig } from "../../lib/hub/mcpTypes";
import type { ToolPolicy } from "../../lib/hub/mcpServerDefaults";
import {
  buildCuaServerConfig,
  CUA_DEFAULT_TIMEOUT_MS,
  CUA_INSTALL_PROGRESS_EVENT,
  CUA_UPSTREAM_REPO_URL,
  type CuaInstallPreview,
  type CuaInstallProgress,
  type CuaPermissions,
  type CuaProbe,
  cuaCommandDrift,
  cuaDisplayCommand,
  findCuaDriverServer,
  findCuaDriverServerIndex,
  getCuaAllowSelf,
  getCuaPolicy,
  patchCuaProbeCachePermissions,
  readCuaProbeCache,
  realignCuaServerConfig,
  setCuaAllowSelf,
  setCuaPolicy,
  writeCuaProbeCache,
} from "../../lib/mcp/cuaDriverForm";

const TIMEOUT_PRESETS = [
  { label: "30s", value: 30_000 },
  { label: "60s", value: 60_000 },
  { label: "120s", value: 120_000 },
  { label: "300s", value: 300_000 },
];

export function CuaDriverSection() {
  const { t } = useTranslation();

  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [probe, setProbe] = useState<CuaProbe | null>(null);
  const [permissions, setPermissions] = useState<CuaPermissions | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [granting, setGranting] = useState(false);
  const [preview, setPreview] = useState<CuaInstallPreview | null>(null);
  const [installLog, setInstallLog] = useState<string[]>([]);
  const [setupOpen, setSetupOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [selectedStep, setSelectedStep] = useState<number | null>(null);

  const [policy, setPolicyState] = useState<ToolPolicy>(getCuaPolicy());
  const [allowSelfTargeting, setAllowSelfTargetingState] = useState<boolean>(getCuaAllowSelf());

  const serverEntry = useMemo(() => findCuaDriverServer(servers), [servers]);
  const enabled = Boolean(serverEntry?.enabled);
  const installed = Boolean(probe?.installed);

  const permissionsRequired = Boolean(probe?.permissionsRequired);
  const permissionsReady =
    installed && (!permissionsRequired || (permissions?.accessibility && permissions?.screenRecording));

  const setupStep = !installed ? 0 : !permissionsReady ? 1 : 2;
  const viewedStep = selectedStep ?? setupStep;
  const steps = ["stepInstall", "stepGrant", "stepEnable"] as const;

  const currentTimeout = serverEntry?.timeoutMs ?? CUA_DEFAULT_TIMEOUT_MS;
  const commandDrift = useMemo(() => cuaCommandDrift(serverEntry, probe), [serverEntry, probe]);
  const displayCommand = useMemo(() => cuaDisplayCommand(serverEntry, probe), [serverEntry, probe]);

  const capabilities = [
    { key: "capWindows", label: t("cuaCapWindows") },
    { key: "capScreenshot", label: t("cuaCapScreenshot") },
    { key: "capMouse", label: t("cuaCapMouse") },
    { key: "capKeyboard", label: t("cuaCapKeyboard") },
    { key: "capMenu", label: t("cuaCapMenu") },
    { key: "capBrowser", label: t("cuaCapBrowser") },
  ];

  // 加载 MCP 列表与驱动检测
  const refresh = useCallback(
    async (options?: { force?: boolean }) => {
      setChecking(true);
      try {
        const loadedServers = await invoke<McpServerConfig[]>("mcp_list_servers").catch(() => []);
        setServers(loadedServers);

        const cached = options?.force ? null : readCuaProbeCache();
        let probed = cached?.probe ?? null;
        let perms = cached?.permissions ?? null;

        if (!probed) {
          probed = await invoke<CuaProbe>("cua_driver_probe");
          if (probed.permissionsRequired) {
            perms = await invoke<CuaPermissions>("cua_driver_permissions_status").catch(() => null);
          }
          writeCuaProbeCache(probed, perms);
        }

        setProbe(probed);
        setPermissions(perms);
      } catch (err) {
        console.warn("[cua] probe failed:", err);
      } finally {
        setChecking(false);
      }
    },
    [],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 总开关切换
  const toggleEnabled = async (next: boolean) => {
    if (!probe?.installed) {
      toast.warning(t("cuaNotInstalledTitle"), { description: t("cuaNotInstalledDesc") });
      return;
    }
    const idx = findCuaDriverServerIndex(servers);
    let nextServers: McpServerConfig[];

    if (idx >= 0) {
      nextServers = servers.map((s, i) => (i === idx ? { ...s, enabled: next } : s));
    } else {
      const created = buildCuaServerConfig(probe);
      created.enabled = next;
      nextServers = [...servers, created];
    }

    try {
      await invoke("mcp_save_servers", { servers: nextServers });
      setServers(nextServers);
      toast.success(next ? t("cuaEnable") : t("cuaDisable"), {
        description: next ? t("cuaEnablePreview") : undefined,
      });
    } catch (err) {
      toast.error("保存失败", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // 触发安装流程
  const beginInstall = async () => {
    try {
      const prev = await invoke<CuaInstallPreview>("cua_driver_install_command");
      setPreview(prev);
      setInstallLog([]);
      setSelectedStep(0);
      setSetupOpen(true);
    } catch (err) {
      toast.error("获取安装命令失败", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // 确认执行安装
  const confirmInstall = async () => {
    setInstalling(true);
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<CuaInstallProgress>(CUA_INSTALL_PROGRESS_EVENT, (event) => {
        if (event.payload?.line) {
          setInstallLog((prev) => [...prev.slice(-199), event.payload.line]);
        }
      });

      const probed = await invoke<CuaProbe>("cua_driver_install");
      setProbe(probed);
      toast.success("安装完成", { description: probed.version ? `cua-driver ${probed.version}` : undefined });
      await refresh({ force: true });
      if (!probed.permissionsRequired) {
        // 非 macOS 无需授权，自动启用
        void toggleEnabled(true);
        setSetupOpen(false);
      }
    } catch (err) {
      toast.error("安装失败", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      unlisten?.();
      setInstalling(false);
    }
  };

  // 触发系统授权
  const grantPermissions = async () => {
    setGranting(true);
    try {
      const res = await invoke<CuaPermissions>("cua_driver_permissions_grant");
      setPermissions(res);
      patchCuaProbeCachePermissions(res);
      if (res.accessibility && res.screenRecording) {
        toast.success(t("cuaStatusGranted"));
        void toggleEnabled(true);
        setSetupOpen(false);
      }
    } catch (err) {
      toast.error("授权失败", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setGranting(false);
    }
  };

  // 调整超时
  const applyTimeout = async (ms: number) => {
    if (!serverEntry) return;
    const idx = findCuaDriverServerIndex(servers);
    if (idx < 0) return;
    const nextServers = servers.map((s, i) => (i === idx ? { ...s, timeoutMs: ms } : s));
    try {
      await invoke("mcp_save_servers", { servers: nextServers });
      setServers(nextServers);
    } catch (err) {
      console.error("[cua] save timeout failed:", err);
    }
  };

  // 调整策略
  const applyPolicy = (next: ToolPolicy) => {
    setCuaPolicy(next);
    setPolicyState(next);
  };

  // 允许操作自身
  const applyAllowSelf = (next: boolean) => {
    setCuaAllowSelf(next);
    setAllowSelfTargetingState(next);
  };

  // 对齐命令
  const realignCommand = async () => {
    if (!serverEntry || !probe) return;
    const idx = findCuaDriverServerIndex(servers);
    if (idx < 0) return;
    const realigned = realignCuaServerConfig(serverEntry, probe);
    const nextServers = servers.map((s, i) => (i === idx ? realigned : s));
    try {
      await invoke("mcp_save_servers", { servers: nextServers });
      setServers(nextServers);
      toast.success(t("cuaCommandDriftRealign"));
    } catch (err) {
      console.error("[cua] realign failed:", err);
    }
  };

  const copyText = (val: string) => {
    void navigator.clipboard.writeText(val);
    toast.success("已复制到剪贴板");
  };

  return (
    <div className="space-y-6">
      {/* 顶部 Hero 卡片 */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-[var(--text)]">Computer Use</h2>
            <p className="text-xs text-[var(--text-dim)]">{t("cuaDesc")}</p>
          </div>
          <Switch
            checked={enabled}
            disabled={checking || installing || (!enabled && !permissionsReady)}
            onCheckedChange={(checked) => void toggleEnabled(checked)}
          />
        </div>
      </div>

      {/* 开始使用三步走卡片 */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-[var(--text)]">开始使用</h3>

        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-5 space-y-5">
          {/* 步骤条 */}
          <ol className="flex items-center gap-2">
            {steps.map((stepKey, index) => {
              const isDone = index < setupStep || (index === 0 && installed) || (index === 1 && permissionsReady) || (index === 2 && enabled);
              const isCurrent = index === setupStep;
              const isSelected = index === viewedStep;

              return (
                <li key={stepKey} className="flex flex-1 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedStep(index)}
                    className={`flex items-center gap-3 rounded-lg p-1.5 transition-colors cursor-pointer text-left ${
                      isSelected
                        ? "bg-[var(--sidebar-hover)] text-[var(--text)]"
                        : "text-[var(--text-dim)] hover:text-[var(--text)]"
                    }`}
                  >
                    <span
                      className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                        isDone
                          ? "bg-[var(--text)] text-[var(--bg)]"
                          : isCurrent
                            ? "border-2 border-[var(--text)] text-[var(--text)]"
                            : "border border-[var(--border)] text-[var(--text-dim)]"
                      }`}
                    >
                      {index + 1}
                    </span>
                    <span className="flex flex-col">
                      <span className="text-xs font-medium">{t(`cua.${stepKey}` as any) || t(stepKey as any)}</span>
                      <span className="text-[11px] text-[var(--text-dim)]">
                        {isDone ? t("cuaStepDone") : isCurrent ? t("cuaStepNext") : t("cuaStepPending")}
                      </span>
                    </span>
                  </button>

                  {index < steps.length - 1 && (
                    <div
                      className={`h-px flex-1 ${
                        isDone ? "bg-[var(--text)]/30" : "bg-[var(--border)]"
                      }`}
                    />
                  )}
                </li>
              );
            })}
          </ol>

          {/* 步骤操作承接面板 */}
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg bg-[var(--bg)] p-4 border border-[var(--border)]">
            <div className="space-y-1">
              <h4 className="text-xs font-semibold text-[var(--text)]">
                {checking
                  ? t("cuaChecking")
                  : viewedStep === 0 && installed
                    ? probe?.version
                      ? t("cuaDetectedWithVersion").replace("{version}", probe.version)
                      : t("cuaDetected")
                    : viewedStep === 2 && enabled
                      ? t("cuaReady")
                      : viewedStep === 0
                        ? t("cuaStepInstall")
                        : viewedStep === 1
                          ? t("cuaStepGrant")
                          : t("cuaStepEnable")}
              </h4>
              <p className="text-xs text-[var(--text-dim)]">
                {viewedStep === 0
                  ? t("cuaSetupInstallDesc")
                  : viewedStep === 1
                    ? t("cuaPermissionsGuide")
                    : t("cuaEnablePreview")}
              </p>
            </div>

            <div className="flex items-center gap-2">
              {viewedStep === 0 && !installed && (
                <Button size="sm" disabled={checking || installing} onClick={() => void beginInstall()}>
                  {installing ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                  {installing ? t("cuaInstalling") : t("cuaInstall")}
                </Button>
              )}
              {viewedStep === 1 && !permissionsReady && (
                <Button size="sm" disabled={!installed || checking} onClick={() => setSetupOpen(true)}>
                  {t("cuaGrantPermissions")}
                </Button>
              )}
              {viewedStep === 2 && !enabled && (
                <Button size="sm" disabled={!permissionsReady || checking} onClick={() => void toggleEnabled(true)}>
                  {t("cuaEnable")}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={checking || installing}
                onClick={() => void refresh({ force: true })}
              >
                {checking ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                {checking ? t("cuaChecking") : t("cuaRecheck")}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* 管理设置行卡片 */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-[var(--text)]">{t("cuaManageTitle")}</h3>
            <p className="text-xs text-[var(--text-dim)]">
              {commandDrift ? t("cuaCommandDriftTitle") : t("cuaManageDesc")}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => setManageOpen(true)}>
            {t("cuaManageAction")}
          </Button>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────
          管理设置弹窗（完全复刻图 2）
         ───────────────────────────────────────────────────────────── */}
      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent className="max-w-xl p-0 overflow-hidden bg-[var(--bg-elev)] border-[var(--border)]">
          <DialogHeader className="px-5 pt-5 pb-3 border-b border-[var(--border)] flex flex-row items-center justify-between">
            <DialogTitle className="text-base font-semibold text-[var(--text)]">{t("cuaManageTitle")}</DialogTitle>
          </DialogHeader>

          <DialogBody className="space-y-5 px-5 py-4 max-h-[calc(85vh-5rem)] overflow-y-auto">
            {/* 命令行展示（若已探测到） */}
            {displayCommand && (
              <div className="flex items-center gap-2 rounded-lg bg-[var(--bg)] px-3 py-2 border border-[var(--border)]">
                <code className="min-w-0 flex-1 truncate text-xs font-mono text-[var(--text-dim)]">
                  {displayCommand}
                </code>
                <button
                  type="button"
                  onClick={() => copyText(displayCommand)}
                  className="shrink-0 p-1 text-[var(--text-dim)] hover:text-[var(--text)] transition-colors cursor-pointer"
                  title="复制"
                >
                  <Copy className="size-3.5" />
                </button>
              </div>
            )}

            {/* 路径漂移警告 */}
            {commandDrift && (
              <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3 space-y-2">
                <div className="flex items-center gap-2 text-xs font-medium text-amber-500">
                  <AlertTriangle className="size-3.5" />
                  {t("cuaCommandDriftTitle")}
                </div>
                <p className="text-xs text-[var(--text-dim)] leading-relaxed">{t("cuaCommandDriftDesc")}</p>
                <Button size="sm" variant="outline" className="gap-1.5 text-xs h-7" onClick={() => void realignCommand()}>
                  <Replace className="size-3" />
                  {t("cuaCommandDriftRealign")}
                </Button>
              </div>
            )}

            {/* 分组 1：安全与审批 */}
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-[var(--text)] uppercase tracking-wider">
                {t("cuaGroupSecurity")}
              </h4>
              <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)] divide-y divide-[var(--border)]">
                {/* 工具审批策略 */}
                <div className="flex items-center justify-between gap-4 p-4">
                  <div className="space-y-0.5">
                    <div className="text-xs font-medium text-[var(--text)]">{t("cuaPolicyTitle")}</div>
                    <p className="text-xs text-[var(--text-dim)]">{t("cuaPolicyDesc")}</p>
                  </div>
                  <div className="flex items-center rounded-lg bg-[var(--bg-elev)] p-0.5 border border-[var(--border)] shrink-0">
                    {(["allow", "ask", "deny"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => applyPolicy(mode)}
                        className={`px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                          policy === mode
                            ? "bg-[var(--text)] text-[var(--bg)] shadow-xs"
                            : "text-[var(--text-dim)] hover:text-[var(--text)]"
                        }`}
                      >
                        {mode === "allow"
                          ? t("cuaPolicyAllow")
                          : mode === "ask"
                            ? t("cuaPolicyAsk")
                            : t("cuaPolicyDeny")}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 允许操作 ReinAgent 自身 */}
                <div className="flex items-center justify-between gap-4 p-4">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--text)]">
                      <ShieldOff className="size-3.5 text-[var(--text-dim)]" />
                      {t("cuaAllowSelfTitle")}
                    </div>
                    <p className="text-xs text-[var(--text-dim)]">{t("cuaAllowSelfDesc")}</p>
                  </div>
                  <Switch checked={allowSelfTargeting} onCheckedChange={applyAllowSelf} />
                </div>
              </div>
            </div>

            {/* 分组 2：运行时配置 */}
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-[var(--text)] uppercase tracking-wider">
                {t("cuaGroupRuntime")}
              </h4>
              <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-4 flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <div className="text-xs font-medium text-[var(--text)]">{t("cuaTimeoutLabel")}</div>
                  <p className="text-xs text-[var(--text-dim)]">{t("cuaTimeoutHint")}</p>
                </div>
                <div className="flex items-center rounded-lg bg-[var(--bg-elev)] p-0.5 border border-[var(--border)] shrink-0">
                  {TIMEOUT_PRESETS.map((preset) => (
                    <button
                      key={preset.value}
                      type="button"
                      onClick={() => void applyTimeout(preset.value)}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                        currentTimeout === preset.value
                          ? "bg-[var(--text)] text-[var(--bg)] shadow-xs"
                          : "text-[var(--text-dim)] hover:text-[var(--text)]"
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* 分组 3：能力概览 */}
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-[var(--text)] uppercase tracking-wider">
                {t("cuaGroupCapabilities")}
              </h4>
              <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {capabilities.map((cap) => (
                    <div
                      key={cap.key}
                      className="flex items-center gap-2 rounded-lg bg-[var(--bg-elev)] px-3 py-2 text-xs text-[var(--text)] border border-[var(--border)]/50"
                    >
                      <div className="size-1.5 shrink-0 rounded-full bg-sky-500" />
                      <span className="truncate">{cap.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* 底部说明与链接 */}
            <div className="rounded-xl bg-[var(--bg)] px-4 py-3 border border-[var(--border)] flex items-center justify-between gap-3 text-xs text-[var(--text-dim)]">
              <span className="truncate">{t("cuaPolicyNote")}</span>
              <a
                href={CUA_UPSTREAM_REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center gap-1 font-medium text-[var(--text)] hover:underline"
              >
                trycua/cua
                <ExternalLink className="size-3" />
              </a>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>

      {/* ─────────────────────────────────────────────────────────────
          安装驱动 / 系统授权弹窗
         ───────────────────────────────────────────────────────────── */}
      <Dialog open={setupOpen} onOpenChange={setSetupOpen}>
        <DialogContent className="max-w-xl p-5 bg-[var(--bg-elev)] border-[var(--border)]">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold text-[var(--text)]">
              {!installed ? t("cuaConfirmTitle") : t("cuaPermissionsTitle")}
            </DialogTitle>
            <DialogDescription className="text-xs text-[var(--text-dim)]">
              {!installed
                ? preview
                  ? t("cuaConfirmDesc").replace("{url}", preview.sourceUrl)
                  : t("cuaChecking")
                : t("cuaPermissionsDesc")}
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4 my-3">
            {!installed && preview && (
              <div className="relative rounded-lg bg-[var(--bg)] p-3 border border-[var(--border)] font-mono text-xs">
                <pre className="overflow-auto whitespace-pre-wrap break-all text-[var(--text)]">
                  {preview.display}
                </pre>
                <button
                  type="button"
                  onClick={() => copyText(preview.display)}
                  className="absolute right-2 top-2 p-1 text-[var(--text-dim)] hover:text-[var(--text)] transition-colors cursor-pointer"
                  title="复制命令"
                >
                  <Copy className="size-3.5" />
                </button>
              </div>
            )}

            {/* macOS 权限展示 */}
            {installed && permissionsRequired && (
              <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)] divide-y divide-[var(--border)]">
                <div className="flex items-center justify-between p-3.5 text-xs">
                  <div className="flex items-center gap-2 text-[var(--text)]">
                    <Accessibility className="size-4 text-[var(--text-dim)]" />
                    {t("cuaPermAccessibility")}
                  </div>
                  <span className={permissions?.accessibility ? "text-emerald-500 font-medium" : "text-amber-500"}>
                    {permissions?.accessibility ? t("cuaStatusGranted") : t("cuaPermNotGranted")}
                  </span>
                </div>
                <div className="flex items-center justify-between p-3.5 text-xs">
                  <div className="flex items-center gap-2 text-[var(--text)]">
                    <Video className="size-4 text-[var(--text-dim)]" />
                    {t("cuaPermScreenRecording")}
                  </div>
                  <span className={permissions?.screenRecording ? "text-emerald-500 font-medium" : "text-amber-500"}>
                    {permissions?.screenRecording ? t("cuaStatusGranted") : t("cuaPermNotGranted")}
                  </span>
                </div>
              </div>
            )}

            {/* 安装日志 */}
            {(installing || installLog.length > 0) && (
              <details open className="rounded-lg bg-[var(--bg)] p-3 border border-[var(--border)]">
                <summary className="text-xs font-medium cursor-pointer text-[var(--text-dim)]">
                  {t("cuaInstallLog")}
                </summary>
                <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] text-[var(--text-dim)]">
                  {installLog.join("\n") || t("cuaInstalling")}
                </pre>
              </details>
            )}
          </DialogBody>

          <DialogFooter className="flex justify-end gap-2 pt-2">
            {!installed ? (
              <>
                <Button size="sm" variant="outline" disabled={installing} onClick={() => setSetupOpen(false)}>
                  {t("cuaConfirmCancel")}
                </Button>
                <Button size="sm" disabled={!preview || installing} onClick={() => void confirmInstall()}>
                  {installing ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                  {installing ? t("cuaInstalling") : t("cuaConfirmRun")}
                </Button>
              </>
            ) : !permissionsReady ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={checking || granting}
                  onClick={() => void refresh({ force: true })}
                >
                  <RefreshCw className="mr-1.5 size-3.5" />
                  {t("cuaRecheck")}
                </Button>
                <Button size="sm" disabled={granting} onClick={() => void grantPermissions()}>
                  {granting ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                  {t("cuaGrantPermissions")}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                onClick={() => {
                  void toggleEnabled(true);
                  setSetupOpen(false);
                }}
              >
                {t("cuaEnable")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
