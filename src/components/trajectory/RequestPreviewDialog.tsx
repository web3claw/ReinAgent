/**
 * RequestPreviewDialog —— 「下一次请求预览」弹窗（本仓增量，2026-10-06 用户定稿）。
 *
 * 居中大弹窗 + 左侧分类导航（请求参数/系统提示词/工具/用户上下文/消息安排/原始 JSON），
 * 内容由 `buildRequestPreview` 构建（与真实发送同源，见该模块头注）。底部附构建注记与
 * 「复制全文」。数据由 App 异步构建后经 props 注入（loading/error 三态如实渲染）。
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import type { RequestPreview } from "../../lib/chat/requestPreview";
import { Dialog, DialogContent, DialogTitle } from "../lw/ui/dialog";

type PreviewSectionId = "params" | "system" | "tools" | "context" | "messages" | "raw";

export interface RequestPreviewDialogProps {
  open: boolean;
  onClose: () => void;
  loading: boolean;
  error: string | null;
  data: RequestPreview | null;
}

export function RequestPreviewDialog({ open, onClose, loading, error, data }: RequestPreviewDialogProps) {
  const { t } = useTranslation();
  const [section, setSection] = useState<PreviewSectionId>("params");
  const [copied, setCopied] = useState(false);

  // 新数据到达回到首节
  useEffect(() => {
    if (data) setSection("params");
  }, [data]);

  const sections: { id: PreviewSectionId; label: string }[] = useMemo(
    () => [
      { id: "params", label: t("trajectory.preview.navParams") },
      { id: "system", label: t("trajectory.preview.navSystem") },
      { id: "tools", label: t("trajectory.preview.navTools") },
      { id: "context", label: t("trajectory.preview.navContext") },
      { id: "messages", label: t("trajectory.preview.navMessages") },
      { id: "raw", label: t("trajectory.preview.navRaw") },
    ],
    [t],
  );

  const copyFull = async () => {
    if (!data) return;
    // 复制全文 = 纯 JSON 数据（用户定稿 2026-10-06：标题/围栏/注记一律不带）。
    try {
      await navigator.clipboard.writeText(data.rawJson);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn("[trajectory] copy failed:", err);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        showCloseButton
        closeLabel={t("settings.close")}
        className="flex h-[min(78vh,760px)] w-[min(1100px,94vw)] max-w-none flex-col overflow-hidden p-0"
      >
        <DialogTitle className="border-b border-border/60 px-4 py-3 text-sm font-medium">
          {t("trajectory.preview.title")}
        </DialogTitle>

        {loading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {t("trajectory.preview.loading")}
          </div>
        ) : error !== null ? (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-destructive">
            {error}
          </div>
        ) : data === null ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {t("trajectory.preview.empty")}
          </div>
        ) : (
          <>
            <div className="flex min-h-0 flex-1">
              <nav className="w-44 shrink-0 space-y-0.5 overflow-y-auto border-r border-border/60 p-2">
                {sections.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSection(item.id)}
                    className={cn(
                      "block w-full rounded px-2.5 py-1.5 text-left text-xs transition-colors",
                      section === item.id
                        ? "bg-muted font-medium text-foreground"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </nav>
              <div className="min-w-0 flex-1 overflow-y-auto p-4 text-xs">
                <SectionContent section={section} data={data} />
              </div>
            </div>
            <footer className="flex items-center gap-3 border-t border-border/60 px-4 py-2">
              <div
                className="min-w-0 flex-1 truncate text-tiny text-muted-foreground"
                title={data.notes.join("\n")}
              >
                {data.notes.join(" · ")}
              </div>
              <button
                type="button"
                onClick={() => void copyFull()}
                className="shrink-0 rounded-lg border border-border px-3 py-1 text-xs font-medium transition-colors hover:border-primary"
              >
                {copied ? t("trajectory.preview.copied") : t("trajectory.preview.copy")}
              </button>
            </footer>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Mono(props: { value: string }) {
  return (
    <pre className="whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-xs leading-relaxed">
      {props.value}
    </pre>
  );
}

function LabelledBlock(props: { label: string; value: string }) {
  const { t } = useTranslation();
  return (
    <section className="space-y-1">
      <p className="text-tiny font-medium uppercase tracking-wide text-muted-foreground">
        {props.label}
      </p>
      {props.value.trim().length > 0 ? (
        <Mono value={props.value} />
      ) : (
        <p className="text-muted-foreground">{t("trajectory.preview.empty")}</p>
      )}
    </section>
  );
}

function SectionContent({ section, data }: { section: PreviewSectionId; data: RequestPreview }) {
  const { t } = useTranslation();
  if (section === "params") {
    const rows: [string, string][] = [
      ["provider", data.params.provider],
      ["model", data.params.model],
      ["api", data.params.api],
      ["thinkingLevel", data.params.thinkingLevel ?? "default"],
      ["maxOutputTokens", String(data.params.maxOutputTokens)],
      ["approvalMode", data.params.approvalMode],
      ["workspaceRoot", data.params.workspaceRoot ?? ""],
      ["demo", String(data.params.demo)],
    ];
    return (
      <div>
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-2 border-b border-border/40 py-1 last:border-0">
            <span className="w-40 shrink-0 text-muted-foreground">{label}</span>
            <span className="min-w-0 flex-1 break-words">{value}</span>
          </div>
        ))}
      </div>
    );
  }
  if (section === "system") {
    return <Mono value={data.systemPrompt} />;
  }
  if (section === "tools") {
    return (
      <div className="space-y-4">
        <p className="text-muted-foreground">
          {t("trajectory.preview.navTools")} · {data.tools.length}
        </p>
        {data.tools.map((tool) => (
          <section key={tool.name} className="space-y-1">
            <p className="font-medium text-foreground">{tool.name}</p>
            {tool.description ? (
              <p className="whitespace-pre-wrap text-muted-foreground">{tool.description}</p>
            ) : null}
            <Mono value={tool.schemaJson} />
          </section>
        ))}
      </div>
    );
  }
  if (section === "context") {
    return (
      <div className="space-y-4">
        {data.messageMergedNote !== null && (
          <p className="rounded bg-muted/40 p-2 text-muted-foreground">{data.messageMergedNote}</p>
        )}
        <LabelledBlock label="currentDate" value={data.context.currentDate} />
        <LabelledBlock label="agents.md" value={data.context.agentsMd} />
        <LabelledBlock label="Memory Index" value={data.context.memory} />
        <LabelledBlock label="Skills" value={data.context.skills} />
        <LabelledBlock label="Hook:SessionStart" value={data.context.sessionStart} />
      </div>
    );
  }
  if (section === "messages") {
    return (
      <div className="space-y-3">
        {data.messageMergedNote !== null && (
          <p className="rounded bg-muted/40 p-2 text-muted-foreground">{data.messageMergedNote}</p>
        )}
        {data.messages.map((entry, index) => (
          <section key={index} className="space-y-1">
            <p className="flex items-center gap-2">
              <span className="rounded bg-muted px-1.5 py-px text-tiny font-medium uppercase">
                {entry.role}
              </span>
              {entry.notes.length > 0 && (
                <span className="text-tiny text-muted-foreground">{entry.notes.join(" · ")}</span>
              )}
              {entry.clipped && (
                <span className="text-tiny text-warning-foreground">
                  {t("trajectory.preview.clipped")}
                </span>
              )}
            </p>
            <Mono value={entry.body} />
          </section>
        ))}
      </div>
    );
  }
  return <Mono value={data.rawJson} />;
}
