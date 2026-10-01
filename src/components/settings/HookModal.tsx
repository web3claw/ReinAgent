/**
 * HookModal —— Hook 新增/编辑弹窗。
 * LiveAgent 移植：crates/agent-ui/src/pages/settings/HookModal.tsx
 * 适配：i18n 键名（settings.hooks* → hooks*）；label 用轻量结构（本仓无 FormField）；
 * 兼容事件 PreToolUse 多一个 matcher 输入（ZCode 契约，LA 无此字段）。
 */

import { AlertTriangle, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "../../i18n";
import type { HookConfigEntry, HookType } from "../../lib/hooks/hooksRuntime";
import { cn } from "../lw/lib/utils";
import { SettingsNotice } from "../lw/settings/SettingsNotice";
import { Button } from "../lw/ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSectionHeader,
  DialogTitle,
} from "../lw/ui/dialog";
import { Input } from "../lw/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../lw/ui/select";
import { Textarea } from "../lw/ui/textarea";
import { FormField, FormFieldLabel } from "../mcp/FormField";
import {
  createEmptyRequestDraft,
  HttpRequestListEditor,
  parseHttpRequestDrafts,
  requestToDraft,
  type HttpRequestDraft,
} from "./hooksHttpRequestEditor";

const DEFAULT_HOOK_TIMEOUT_SECONDS = 60;

type HookModalProps = {
  event: string;
  initialData?: HookConfigEntry;
  onSave: (data: HookConfigEntry) => void | Promise<void>;
  onClose: () => void;
};

