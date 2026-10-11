/**
 * RemoteApp —— 手机远控根组件：连接状态分流（加载/失败/已连接 MobileShell）+
 * ZCode Switcher API 装配（remoteSwitcher）+ 主题状态机 + 对话页标题解析。
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  connectRemote,
  getRemoteSnapshot,
  subscribeRemote,
  remoteSwitcher,
  initAuthToken,
} from "./api/client";
import type { WebRemoteControlWorkspaceSwitcherApi } from "./api/protocol";
import { WebRemoteControlMobileShell } from "./components/MobileShell";
import {
  WebRemoteControlFailureScreen,
  WebRemoteControlLoadingScreen,
} from "./components/Screens";
import { ChatView } from "./components/ChatView";
import {
  applyRemoteTheme,
  persistRemoteTheme,
  readRemoteTheme,
  watchSystemTheme,
  type RemoteTheme,
} from "./components/ThemeMenu";
import {
  persistLocalePreference,
  readLocalePreference,
  resolveEffectiveLocale,
  RemoteIntlProvider,
  type LocalePreference,
} from "./i18n";

export function RemoteApp() {
  const snapshot = useSyncExternalStore(subscribeRemote, getRemoteSnapshot);
  const [theme, setTheme] = useState<RemoteTheme>(() => readRemoteTheme());
  const [localePref, setLocalePref] = useState<LocalePreference>(() => readLocalePreference());
  const locale = resolveEffectiveLocale(localePref);

  // 主题：system 跟随系统 + 变更即落盘生效
  useEffect(() => {
    applyRemoteTheme(theme);
    persistRemoteTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (theme !== "system") return;
    return watchSystemTheme(() => applyRemoteTheme("system"));
  }, [theme]);

  // 连接启动（一次性）
  useEffect(() => {
    initAuthToken();
    connectRemote();
  }, []);

  // 诊断句柄（挂一次；__diag 闭包读模块级变量恒新鲜）
  useEffect(() => {
    void import("./api/client").then((m) => {
      (window as unknown as Record<string, unknown>).__rcDiag = m.__diag;
    });
  }, []);

  const switcher: WebRemoteControlWorkspaceSwitcherApi = useMemo(() => remoteSwitcher, []);

  const activeTaskId = snapshot.desktopState.activeTaskId;
  const activeTask = useMemo(
    () =>
      (snapshot.workspaceList.tasks as NonNullable<typeof snapshot.workspaceList.tasks> | undefined)?.find(
        (task) => task.taskId === activeTaskId,
      ) ?? null,
    [snapshot.workspaceList.tasks, activeTaskId],
  );
  const activeWorkspace = useMemo(
    () =>
      (snapshot.workspaceList.workspaces as NonNullable<typeof snapshot.workspaceList.workspaces>).find(
        (workspace) =>
          (workspace.workspaceIdentity ?? workspace.workspacePath) === snapshot.desktopState.activeWorkspaceKey,
      ) ?? null,
    [snapshot.workspaceList.workspaces, snapshot.desktopState.activeWorkspaceKey],
  );

  const handleSelectTask = useCallback((targetWorkspacePath: string, taskId: string) => {
    void remoteSwitcher.switchWorkspace(targetWorkspacePath, { taskId });
  }, []);

  const handleStartDraftInWorkspace = useCallback((targetWorkspacePath: string) => {
    // 本工作区新建：切桌面草稿态（start_draft），聊天页以 taskId=null 渲染
    void remoteSwitcher.startDraft(targetWorkspacePath).catch(() => undefined);
  }, []);

  if (snapshot.connection === "failed" && snapshot.failure) {
    return (
      <RemoteIntlProvider locale={locale}>
        <WebRemoteControlFailureScreen
          failure={snapshot.failure}
          onReload={() => window.location.reload()}
        />
      </RemoteIntlProvider>
    );
  }

  if (snapshot.connection !== "paired" && snapshot.connection !== "reconnecting") {
    return (
      <RemoteIntlProvider locale={locale}>
        <WebRemoteControlLoadingScreen state={snapshot.connection} />
      </RemoteIntlProvider>
    );
  }

  return (
    <RemoteIntlProvider locale={locale}>
      <WebRemoteControlMobileShell
        switcher={switcher}
        activeWorkspacePath={activeWorkspace?.workspacePath ?? snapshot.desktopState.activeWorkspaceKey ?? ""}
        activeWorkspaceIdentity={activeWorkspace?.workspaceIdentity}
        activeTaskId={activeTaskId}
        initialWorkspaceList={
          (snapshot.workspaceList.workspaces?.length ?? 0) > 0 || (snapshot.workspaceList.tasks?.length ?? 0) > 0
            ? snapshot.workspaceList
            : undefined
        }
        onSelectTask={handleSelectTask}
        onStartDraftInWorkspace={handleStartDraftInWorkspace}
        connectionState={snapshot.connection}
        theme={theme}
        onThemeChange={setTheme}
        localePref={localePref}
        onLocaleChange={(pref) => {
          setLocalePref(pref);
          persistLocalePreference(pref);
        }}
        chatContent={
          <ChatView
            activeTaskId={activeTaskId}
            taskTitle={activeTask?.title ?? ""}
            isDraft={!activeTaskId}
            models={snapshot.models}
          />
        }
      />
    </RemoteIntlProvider>
  );
}
