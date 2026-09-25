import React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";
import { DiffViewer } from "../diff/DiffViewer";

export interface MarkdownBlockRendererProps {
  text: string;
  /** 流式中：代码块跳过 Shiki 高亮（对齐 ZCode，完成后自动恢复高亮） */
  streaming?: boolean;
}

export const MarkdownBlockRenderer: React.FC<MarkdownBlockRendererProps> = React.memo(
  ({ text, streaming = false }) => {
    return (
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
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
              <code className={className} {...props}>
                {children}
              </code>
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
