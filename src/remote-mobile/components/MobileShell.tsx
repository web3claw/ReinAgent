/**
 * MobileShell —— ZCode WebRemoteControlMobileShell.tsx 直移适配：
 * home/chat 双页 + history 回退 + 重连提示 + 切换遮罩。sidePane（子代理抽屉）一期裁剪。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, LoaderIcon } from "lucide-react";
import { Button } from "./ui";
import {
  WebRemoteControlMobileTaskHome,
  persistWebRemoteControlMobileTaskHomePreferences,
  readWebRemoteControlMobileTaskHomePreferences,
  type WebRemoteControlMobileTaskHomePreferences,
} from "./TaskHome";
import { RemoteThemeMenu, type RemoteTheme } from "./ThemeMenu";
import type { LocalePreference } from "../i18n";
import { useRemoteT } from "../i18n";
import { cn } from "../lib/cn";
import type { RemoteConnectionState } from "../api/client";
import type { WebRemoteControlWorkspaceListResult, WebRemoteControlWorkspaceSwitcherApi } from "../api/protocol";

type WebRemoteControlMobilePage = "home" | "chat";

interface WebRemoteControlMobileHistoryState {
  reinagentMobilePage?: WebRemoteControlMobilePage;
}

export function isWebRemoteControlMobileChatHistoryState(state: unknown): state is WebRemoteControlMobileHistoryState {
  return (
    typeof state === "object" &&
    state !== null &&
    (state as WebRemoteControlMobileHistoryState).reinagentMobilePage === "chat"
  );
}

function pushWebRemoteControlMobileChatHistory() {
  if (typeof window === "undefined") return;
  if (isWebRemoteControlMobileChatHistoryState(window.history.state)) return;
  window.history.pushState({ reinagentMobilePage: "chat" }, "");
}

function resolveInitialWebRemoteControlMobilePage(initialNavigationIntent?: "chat"): WebRemoteControlMobilePage {
  if (initialNavigationIntent === "chat") return "chat";
  // 手机端在聊天页刷新时 React 内存状态丢失，但浏览器保留 history.state——复用之
  if (
    typeof window !== "undefined" &&
    isWebRemoteControlMobileChatHistoryState(window.history.state)
  ) {
    return "chat";
  }
  return "home";
}

export function WebRemoteControlMobileShell({
  activeTaskId,
  activeWorkspaceIdentity,
  activeWorkspacePath,
  chatContent,
  initialNavigationIntent,
  initialWorkspaceList,
  onSelectTask,
  onStartDraftInWorkspace,
  chatHeader,
  connectionState,
  switcher,
  theme,
  onThemeChange,
  localePref,
  onLocaleChange,
}: {
  switcher: WebRemoteControlWorkspaceSwitcherApi;
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  initialNavigationIntent?: "chat";
  initialWorkspaceList?: WebRemoteControlWorkspaceListResult;
  onSelectTask: (targetWorkspacePath: string, taskId: string, targetWorkspaceIdentity?: string) => void;
  onStartDraftInWorkspace?: (targetWorkspacePath: string) => void;
  chatContent: ReactNode;
  /** 聊天页任务头卡（标题/排队/侧栏开关位）——由 ChatView 提供渲染闭包 */
  chatHeader?: ReactNode;
  connectionState: RemoteConnectionState;
  theme: RemoteTheme;
  onThemeChange: (theme: RemoteTheme) => void;
  localePref: LocalePreference;
  onLocaleChange: (pref: LocalePreference) => void;
}) {
  const t = useRemoteT();
  const [currentPage, setCurrentPage] = useState<WebRemoteControlMobilePage>(() =>
    resolveInitialWebRemoteControlMobilePage(initialNavigationIntent),
  );
  const [taskHomePreferences, setTaskHomePreferences] =
    useState<WebRemoteControlMobileTaskHomePreferences>(() => readWebRemoteControlMobileTaskHomePreferences());
  const [homeRefreshKey, setHomeRefreshKey] = useState(0);
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);

  const navigateToChat = useCallback(() => {
    setCurrentPage("chat");
    pushWebRemoteControlMobileChatHistory();
  }, []);

  const handleTaskHomePreferencesChange = useCallback(
    (preferences: WebRemoteControlMobileTaskHomePreferences) => {
      // 进入 task 后组件卸载，排序/分组偏好写 localStorage 让刷新后恢复（ZCode 同语义）
      persistWebRemoteControlMobileTaskHomePreferences(preferences);
      setTaskHomePreferences(preferences);
    },
    [],
  );

  const navigateHome = useCallback(() => {
    setHomeRefreshKey((key) => key + 1);
    if (typeof window !== "undefined" && isWebRemoteControlMobileChatHistoryState(window.history.state)) {
      window.history.back();
      return;
    }
    setCurrentPage("home");
  }, []);

  useEffect(() => {
    if (initialNavigationIntent !== "chat") return;
    navigateToChat();
  }, [initialNavigationIntent, navigateToChat]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handlePopState = (event: PopStateEvent) => {
      const nextPage = isWebRemoteControlMobileChatHistoryState(event.state) ? "chat" : "home";
      setCurrentPage(nextPage);
      if (nextPage === "home") {
        setHomeRefreshKey((key) => key + 1);
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  // 手机端“新建任务/切任务”后 activeTaskId 变化即上报 view state（跨端选中态收敛一致）
  useEffect(() => {
    const workspaceKey = activeWorkspaceIdentity ?? activeWorkspacePath;
    void switcher
      .updateMobileViewState?.(workspaceKey, activeTaskId ?? undefined)
      .catch(() => undefined);
  }, [activeTaskId, activeWorkspaceIdentity, activeWorkspacePath, switcher]);

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col bg-background">
      {currentPage === "home" ? (
        <WebRemoteControlMobileTaskHome
          activeTaskId={activeTaskId}
          activeWorkspaceIdentity={activeWorkspaceIdentity}
          activeWorkspacePath={activeWorkspacePath}
          initialResult={initialWorkspaceList}
          onNavigateHome={navigateHome}
          onNavigateToChat={navigateToChat}
          preferences={taskHomePreferences}
          onPreferencesChange={handleTaskHomePreferencesChange}
          refreshKey={homeRefreshKey}
          onSelectTask={onSelectTask}
          onStartDraftInWorkspace={onStartDraftInWorkspace}
          onCrossWorkspaceSwitchingChange={setSwitchingWorkspace}
          switcher={switcher}
          theme={theme}
          onThemeChange={onThemeChange}
          localePref={localePref}
          onLocaleChange={onLocaleChange}
        />
      ) : (
        <section
          className="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground"
          data-mobile-page="chat"
        >
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-header px-2">
            <Button variant="ghost" size="icon-sm" aria-label={t("webRemoteControl.mobileShell.backHome")} onClick={navigateHome}>
              <ArrowLeft className="size-4" />
            </Button>
            <span className="min-w-0 flex-1 truncate text-ui-base font-medium">
              {t("webRemoteControl.mobileShell.chatTitle")}
            </span>
            <RemoteThemeMenu theme={theme} onThemeChange={onThemeChange} localePref={localePref} onLocaleChange={onLocaleChange} />
          </div>
          {chatHeader}
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{chatContent}</div>
        </section>
      )}

      {switchingWorkspace ? (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-background/72 backdrop-blur-[1px]"
          aria-live="polite"
          aria-busy="true"
        >
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle shadow-sm">
            <LoaderIcon className="size-4 animate-spin" />
            {t("common.loading")}
          </div>
        </div>
      ) : null}
      {connectionState === "reconnecting" ? (
        <div
          className="pointer-events-none absolute top-3 left-1/2 z-50 flex -translate-x-1/2 justify-center px-3"
          aria-live="polite"
          aria-busy="true"
          data-web-remote-control-reconnect-notice="true"
        >
          <div
            className={cn(
              "flex max-w-[calc(100vw-1.5rem)] items-center gap-2 rounded-lg border border-border bg-toast px-3 py-2 text-ui-base text-foreground shadow-lg",
            )}
          >
            <LoaderIcon className="size-4 shrink-0 animate-spin text-foreground-subtle" />
            <span className="min-w-0 whitespace-nowrap">{t("webRemoteControl.mobileShell.reconnecting")}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
