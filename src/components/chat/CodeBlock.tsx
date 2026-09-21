import React, { useEffect, useState } from "react";
import { useAppStore } from "../../store/useAppStore";
import { getShikiHighlighter } from "../../lib/highlight/shikiHighlighter";
import { Copy, Check } from "lucide-react";
import { useTranslation } from "../../i18n";

export interface CodeBlockProps {
  code: string;
  language?: string;
}

export const CodeBlock: React.FC<CodeBlockProps> = ({ code, language = "text" }) => {
  const theme = useAppStore((s) => s.theme);
  const { t } = useTranslation();
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    getShikiHighlighter()
      .then((highlighter) => {
        if (!active) return;
        try {
          const loadedLangs = highlighter.getLoadedLanguages();
          const targetLang = loadedLangs.includes(language.toLowerCase())
            ? language.toLowerCase()
            : "text";

          const rendered = highlighter.codeToHtml(code, {
            lang: targetLang,
            theme: theme === "dark" ? "github-dark" : "github-light",
          });
          setHtml(rendered);
        } catch {
          // Fallback to plain code
          setHtml(null);
        }
      })
      .catch(() => {
        if (active) setHtml(null);
      });

    return () => {
      active = false;
    };
  }, [code, language, theme]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard failure
    }
  };

  return (
    <div className="relative group rounded-lg overflow-hidden my-3 border border-[var(--border)] bg-[var(--bg-secondary)]">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--bg-card)] border-b border-[var(--border)] text-xs text-[var(--text-secondary)] font-mono">
        <span className="font-medium text-[var(--text-primary)]">{language}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          title={copied ? t("copied") : t("copy")}
        >
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
          <span>{copied ? t("copied") : t("copy")}</span>
        </button>
      </div>

      {html ? (
        <div
          className="p-3 overflow-x-auto text-xs font-mono leading-relaxed"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="p-3 overflow-x-auto text-xs font-mono leading-relaxed text-[var(--text-primary)]">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
};
