import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

let highlighterPromise: Promise<HighlighterCore> | null = null;

export async function getShikiHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      engine: createJavaScriptRegexEngine(),
      themes: [
        import("shiki/themes/github-dark.mjs"),
        import("shiki/themes/github-light.mjs"),
      ],
      langs: [
        import("shiki/langs/javascript.mjs"),
        import("shiki/langs/typescript.mjs"),
        import("shiki/langs/jsx.mjs"),
        import("shiki/langs/tsx.mjs"),
        import("shiki/langs/json.mjs"),
        import("shiki/langs/html.mjs"),
        import("shiki/langs/css.mjs"),
        import("shiki/langs/bash.mjs"),
        import("shiki/langs/shell.mjs"),
        import("shiki/langs/rust.mjs"),
        import("shiki/langs/python.mjs"),
        import("shiki/langs/markdown.mjs"),
        import("shiki/langs/diff.mjs"),
      ],
    });
  }
  return highlighterPromise;
}
