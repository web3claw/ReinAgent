/**
 * hooksHttpRequestEditor —— HTTP hook 请求列表编辑器。
 * LiveAgent 移植：crates/agent-ui/src/pages/settings/httpRequestEditor.tsx
 * 适配：i18n 走本仓 useTranslation（settings.cronHttp* → hooksHttp*）；
 * uuid 用 crypto.randomUUID；Headers/Body JSON 校验文案按本仓键名。
 */

import { ChevronDown, Globe, Trash2 } from "lucide-react";
import { useTranslation } from "../../i18n";
import {
  canHttpMethodHaveBody,
  HTTP_METHODS,
  type HttpMethod,
  type HookHttpRequestSpec,
} from "../../lib/hooks/hooksRuntime";
import { cn } from "../lw/lib/utils";
import { Input } from "../lw/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../lw/ui/select";
import { Textarea } from "../lw/ui/textarea";

export type HttpRequestDraft = {
  id: string;
  url: string;
  method: HttpMethod;
  headersText: string;
  bodyText: string;
};

export function createEmptyRequestDraft(): HttpRequestDraft {
  return {
    id: crypto.randomUUID(),
    url: "",
    method: "POST",
    headersText: "",
    bodyText: "",
  };
}

function stringifyHeaders(headers?: Record<string, string>) {
  if (!headers || Object.keys(headers).length === 0) return "";
  return JSON.stringify(headers, null, 2);
}

function stringifyBody(body?: unknown) {
  if (body === undefined) return "";
  return JSON.stringify(body, null, 2);
}

export function requestToDraft(request?: HookHttpRequestSpec): HttpRequestDraft {
  if (!request) return createEmptyRequestDraft();
  return {
    id: request.id,
    url: request.url,
    method: request.method,
    headersText: stringifyHeaders(request.headers),
    bodyText: stringifyBody(request.body),
  };
}

function parseHeaders(input: string, invalidMessage: string) {
  if (!input.trim()) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error(invalidMessage);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(invalidMessage);
  }

  const headers: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
    const key = String(rawKey).trim();
    const value = typeof rawValue === "string" ? rawValue.trim() : String(rawValue ?? "").trim();
    if (!key || !value) continue;
    headers[key] = value;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

function parseBody(method: HttpMethod, input: string, invalidMessage: string) {
  if (!canHttpMethodHaveBody(method)) return undefined;
  if (!input.trim()) return undefined;
  try {
    return JSON.parse(input);
  } catch {
    throw new Error(invalidMessage);
  }
}

export function parseHttpRequestDrafts(
  requests: HttpRequestDraft[],
  t: (key: string) => string,
): HookHttpRequestSpec[] {
  if (requests.length === 0) {
    throw new Error(t("hooksHttpRequestRequired"));
  }

  return requests.map((request, index) => {
    const url = request.url.trim();
    if (!url) {
      throw new Error(`${t("hooksHttpUrlRequired")} #${index + 1}`);
    }
    try {
      new URL(url);
    } catch {
      throw new Error(`${t("hooksHttpUrlInvalid")} #${index + 1}`);
    }

    return {
      id: request.id,
      url,
      method: request.method,
      headers: parseHeaders(request.headersText, t("hooksHttpHeadersInvalid")),
      body: parseBody(request.method, request.bodyText, t("hooksHttpBodyInvalid")),
    } satisfies HookHttpRequestSpec;
  });
}

type HttpRequestListEditorProps = {
  plain?: boolean;
  alwaysExpanded?: boolean;
  requests: HttpRequestDraft[];
  expandedRequestId: string | null;
  onExpand: (id: string | null) => void;
  onChange: (requests: HttpRequestDraft[]) => void;
  /** Called before any edit so the host modal can clear its form error. */
  onDirty: () => void;
  urlPlaceholder: string;
};

