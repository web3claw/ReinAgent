import React, { useCallback } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";
import { DiffViewer } from "../diff/DiffViewer";
import { useAppStore } from "../../store/useAppStore";
import { useTranslation } from "../../i18n";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Menu, MenuItem } from "@tauri-apps/api/menu";

export interface MarkdownBlockRendererProps {
  text: string;
  /** 流式中：代码块跳过 Shiki 高亮（对齐 ZCode，完成后自动恢复高亮） */
  streaming?: boolean;
}

function MarkdownLink({
  href,
  children,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href?: string }) {
  const { t } = useTranslation();
  const openCodeViewer = useAppStore((state) => state.openCodeViewer);

  const handleOpenBuiltin = useCallback(
    (targetUrl: string) => {
      openCodeViewer({ type: "browser", title: "浏览器", url: targetUrl });
    },
    [openCodeViewer],
  );

  const handleOpenSystem = useCallback(async (targetUrl: string) => {
    try {
      await openUrl(targetUrl);
    } catch {
      window.open(targetUrl, "_blank", "noopener,noreferrer");
    }
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (!href) return;
      // 外部链接（http / https）：在侧边栏内置浏览器中打开
      if (/^https?:\/\//i.test(href)) {
        e.preventDefault();
        e.stopPropagation();
        handleOpenBuiltin(href);
      }
    },
    [href, handleOpenBuiltin],
  );

  const handleContextMenu = useCallback(
    async (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (!href || !/^https?:\/\//i.test(href)) return;
      e.preventDefault();
      e.stopPropagation();

      try {
        const itemBuiltin = await MenuItem.new({
          text: t("openLinkInBuiltinBrowser"),
          action: () => handleOpenBuiltin(href),
        });
        const itemSystem = await MenuItem.new({
          text: t("openLinkInSystemBrowser"),
          action: () => void handleOpenSystem(href),
        });
        const itemCopy = await MenuItem.new({
          text: t("copyLinkAddress"),
          action: () => {
            void navigator.clipboard?.writeText(href);
          },
        });

        const menu = await Menu.new({
          items: [itemBuiltin, itemSystem, itemCopy],
        });
        await menu.popup();
      } catch {
        // Web 浏览器降级处理
        const confirmed = window.confirm(
          `${t("openLinkInSystemBrowser")}?\n${href}`,
        );
        if (confirmed) {
          window.open(href, "_blank", "noopener,noreferrer");
        }
      }
    },
    [href, t, handleOpenBuiltin, handleOpenSystem],
  );

  return (
    <a
      href={href}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  );
}

export const MarkdownBlockRenderer: React.FC<MarkdownBlockRendererProps> = React.memo(
  ({ text, streaming = false }) => {
    return (
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: MarkdownLink,
          code({ inline, className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || "");
            const lang = match ? match[1] : "";
            const codeString = String(children).replace(/\n$/, "");

            if (!inline && lang === "diff") {
              return <DiffViewer patch={codeString} filename="patch.diff" />;
            }

            if (!inline && lang) {
              return <CodeBlock code={codeString} language={lang} streaming={streaming} />;
            }

            return (
              <code className={`[overflow-wrap:anywhere] break-words ${className || ""}`} {...props}>
                {children}
              </code>
            );
          },
          table({ children, ...props }: any) {
            return (
              <div className="w-full my-2.5 overflow-x-auto rounded-lg border border-[var(--border)]">
                <table className="w-full text-left text-xs border-collapse" {...props}>
                  {children}
                </table>
              </div>
            );
          },
          th({ children, ...props }: any) {
            return (
              <th className="px-3 py-2 bg-[var(--surface-hover)] font-semibold border-b border-[var(--border)] text-[var(--text)] whitespace-nowrap" {...props}>
                {children}
              </th>
            );
          },
          td({ children, ...props }: any) {
            return (
              <td className="px-3 py-1.5 border-b border-[var(--border)] [overflow-wrap:anywhere] break-words text-[var(--text)]" {...props}>
                {children}
              </td>
            );
          },
        }}
      >
        {text}
      </Markdown>
    );
  },
  (prev, next) => prev.text === next.text && prev.streaming === next.streaming
);