export function HookModal({ event, initialData, onSave, onClose }: HookModalProps) {
  const { t } = useTranslation();
  // 动态 i18n 键（hooksHttp* 校验文案传给解析器）需要 string 签名
  const tf = t as unknown as (key: string) => string;
  const [name, setName] = useState(initialData?.name ?? "");
  const [description, setDescription] = useState(initialData?.description ?? "");
  const [matcher, setMatcher] = useState(initialData?.matcher ?? "");
  const [type, setType] = useState<HookType>(initialData?.type ?? "command");
  const [scriptText, setScriptText] = useState(initialData?.command ?? "");
  const [timeoutSeconds, setTimeoutSeconds] = useState(
    initialData?.timeoutMs == null ? "" : String(Math.round(initialData.timeoutMs / 1000)),
  );
  const [requests, setRequests] = useState<HttpRequestDraft[]>(() => {
    if (initialData?.requests?.length) {
      return initialData.requests.map((request) => requestToDraft(request));
    }
    return [createEmptyRequestDraft()];
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [expandedRequest, setExpandedRequest] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const isEditing = Boolean(initialData);
  const isPreToolUse = event === "PreToolUse";

  async function handleSave() {
    try {
      setIsSaving(true);
      const trimmedName = name.trim();
      if (!trimmedName) {
        throw new Error(t("hooksNameRequired"));
      }
      const trimmedScript = scriptText.trim();
      if (type === "command" && !trimmedScript) {
        throw new Error(t("hooksCommandRequired"));
      }
      const trimmedTimeout = timeoutSeconds.trim();
      const parsedTimeoutSeconds = trimmedTimeout ? Number(trimmedTimeout) : undefined;
      if (
        parsedTimeoutSeconds !== undefined &&
        (!Number.isSafeInteger(parsedTimeoutSeconds) || parsedTimeoutSeconds <= 0)
      ) {
        throw new Error(t("hooksTimeoutInvalid"));
      }

      await onSave({
        id: initialData?.id ?? crypto.randomUUID(),
        event,
        name: trimmedName,
        description: description.trim(),
        enabled: initialData?.enabled ?? true,
        type,
        ...(isPreToolUse && matcher.trim() ? { matcher: matcher.trim() } : {}),
        command: type === "command" ? trimmedScript : undefined,
        requests: type === "http" ? parseHttpRequestDrafts(requests, tf) : undefined,
        timeoutMs:
          type === "command" && parsedTimeoutSeconds !== undefined
            ? parsedTimeoutSeconds * 1000
            : undefined,
      });
      onClose();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }

  const scriptLineCount = scriptText.split(/\r?\n/).filter((line) => line.trim()).length;

  return (
    <Dialog open onOpenChange={(open) => !open && !isSaving && onClose()}>
      <DialogContent
        className="flex h-[min(46rem,calc(100dvh-2rem))] max-w-xl flex-col"
        closeDisabled={isSaving}
        closeLabel={t("cancel")}
        showCloseButton
      >
        <DialogHeader>
          <DialogTitle>{isEditing ? t("hooksEdit") : t("hooksAdd")}</DialogTitle>
          <DialogDescription>{event}</DialogDescription>
        </DialogHeader>

        <DialogBody className="max-[820px]:p-0 p-0">
          <div className="px-6 pt-5 pb-1">
            <div className="space-y-4">
              <FormField density="compact">
                <FormFieldLabel htmlFor="hook-name" size="compact">
                  {t("hooksName")}
                </FormFieldLabel>
                <Input
                  variant="plain"
                  id="hook-name"
                  value={name}
                  placeholder={t("hooksNamePlaceholder")}
                  onChange={(e) => {
                    setFormError(null);
                    setName(e.currentTarget.value);
                  }}
                />
              </FormField>
              <FormField density="compact">
                <FormFieldLabel htmlFor="hook-description" size="compact">
                  {t("hooksDescription")}
                </FormFieldLabel>
                <Input
                  variant="plain"
                  id="hook-description"
                  value={description}
                  placeholder={t("hooksDescriptionPlaceholder")}
                  onChange={(e) => {
                    setFormError(null);
                    setDescription(e.currentTarget.value);
                  }}
                />
              </FormField>
              {isPreToolUse ? (
                <FormField density="compact">
                  <FormFieldLabel htmlFor="hook-matcher" size="compact">
                    {t("hooksMatcherPlaceholder")}
                  </FormFieldLabel>
                  <Input
                    variant="plain"
                    id="hook-matcher"
                    value={matcher}
                    placeholder="exec_command|fs_write"
                    onChange={(e) => {
                      setFormError(null);
                      setMatcher(e.currentTarget.value);
                    }}
                  />
                </FormField>
              ) : null}
            </div>
          </div>

          <FormField className="px-6 py-4">
            <FormFieldLabel htmlFor="hook-type" size="compact">
              {t("hooksType")}
            </FormFieldLabel>
            <Select
              value={type}
              onValueChange={(value) => {
                setType(value as HookType);
                setFormError(null);
              }}
            >
              <SelectTrigger
                id="hook-type"
                className={cn(
                  "flex h-9 w-full max-w-none justify-between px-3",
                  "rounded-lg bg-settings-tile-hover shadow-none",
                )}
              >
                <SelectValue>
                  {t(type === "command" ? "hooksTypeCommand" : "hooksTypeHttp")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="command">{t("hooksTypeCommand")}</SelectItem>
                <SelectItem value="http">{t("hooksTypeHttp")}</SelectItem>
              </SelectContent>
            </Select>
          </FormField>

          <div className="px-6 py-5">
            <DialogSectionHeader>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold">
                  {type === "command" ? t("hooksCommandList") : t("hooksHttpRequests")}
                </span>
              </div>
              {type === "command" ? (
                <div className="flex items-center gap-2">
                  <span className="rounded-md bg-settings-tile px-2 py-0.5 text-xs font-medium text-[var(--text-dim)]">
                    {scriptLineCount} {t("hooksScriptLinesCount")}
                  </span>
                  <span className="rounded-md bg-[var(--surface)]/60 px-2 py-0.5 text-xs font-medium text-[var(--text-dim)]">
                    {t("hooksSequential")}
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="rounded-md bg-settings-tile px-2 py-0.5 text-xs font-medium text-[var(--text-dim)]">
                    {requests.length} {t("hooksRequestsCount")}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1"
                    onClick={() => {
                      setFormError(null);
                      const draft = createEmptyRequestDraft();
                      setRequests((prev) => [...prev, draft]);
                      setExpandedRequest(draft.id);
                    }}
                  >
                    <Plus className="size-3" />
                    {t("hooksRequestAdd")}
                  </Button>
                </div>
              )}
            </DialogSectionHeader>

            {type === "command" ? (
              <div className="space-y-3">
                <div className="space-y-2">
                  <p className="text-xs leading-5 text-[var(--text-dim)]">
                    {t("hooksCommandHint")}
                  </p>
                  <Textarea
                    variant="plain"
                    aria-label={t("hooksCommandList")}
                    value={scriptText}
                    placeholder={"pnpm install\npnpm build\npnpm test"}
                    className={cn("min-h-44 resize-y rounded-lg font-mono text-xs leading-relaxed")}
                    onChange={(e) => {
                      setFormError(null);
                      setScriptText(e.currentTarget.value);
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="hook-timeout" className="text-xs font-medium text-[var(--text-dim)]">
                    {t("hooksTimeout")}
                  </label>
                  <Input
                    variant="plain"
                    id="hook-timeout"
                    value={timeoutSeconds}
                    inputMode="numeric"
                    placeholder={String(DEFAULT_HOOK_TIMEOUT_SECONDS)}
                    onChange={(e) => {
                      const next = e.currentTarget.value.trim();
                      if (next && !/^\d+$/.test(next)) return;
                      setFormError(null);
                      setTimeoutSeconds(next);
                    }}
                  />
                </div>
              </div>
            ) : (
              <HttpRequestListEditor
                plain
                alwaysExpanded
                requests={requests}
                expandedRequestId={expandedRequest}
                onExpand={setExpandedRequest}
                onChange={setRequests}
                onDirty={() => setFormError(null)}
                urlPlaceholder="https://example.com/hook"
              />
            )}
          </div>
        </DialogBody>

        <DialogFooter className="min-[821px]:justify-between">
          <div className="min-w-0 flex-1">
            {formError ? (
              <SettingsNotice variant="inline-error">
                <AlertTriangle className="size-3.5 shrink-0" />
                <span className="truncate">{formError}</span>
              </SettingsNotice>
            ) : null}
          </div>
          <DialogActions>
            <Button size="sm" variant="outline" onClick={onClose} disabled={isSaving}>
              {t("cancel")}
            </Button>
            <Button size="sm" onClick={() => void handleSave()} disabled={!name.trim() || isSaving}>
              {t("save")}
            </Button>
          </DialogActions>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
