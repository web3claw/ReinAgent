import React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";
import { DiffViewer } from "../diff/DiffViewer";

export interface MarkdownBlockRendererProps {
  text: string;
}

export const MarkdownBlockRenderer: React.FC<MarkdownBlockRendererProps> = React.memo(
  ({ text }) => {
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
              return <CodeBlock code={codeString} language={lang} />;
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
  (prev, next) => prev.text === next.text
);
