import { useMemo, useState, useRef } from "react";
import { AlertCircle, Check, Copy, FileCode, Info } from "lucide-react";

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../lw/ui/dialog";
import { Button } from "../lw/ui/button";
import { useHubTranslation } from "./i18n";
import type { McpServerConfig } from "../../lib/hub/mcpTypes";
import {
  parseMcpJsonImport,
  toMcpServerConfigs,
} from "../../lib/mcp/mcpJsonImport";
import { cn } from "../lw/lib/utils";

const SAMPLE_JSON_PLACEHOLDER = `{
  "mcpServers": {
    "weather": {
      "command": "uv",
      "args": ["--directory", "/path/to/weather", "run", "weather.py"],
      "description": "Weather information server"
    }
  }
}`;

export function McpJsonImportModal(props: {
  open: boolean;
  onClose: () => void;
  existingServers: McpServerConfig[];
  onImport: (servers: McpServerConfig[]) => void;
}) {
  const { open, onClose, existingServers, onImport } = props;
  const { t } = useHubTranslation();

  const [jsonInput, setJsonInput] = useState("");
  const [copied, setCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  // 实时校验
  const validation = useMemo(() => {
    const trimmed = jsonInput.trim();
    if (!trimmed) {
      return { isValid: false, errorMessage: null, servers: [] };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return {
        isValid: false,
        errorMessage: t("mcpHub.importJsonFormatError", "JSON 格式错误"),
        servers: [],
      };
    }

    const result = parseMcpJsonImport(parsed);
    if (!result.isValid) {
      const fallbackMsg =
        result.errorKey === "mcpHub.importJsonBareServerError"
          ? '请将 MCP 服务配置放在顶层 "mcpServers" 对象中，或在数组项中添加 "name"。'
          : result.errorKey === "mcpHub.importJsonStdioCommandRequiredError"
            ? 'Stdio MCP 服务必须提供非空 "command"。'
            : result.errorKey === "mcpHub.importJsonUrlRequiredError"
              ? 'HTTP 和 SSE MCP 服务必须提供非空 "url"。'
              : "JSON 格式错误";
      return {
        isValid: false,
        errorMessage: t(result.errorKey, fallbackMsg),
        servers: [],
      };
    }

    return {
      isValid: true,
      errorMessage: null,
      servers: result.servers,
    };
  }, [jsonInput, t]);

  const lineCount = useMemo(() => {
    if (!jsonInput) return 1;
    return jsonInput.split("\n").length;
  }, [jsonInput]);

  const handleCopy = async () => {
    if (!jsonInput) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(jsonInput);
      } else {
        const ta = document.createElement("textarea");
        ta.value = jsonInput;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 忽略复制异常
    }
  };

  const handleScroll = () => {
    if (textareaRef.current && gutterRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  const handleSubmit = () => {
    if (!validation.isValid || validation.servers.length === 0 || submitting) return;

    setSubmitting(true);
    try {
      const newConfigs = toMcpServerConfigs(validation.servers, existingServers);
      onImport(newConfigs);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  const hasContent = Boolean(jsonInput.trim());
  const isInvalid = hasContent && !validation.isValid;

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent
        className="hub-scope flex max-h-[calc(100dvh-3rem)] w-full max-w-xl flex-col p-0"
        closeLabel={t("settings.cancel", "取消")}
        layout="fullscreen-mobile"
        showCloseButton
      >
        <DialogHeader className="flex-row items-center gap-3 border-b border-border/40 pb-4">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <FileCode className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-base font-semibold">
              {t("mcpHub.importJsonTitle", "从 JSON 导入")}
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs text-muted-foreground leading-relaxed">
              {t(
                "mcpHub.importJsonPlaceholder",
                "请将服务文档中的 MCP JSON 配置粘贴到下方输入框。如果配置里使用了 npx、uvx 等命令，请先确认它们已安装并且当前机器可用。",
              )}
            </DialogDescription>
          </div>
        </DialogHeader>

        <DialogBody className="space-y-4 py-4">
          {isInvalid && validation.errorMessage && (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="size-4 shrink-0" />
              <span>{validation.errorMessage}</span>
            </div>
          )}

          <div
            className={cn(
              "relative flex h-64 overflow-hidden rounded-lg border transition-colors",
              isInvalid
                ? "border-destructive focus-within:border-destructive"
                : "border-border/80 focus-within:border-primary/60 bg-muted/20",
            )}
          >
            {/* 行号列 */}
            <div
              ref={gutterRef}
              className="flex w-10 shrink-0 select-none flex-col items-end overflow-hidden border-r border-border/40 bg-muted/30 py-3 pr-2.5 font-mono text-[11px] leading-5 text-muted-foreground/60"
              aria-hidden="true"
            >
              {Array.from({ length: Math.max(lineCount, 8) }, (_, i) => (
                <div key={i + 1} className="h-5">
                  {i + 1}
                </div>
              ))}
            </div>

            {/* 编辑输入区 */}
            <textarea
              ref={textareaRef}
              value={jsonInput}
              onChange={(e) => setJsonInput(e.target.value)}
              onScroll={handleScroll}
              placeholder={SAMPLE_JSON_PLACEHOLDER}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              className={cn(
                "size-full resize-none bg-transparent p-3 font-mono text-xs leading-5 text-foreground outline-none",
                "placeholder:text-muted-foreground/40",
              )}
            />

            {/* 复制按钮 */}
            {hasContent && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopy}
                className="absolute right-2 top-2 h-7 gap-1 rounded-md px-2 text-xs backdrop-blur-xs bg-background/80"
                title="复制"
              >
                {copied ? (
                  <>
                    <Check className="size-3 text-success" />
                    <span>已复制</span>
                  </>
                ) : (
                  <>
                    <Copy className="size-3" />
                    <span>复制</span>
                  </>
                )}
              </Button>
            )}
          </div>

          {/* 导入提示卡片（100% 对齐 AionUi 样式） */}
          <div className="rounded-lg border border-border/60 bg-muted/30 p-3.5 text-xs text-muted-foreground">
            <div className="flex items-start gap-2.5">
              <Info className="size-4 shrink-0 text-primary mt-0.5" />
              <div className="space-y-1.5 flex-1">
                <div className="font-medium text-foreground">
                  {t("mcpHub.importJsonTipsTitle", "导入提示")}
                </div>
                <ul className="list-disc pl-4 space-y-1 text-muted-foreground">
                  <li>
                    {t(
                      "mcpHub.importJsonTip1",
                      '请使用包含顶层 "mcpServers" 字段的有效 JSON 对象。',
                    )}
                  </li>
                  <li>
                    {t(
                      "mcpHub.importJsonTip2",
                      '每个服务需定义 "command"（stdio）或 "url"（http/sse）之一。',
                    )}
                  </li>
                  <li>
                    {t("mcpHub.importJsonTip3", "支持一次导入多个服务。")}
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </DialogBody>

        <DialogFooter className="flex items-center justify-end gap-2 border-t border-border/40 pt-3">
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>
            {t("settings.cancel", "取消")}
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={handleSubmit}
            disabled={!validation.isValid || !hasContent || submitting}
          >
            {t("settings.confirm", "确定")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
