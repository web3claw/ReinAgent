// Glama API Key 配置弹窗（ReinAgent 增量，非 LA 移植件）。
// 背景：Glama /api/mcp/v1 自 2026-09 起强制 API Key（401 body 指引
// glama.ai/settings/api-keys 创建）——为商店 Glama 源提供 Key 配置入口。

import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { clearGlamaApiKey, getGlamaApiKey, setGlamaApiKey } from "../../lib/hub/registryKeys";
import { Button } from "../lw/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../lw/ui/dialog";
import { Input } from "../lw/ui/input";
import { useHubTranslation } from "./i18n";

export function GlamaApiKeyDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useHubTranslation();
  const [value, setValue] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    if (props.open) {
      setValue(getGlamaApiKey());
      setSavedFlash(false);
    }
  }, [props.open]);

  function save() {
    if (value.trim()) setGlamaApiKey(value);
    else clearGlamaApiKey();
    setSavedFlash(true);
    window.setTimeout(() => props.onOpenChange(false), 600);
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="hub-scope max-w-lg" showCloseButton>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <KeyRound className="size-4 text-muted-foreground" />
            {t("mcpHub.glamaApiKey")}
          </DialogTitle>
          <DialogDescription className="text-xs leading-5 text-muted-foreground">
            {t("mcpHub.glamaApiKeyDesc")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Input
            type="password"
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
            placeholder={t("mcpHub.glamaApiKeyPlaceholder")}
            className="font-mono text-xs"
            autoFocus
          />
        </DialogBody>
        <DialogFooter>
          <div className="flex w-full items-center justify-end gap-2">
            {savedFlash ? (
              <span className="mr-auto text-xs text-success">{t("mcpHub.keySaved")}</span>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                clearGlamaApiKey();
                setValue("");
                setSavedFlash(true);
              }}
            >
              {t("mcpHub.clearKey")}
            </Button>
            <Button size="sm" onClick={save}>
              {t("mcpHub.save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
