/**
 * MobileMarkdown —— 手机端 Markdown 渲染（react-markdown + remark-gfm + Shiki 异步高亮）。
 * 对齐桌面渲染语义：流式中的代码块跳过高亮（防每帧重高亮），完成后自动补一次高亮。
 */
import { memo, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { getShikiHighlighter } from "../../lib/highlight/shikiHighlighter";

const HIGHLIGHT_MAX_BYTES = 64 * 1024;

function PreWithCopy({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLPreElement>(null);

  const handleCopy = () => {
    const code = containerRef.current?.querySelector("code")?.textContent ?? "";
    void navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };

  return (
    <div className="group relative">
      <button
        type="button"
        aria-label="copy"
        onClick={handleCopy}
        className="absolute top-2 right-2 z-10 flex size-7 items-center justify-center rounded-md border border-white/10 bg-white/10 text-neutral-300 opacity-0 transition-opacity group-hover:opacity-100 group-active:opacity-100"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      <pre ref={containerRef}>{children}</pre>
    </div>
  );
}

/** Shiki 异步高亮：<code> 文本替换为高亮 HTML；流式中（streaming=true）跳过。 */
function HighlightedCode({ code, lang, streaming }: { code: string; lang?: string; streaming?: boolean }) {
  const [html, setHtml] = useState<string | null>(null);
  const highlightAllowed = !streaming && code.length <= HIGHLIGHT_MAX_BYTES;

  useEffect(() => {
    if (!highlightAllowed) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const highlighter = await getShikiHighlighter();
        const loaded = highlighter.getLoadedLanguages();
        const language = lang && loaded.includes(lang) ? lang : "text";
        const result =
          language === "text"
            ? null
            : highlighter.codeToHtml(code, {
                lang: language,
                themes: { dark: "github-dark", light: "github-light" },
              });
        if (!cancelled) setHtml(result);
      } catch {
        if (!cancelled) setHtml(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, lang, highlightAllowed]);

  if (!html) return <code>{code}</code>;
  // eslint-disable-next-line react/no-danger -- Shiki 产物（本地静态词法高亮，无用户脚本注入面）
  return <code dangerouslySetInnerHTML={{ __html: html }} />;
}

export const MobileMarkdown = memo(function MobileMarkdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <PreWithCopy>{children}</PreWithCopy>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          code: ({ className, children }) => {
            const raw = String(children ?? "");
            const match = /language-(\w+)/.exec(className ?? "");
            // 行内 code（无换行）走 .md code 默认样式
            if (!raw.includes("\n")) {
              return <code className={className}>{children}</code>;
            }
            return <HighlightedCode code={raw.replace(/\n$/, "")} lang={match?.[1]} streaming={streaming} />;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
