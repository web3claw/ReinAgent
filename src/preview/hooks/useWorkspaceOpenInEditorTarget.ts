/**
 * useWorkspaceOpenInEditorTarget 宿主 stub —— 宿主不支持远端 workspace，
 * 恒定返回「本地、无远端目标」；open-in-editor 能力由 platform.openInEditor 承接。
 */
import { useMemo } from "react";

interface WorkspaceOpenInEditorScope {
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}

export function useWorkspaceOpenInEditorTarget(
  _scope?: WorkspaceOpenInEditorScope,
  _fileChanges?: unknown,
  _extra?: unknown,
) {
  return useMemo(
    () => ({
      remoteTarget: undefined,
      isRemoteWorkspace: false,
    }),
    []
  );
}