export function HttpRequestListEditor({
  plain = false,
  alwaysExpanded = false,
  requests,
  expandedRequestId,
  onExpand,
  onChange,
  onDirty,
  urlPlaceholder,
}: HttpRequestListEditorProps) {
  const { t } = useTranslation();

  function updateRequest(id: string, patch: Partial<HttpRequestDraft>) {
    onChange(requests.map((request) => (request.id === id ? { ...request, ...patch } : request)));
  }

  return (
    <div className="space-y-3">
      {requests.map((request, index) => {
        const bodyEnabled = canHttpMethodHaveBody(request.method);
        const isExpanded = alwaysExpanded || expandedRequestId === request.id;

        return (
          <div
            key={request.id}
            className={
              plain
                ? "rounded-xl bg-settings-tile"
                : "overflow-hidden rounded-xl border border-[var(--border)]/60 bg-[var(--bg)]/80 transition-colors hover:border-[var(--border)]/80"
            }
          >
            <div
              className={cn(
                "flex flex-wrap items-center gap-3 px-4 py-3",
                plain && "[&_input]:order-last [&_input]:basis-full",
              )}
            >
              <div
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center",
                  plain
                    ? "text-xs font-medium text-[var(--text-dim)]"
                    : "rounded-lg bg-emerald-500/10 text-xs font-bold text-emerald-600 dark:text-emerald-400",
                )}
              >
                {index + 1}
              </div>

              <Select
                value={request.method}
                onValueChange={(value) => {
                  onDirty();
                  updateRequest(request.id, {
                    method: value as HttpMethod,
                    bodyText: canHttpMethodHaveBody(value as HttpMethod) ? request.bodyText : "",
                  });
                }}
              >
                <SelectTrigger className="h-8 w-[100px] text-xs font-semibold">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HTTP_METHODS.map((method) => (
                    <SelectItem key={method} value={method}>
                      {method}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Input
                variant={plain ? "plain" : "default"}
                value={request.url}
                placeholder={urlPlaceholder}
                className="h-8 min-w-0 flex-1 font-mono text-xs"
                onChange={(e) => {
                  onDirty();
                  updateRequest(request.id, { url: e.currentTarget.value });
                }}
              />

              <div className="flex items-center gap-1">
                {!alwaysExpanded ? (
                  <button
                    type="button"
                    onClick={() => onExpand(isExpanded ? null : request.id)}
                    className={cn(
                      "flex size-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-hover)]",
                      isExpanded ? "text-[var(--brand)]" : "text-[var(--text-dim)]",
                    )}
                  >
                    <ChevronDown
                      className={cn(
                        "size-3.5 transition-transform",
                        isExpanded ? "" : "-rotate-90",
                      )}
                    />
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    onDirty();
                    onChange(requests.filter((item) => item.id !== request.id));
                    if (expandedRequestId === request.id) {
                      onExpand(null);
                    }
                  }}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-md text-[var(--text-dim)] transition-colors",
                    "hover:bg-red-500/10 hover:text-red-500",
                  )}
                  title={t("hooksDelete")}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </div>

            {isExpanded ? (
              <div className="space-y-4 border-t border-[var(--border)]/30 bg-[var(--surface)]/40 p-4 sm:grid sm:grid-cols-2 sm:gap-4 sm:space-y-0">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-[var(--text-dim)]">Headers</label>
                  <Textarea
                    variant={plain ? "plain" : "default"}
                    value={request.headersText}
                    placeholder={'{\n  "Authorization": "Bearer ..."\n}'}
                    className="min-h-[100px] resize-y font-mono text-xs leading-relaxed"
                    onChange={(e) => {
                      onDirty();
                      updateRequest(request.id, { headersText: e.currentTarget.value });
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-[var(--text-dim)]">Body</label>
                  {bodyEnabled ? (
                    <Textarea
                      variant={plain ? "plain" : "default"}
                      value={request.bodyText}
                      placeholder={'{\n  "message": "hello"\n}'}
                      className="min-h-[100px] resize-y font-mono text-xs leading-relaxed"
                      onChange={(e) => {
                        onDirty();
                        updateRequest(request.id, { bodyText: e.currentTarget.value });
                      }}
                    />
                  ) : (
                    <div
                      className={cn(
                        "flex min-h-[100px] items-center justify-center",
                        "rounded-lg border border-dashed border-[var(--border)]/50 bg-[var(--surface)]/40 text-xs text-[var(--text-dim)]/60",
                      )}
                    >
                      {t("hooksHttpBodyDisabled")}
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}

      {requests.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border)]/50 bg-[var(--surface)]/30 py-8 text-center">
          <Globe className="mx-auto size-6 text-[var(--text-dim)]/30" />
          <p className="mt-2 text-xs text-[var(--text-dim)]">{t("hooksHttpRequestRequired")}</p>
        </div>
      ) : null}
    </div>
  );
}
