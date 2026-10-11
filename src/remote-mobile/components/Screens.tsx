/** 连接中加载页 + 失败页 —— ZCode main.tsx LoadingScreen / FailureScreen 移动端同款布局。 */
import { LoaderIcon } from "lucide-react";
import { useRemoteT } from "../i18n";
import { Button } from "./ui";
import type { WebRemoteControlFailure } from "../api/protocol";
import type { RemoteConnectionState } from "../api/client";

const STEPS = ["remote.loading.step1", "remote.loading.step2", "remote.loading.step3"] as const;

function loadingCopy(state: RemoteConnectionState): { title: string; description: string } {
  const t = useRemoteT();
  switch (state) {
    case "authenticating":
      return {
        title: t("remote.loading.authenticating"),
        description: t("remote.loading.authenticatingDesc"),
      };
    case "reconnecting":
      return {
        title: t("remote.loading.reconnecting"),
        description: t("remote.loading.reconnectingDesc"),
      };
    default:
      return {
        title: t("remote.loading.connecting"),
        description: t("remote.loading.connectingDesc"),
      };
  }
}

export function WebRemoteControlLoadingScreen({ state }: { state: RemoteConnectionState }) {
  const t = useRemoteT();
  const copy = loadingCopy(state);
  return (
    <div className="h-dvh min-h-dvh w-screen bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-lg items-center px-4">
        <section className="w-full rounded-xl border border-card-border bg-card p-5">
          <div className="flex items-center gap-3">
            <span className="size-2 animate-pulse rounded-full bg-warning" />
            <h1 className="text-ui-xs font-medium">{copy.title}</h1>
          </div>
          <p className="mt-2 text-ui-xs/relaxed text-foreground-subtle">{copy.description}</p>
          <div className="mt-4 grid gap-2">
            {STEPS.map((step, index) => (
              <div
                key={step}
                className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs text-foreground-subtle"
              >
                {`${index + 1}. ${t(step)}`}
              </div>
            ))}
          </div>
          {state === "reconnecting" ? (
            <div className="mt-4 flex items-center gap-2 text-ui-xs text-foreground-subtle">
              <LoaderIcon className="size-3.5 animate-spin" />
              {t("webRemoteControl.mobileShell.reconnecting")}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

export function WebRemoteControlFailureScreen({
  failure,
  onReload,
}: {
  failure: WebRemoteControlFailure;
  onReload: () => void;
}) {
  const t = useRemoteT();
  return (
    <div className="h-dvh min-h-dvh w-screen bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-lg items-center px-4">
        <section className="w-full rounded-xl border border-destructive/40 bg-card p-5">
          <h1 className="text-ui-lg font-medium">{t("remote.failure.title")}</h1>
          <p className="mt-2 text-ui-base/relaxed text-foreground-subtle">
            {t(`remote.failure.${failure.reason}`, undefined) || failure.message ||
              t("remote.failure.unexpected-error")}
          </p>
          {failure.message ? (
            <p className="mt-2 break-all rounded-lg border border-border bg-surface px-3 py-2 font-mono text-ui-xs text-foreground-subtlest">
              {failure.message}
            </p>
          ) : null}
          <Button variant="outline" className="mt-4 w-full" onClick={onReload}>
            {t("remote.failure.reload")}
          </Button>
        </section>
      </div>
    </div>
  );
}
