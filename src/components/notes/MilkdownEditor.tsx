import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { Milkdown, MilkdownProvider, useEditor, useInstance } from "@milkdown/react";
import {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewCtx,
  parserCtx,
  serializerCtx,
} from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { nord } from "@milkdown/theme-nord";
import { $prose } from "@milkdown/kit/utils";
import { codeBlockComponent, codeBlockConfig } from "@milkdown/kit/component/code-block";
import { languages } from "@codemirror/language-data";
import { syntaxHighlighting, defaultHighlightStyle, indentUnit } from "@codemirror/language";
import { EditorView as CMEditorView } from "@codemirror/view";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Slice as ProseSlice } from "@milkdown/kit/prose/model";
import type { MilkdownPlugin } from "@milkdown/ctx";
import { callCommand } from "@milkdown/utils";
import {
  toggleStrongCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  createCodeBlockCommand,
  insertHrCommand,
} from "@milkdown/preset-commonmark";
import { toggleStrikethroughCommand, insertTableCommand } from "@milkdown/preset-gfm";
import { mermaidConfigCtx, diagram } from "@milkdown/plugin-diagram";
import { mermaidConfig, isDarkTheme, fitMermaidLabels } from "./mermaidTheme";
import "@milkdown/theme-nord/style.css";
import "./milkdown.css";

export function mermaidTemplate(): string {
  return `graph TD\n    A[开始] --> B{处理}\n    B -->|成功| C[完成]\n    B -->|失败| D[重试]`;
}

export interface SelectionInfo {
  text: string;
  from: number;
  to: number;
  coords: { top: number; left: number } | null;
  hasSelection: boolean;
}

export interface MilkdownEditorHandle {
  getMarkdown: () => string;
  setMarkdown: (md: string) => void;
  replaceSelection: (text: string) => void;
  appendContent: (text: string) => void;
  getSelectionInfo: () => SelectionInfo;
  focus: () => void;
  selectRange: (from: number, to: number) => void;
  insertMarkdown: (md: string) => void;
  insertText: (text: string) => void;
  insertDiagram: () => void;
  toggleBold: () => void;
  toggleItalic: () => void;
  toggleStrikethrough: () => void;
  toggleInlineCode: () => void;
  toggleHeading: (level: number) => void;
  toggleParagraph: () => void;
  toggleBlockquote: () => void;
  toggleBulletList: () => void;
  toggleOrderedList: () => void;
  toggleTodo: () => void;
  insertCodeBlock: () => void;
  insertDivider: () => void;
  insertTable: () => void;
  insertLink: (href: string) => void;
}

export interface MilkdownEditorProps {
  initialMarkdown: string;
  onChange: (md: string) => void;
  onSelectionChange?: (info: SelectionInfo) => void;
  placeholder?: string;
}

interface TrackedSelection {
  text: string;
  from: number;
  to: number;
  hasSelection: boolean;
}

const selectionPluginKey = new PluginKey<TrackedSelection | null>("reinagent-selection-tracker");

/**
 * 流程图（mermaid）节点视图：
 * - 预览态渲染 SVG，失败时回退展示源码与错误提示
 * - 点击进入编辑态（多行文本框），失焦后保存并重新渲染
 */
class DiagramNodeView {
  dom: HTMLElement;
  private node: ProseNode;
  private view: EditorView;
  private getPos: () => number;
  private editing = false;
  private renderToken = 0;

  constructor(node: ProseNode, view: EditorView, getPos: () => number) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.dom = document.createElement("div");
    this.dom.className = "hetu-diagram";
    this.dom.addEventListener("click", this.handleClick);
    this.renderPreview();
  }

  private handleClick = () => {
    if (this.editing) return;
    this.editing = true;
    this.renderEditor();
  };

  private renderEditor() {
    this.renderToken += 1;
    this.dom.innerHTML = "";
    this.dom.classList.add("hetu-diagram-editing");
    const textarea = document.createElement("textarea");
    textarea.value = this.node.attrs.value || mermaidTemplate();
    textarea.className = "hetu-diagram-source";
    textarea.rows = Math.min(20, textarea.value.split("\n").length + 2);
    textarea.addEventListener("blur", () => this.commit(textarea.value));
    textarea.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") textarea.blur();
    });
    this.dom.appendChild(textarea);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.select();
    });
  }

  private commit(value: string) {
    this.editing = false;
    if (value !== (this.node.attrs.value || "")) {
      const pos = this.getPos();
      if (typeof pos === "number") {
        const tr = this.view.state.tr.setNodeMarkup(pos, undefined, {
          ...this.node.attrs,
          value,
        });
        this.view.dispatch(tr);
        return;
      }
    }
    this.renderPreview();
  }

  private async renderPreview() {
    const token = ++this.renderToken;
    this.dom.classList.remove("hetu-diagram-editing");
    const code = (this.node.attrs.value || "").trim();
    this.dom.innerHTML = "";
    if (!code) {
      this.dom.appendChild(this.buildHint("点击编辑流程图"));
      return;
    }
    const loading = this.buildHint("正在渲染流程图...");
    this.dom.appendChild(loading);
    try {
      const mermaid = (await import("mermaid")).default;
      mermaid.initialize(mermaidConfig(isDarkTheme()));
      const { svg } = await mermaid.render(
        `reinagent-diagram-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        code
      );
      if (token !== this.renderToken) return;
      this.dom.innerHTML = "";
      const holder = document.createElement("div");
      holder.className = "hetu-diagram-svg";
      holder.innerHTML = svg;
      this.dom.appendChild(holder);
      fitMermaidLabels(holder);
      this.dom.appendChild(this.buildHint("点击编辑流程图"));
    } catch (err) {
      if (token !== this.renderToken) return;
      this.dom.innerHTML = "";
      const box = document.createElement("div");
      box.className = "hetu-diagram-error";
      const msg = document.createElement("div");
      msg.className = "hetu-diagram-error-msg";
      msg.textContent = `流程图语法错误: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
      const src = document.createElement("pre");
      src.textContent = code;
      box.append(msg, src);
      this.dom.appendChild(box);
      this.dom.appendChild(this.buildHint("点击修改代码"));
    }
  }

  private buildHint(text: string): HTMLElement {
    const hint = document.createElement("div");
    hint.className = "hetu-diagram-hint";
    hint.textContent = text;
    return hint;
  }

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    if (!this.editing) this.renderPreview();
    return true;
  }

  stopEvent(): boolean {
    return true;
  }

  destroy() {
    this.dom.removeEventListener("click", this.handleClick);
    this.renderToken += 1;
  }
}

/** 注册流程图节点视图：替换默认文本视图为可渲染/可编辑的交互式节点 */
function diagramNodeViewPlugin(): MilkdownPlugin {
  return $prose(() => {
    return new Plugin({
      key: new PluginKey("reinagent-diagram-view"),
      props: {
        nodeViews: {
          diagram: (node, view, getPos) =>
            new DiagramNodeView(node as ProseNode, view as EditorView, getPos as () => number),
        },
      },
    });
  });
}

/**
 * 监听 ProseMirror 选区变化的插件，计算选区相对编辑容器的坐标，供浮动工具条定位
 */
function selectionTrackerPlugin(onChange?: (info: SelectionInfo) => void) {
  return $prose(() => {
    return new Plugin({
      key: selectionPluginKey,
      state: {
        init: () => null as TrackedSelection | null,
        apply: (tr, value, _oldState, newState): TrackedSelection | null => {
          if (!tr.selectionSet && !tr.docChanged) return value;
          const { selection, doc } = newState;
          if (selection.empty) return null;
          const text = doc.textBetween(selection.from, selection.to, "\n");
          return {
            text,
            from: selection.from,
            to: selection.to,
            hasSelection: true,
          };
        },
      },
      view: () => ({
        update: (view: EditorView) => {
          if (!onChange) return;
          const state = selectionPluginKey.getState(view.state);
          if (!state || !state.hasSelection) {
            onChange({ text: "", from: 0, to: 0, coords: null, hasSelection: false });
            return;
          }
          const containerRect = view.dom.getBoundingClientRect();
          const end = Math.max(state.from, state.to);
          const start = Math.min(state.from, state.to);
          const endCoords = view.coordsAtPos(end);
          const startCoords = view.coordsAtPos(start);
          const popupWidth = 320;
          const left = Math.min(
            Math.max(endCoords.left - containerRect.left, 0),
            containerRect.width - popupWidth - 16
          );
          const selectionBottom = Math.max(endCoords.bottom, startCoords.bottom);
          onChange({
            text: state.text,
            from: state.from,
            to: state.to,
            coords: {
              top: selectionBottom - containerRect.top + 8,
              left,
            },
            hasSelection: true,
          });
        },
      }),
    }) as Plugin;
  });
}

/**
 * 监听文档变化并序列化为 markdown 字符串的插件
 */
function markdownUpdatePlugin(onChange: (md: string) => void): MilkdownPlugin {
  return $prose((ctx) => {
    let lastDoc: EditorState["doc"] | null = null;
    return new Plugin({
      key: new PluginKey("reinagent-markdown-update"),
      view: () => ({
        update: (view: EditorView) => {
          if (lastDoc && view.state.doc.eq(lastDoc)) return;
          lastDoc = view.state.doc;
          const serializer = ctx.get(serializerCtx);
          const md = serializer(view.state.doc);
          onChange(md);
        },
      }),
    }) as Plugin;
  });
}

/**
 * 代码块后自动补段落插件，方便在代码块下方继续编写普通文本
 */
function autoParagraphAfterCodeBlockPlugin(): MilkdownPlugin {
  return $prose(() => {
    return new Plugin({
      key: new PluginKey("reinagent-auto-paragraph-after-code"),
      appendTransaction: (trs, _oldState, newState) => {
        if (!trs.some((tr) => tr.docChanged)) return null;
        const { doc, schema } = newState;
        const lastChild = doc.lastChild;
        if (!lastChild) return null;
        if (lastChild.type.name !== "code_block") return null;
        const tr = newState.tr;
        const paragraph = schema.nodes.paragraph.create();
        tr.insert(doc.content.size, paragraph);
        return tr;
      },
    }) as Plugin;
  });
}

const MilkdownEditorInner = forwardRef<MilkdownEditorHandle, MilkdownEditorProps>(
  function MilkdownEditorInner(props, ref) {
    const { initialMarkdown, onChange, onSelectionChange, placeholder } = props;
    const onChangeRef = useRef(onChange);
    const onSelectionChangeRef = useRef(onSelectionChange);
    const initialMarkdownRef = useRef(initialMarkdown);
    const lastEmittedRef = useRef<string>(initialMarkdown);

    useEffect(() => {
      onChangeRef.current = onChange;
      onSelectionChangeRef.current = onSelectionChange;
    }, [onChange, onSelectionChange]);

    const onMdChange = (md: string) => {
      if (md === lastEmittedRef.current) return;
      lastEmittedRef.current = md;
      onChangeRef.current?.(md);
    };
    const onSelChange = (info: SelectionInfo) => onSelectionChangeRef.current?.(info);
    const mdPlugin = markdownUpdatePlugin(onMdChange);
    const selPlugin = selectionTrackerPlugin(onSelChange);
    const autoParagraphPlugin = autoParagraphAfterCodeBlockPlugin();

    const editorInfo = useEditor((root) =>
      Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, root);
          ctx.set(defaultValueCtx, initialMarkdownRef.current);
          ctx.update(mermaidConfigCtx.key, (config: any) => ({
            ...(config || {}),
            startOnLoad: false,
            securityLevel: "loose",
          }));
        })
        .config(nord)
        .config((ctx) =>
          ctx.update(codeBlockConfig.key, (config) => ({
            ...config,
            languages,
            // 语法高亮 + 2空格缩进 + 行自动折行
            extensions: [
              syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
              indentUnit.of("  "),
              CMEditorView.lineWrapping,
            ],
            // 用 SVG 图标替换默认 emoji
            copyIcon:
              '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
            copyText: "",
            expandIcon:
              '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
            searchIcon:
              '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
            clearSearchIcon:
              '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
          }))
        )
        .use(commonmark)
        .use(gfm)
        .use(history)
        .use(diagram)
        .use(diagramNodeViewPlugin())
        .use(mdPlugin)
        .use(selPlugin)
        .use(autoParagraphPlugin)
        .use(codeBlockComponent)
    );

    const [, getInstance] = useInstance();
    const getEditor = editorInfo.get;

    const getMarkdown = useCallback((): string => {
      const editor = getEditor() ?? getInstance();
      if (!editor) return "";
      const ctx = editor.ctx;
      const serializer = ctx.get(serializerCtx);
      const view = ctx.get(editorViewCtx);
      return serializer(view.state.doc);
    }, [getEditor, getInstance]);

    const setMarkdown = useCallback(
      (md: string) => {
        const editor = getEditor() ?? getInstance();
        if (!editor) return;
        const ctx = editor.ctx;
        const view = ctx.get(editorViewCtx);
        const parser = ctx.get(parserCtx);
        const doc = parser(md);
        if (!doc) return;
        view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content));
        lastEmittedRef.current = md;
      },
      [getEditor, getInstance]
    );

    const replaceSelection = useCallback(
      (text: string) => {
        const editor = getEditor() ?? getInstance();
        if (!editor) return;
        const ctx = editor.ctx;
        const view = ctx.get(editorViewCtx);
        const doc = ctx.get(parserCtx)(text);
        if (!doc) return;
        const slice = new ProseSlice(doc.content, 0, 0);
        const tr = view.state.tr;
        // 精确选区替换（ROADMAP ④ 修复）：非空选区也走 tr.replaceSelection——
        // 旧实现 replaceRange 到父块边界会把「替换一句」放大成「替换整段」，
        // 划词 AI 结果会覆盖选区之外的原文（事故源）。
        tr.replaceSelection(slice);
        view.dispatch(tr);
        view.focus();
        const md = getMarkdown();
        lastEmittedRef.current = md;
        onChangeRef.current?.(md);
      },
      [getEditor, getInstance, getMarkdown]
    );

    const appendContent = useCallback(
      (text: string) => {
        const editor = getEditor() ?? getInstance();
        if (!editor) return;
        const ctx = editor.ctx;
        const view = ctx.get(editorViewCtx);
        const parser = ctx.get(parserCtx);
        const currentMd = getMarkdown();
        const sep = currentMd.endsWith("\n\n")
          ? ""
          : currentMd.endsWith("\n")
          ? "\n"
          : currentMd
          ? "\n\n"
          : "";
        const fullMd = currentMd + sep + text;
        const doc = parser(fullMd);
        if (!doc) return;
        const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
        view.dispatch(tr);
        lastEmittedRef.current = fullMd;
        onChangeRef.current?.(fullMd);
      },
      [getEditor, getInstance, getMarkdown]
    );

    const getSelectionInfo = useCallback((): SelectionInfo => {
      const editor = getEditor() ?? getInstance();
      if (!editor) return { text: "", from: 0, to: 0, coords: null, hasSelection: false };
      const ctx = editor.ctx;
      const view = ctx.get(editorViewCtx);
      const { selection, doc } = view.state;
      if (selection.empty) {
        return { text: "", from: 0, to: 0, coords: null, hasSelection: false };
      }
      const text = doc.textBetween(selection.from, selection.to, "\n");
      const containerRect = view.dom.getBoundingClientRect();
      const end = Math.max(selection.from, selection.to);
      const coords = view.coordsAtPos(end);
      return {
        text,
        from: selection.from,
        to: selection.to,
        coords: {
          top: coords.top - containerRect.top + 24,
          left: Math.max(coords.left - containerRect.left, 0),
        },
        hasSelection: true,
      };
    }, [getEditor, getInstance]);

    const focus = useCallback(() => {
      const editor = getEditor() ?? getInstance();
      if (!editor) return;
      const view = editor.ctx.get(editorViewCtx);
      view.focus();
    }, [getEditor, getInstance]);

    const selectRange = useCallback(
      (from: number, to: number) => {
        const editor = getEditor() ?? getInstance();
        if (!editor) return;
        const view = editor.ctx.get(editorViewCtx);
        const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to));
        view.dispatch(tr);
        view.focus();
      },
      [getEditor, getInstance]
    );

    const runCommand = useCallback(
      (command: any, payload?: unknown) => {
        const editor = getEditor() ?? getInstance();
        if (!editor) return;
        if (typeof command?.run === "function") {
          command.run(payload);
          return;
        }
        const key = command?.key ?? command;
        editor.action(callCommand(key, payload));
      },
      [getEditor, getInstance]
    );

    const insertMarkdown = useCallback(
      (md: string) => {
        const editor = getEditor() ?? getInstance();
        if (!editor) return;
        const ctx = editor.ctx;
        const view = ctx.get(editorViewCtx);
        const doc = ctx.get(parserCtx)(md);
        if (!doc) return;
        const tr = view.state.tr.replaceSelection(new ProseSlice(doc.content, 0, 0));
        view.dispatch(tr);
        view.focus();
        const serialized = ctx.get(serializerCtx)(view.state.doc);
        lastEmittedRef.current = serialized;
        onChangeRef.current?.(serialized);
      },
      [getEditor, getInstance]
    );

    const insertText = useCallback(
      (text: string) => {
        const editor = getEditor() ?? getInstance();
        if (!editor) return;
        const view = editor.ctx.get(editorViewCtx);
        view.dispatch(view.state.tr.insertText(text));
        view.focus();
        const ctx = editor.ctx;
        const serialized = ctx.get(serializerCtx)(view.state.doc);
        lastEmittedRef.current = serialized;
        onChangeRef.current?.(serialized);
      },
      [getEditor, getInstance]
    );

    const insertDiagram = useCallback(() => {
      insertMarkdown(`\`\`\`mermaid\n${mermaidTemplate()}\n\`\`\``);
    }, [insertMarkdown]);

    const toggleBold = useCallback(() => runCommand(toggleStrongCommand), [runCommand]);
    const toggleItalic = useCallback(() => runCommand(toggleEmphasisCommand), [runCommand]);
    const toggleStrikethrough = useCallback(() => runCommand(toggleStrikethroughCommand), [runCommand]);
    const toggleInlineCode = useCallback(() => runCommand(toggleInlineCodeCommand), [runCommand]);
    const toggleHeading = useCallback(
      (level: number) => {
        const editor = getEditor() ?? getInstance();
        if (!editor) return;
        const view = editor.ctx.get(editorViewCtx);
        const { state, dispatch } = view;
        const { schema } = state;
        const headingType = schema.nodes.heading;
        const paragraphType = schema.nodes.paragraph;
        if (!headingType || !paragraphType) return;
        const { from, to } = state.selection;
        let isSameHeading = false;
        state.doc.nodesBetween(from, to, (node) => {
          if (node.type === headingType && node.attrs.level === level) {
            isSameHeading = true;
          }
        });
        const targetType = isSameHeading ? paragraphType : headingType;
        const targetAttrs = isSameHeading ? null : { level };
        const tr = state.tr.setBlockType(from, to, targetType, targetAttrs);
        dispatch(tr);
        view.focus();
        const serialized = editor.ctx.get(serializerCtx)(view.state.doc);
        lastEmittedRef.current = serialized;
        onChangeRef.current?.(serialized);
      },
      [getEditor, getInstance]
    );
    const toggleParagraph = useCallback(() => {
      const editor = getEditor() ?? getInstance();
      if (!editor) return;
      const view = editor.ctx.get(editorViewCtx);
      const { state, dispatch } = view;
      const { from, to } = state.selection;
      const tr = state.tr.setBlockType(from, to, state.schema.nodes.paragraph);
      dispatch(tr);
      view.focus();
      const serialized = editor.ctx.get(serializerCtx)(view.state.doc);
      lastEmittedRef.current = serialized;
      onChangeRef.current?.(serialized);
    }, [getEditor, getInstance]);
    const toggleBlockquote = useCallback(() => runCommand(wrapInBlockquoteCommand), [runCommand]);
    const toggleBulletList = useCallback(() => runCommand(wrapInBulletListCommand), [runCommand]);
    const toggleOrderedList = useCallback(() => runCommand(wrapInOrderedListCommand), [runCommand]);
    const toggleTodo = useCallback(() => {
      runCommand(wrapInBulletListCommand);
      insertText("[ ] ");
    }, [runCommand, insertText]);
    const insertCodeBlock = useCallback(() => runCommand(createCodeBlockCommand), [runCommand]);
    const insertDivider = useCallback(() => runCommand(insertHrCommand), [runCommand]);
    const insertTable = useCallback(
      () => runCommand(insertTableCommand, { row: 3, col: 3 }),
      [runCommand]
    );
    const insertLink = useCallback(
      (href: string) => runCommand(toggleLinkCommand, { href }),
      [runCommand]
    );

    useImperativeHandle(
      ref,
      () => ({
        getMarkdown,
        setMarkdown,
        replaceSelection,
        appendContent,
        getSelectionInfo,
        focus,
        selectRange,
        insertMarkdown,
        insertText,
        insertDiagram,
        toggleBold,
        toggleItalic,
        toggleStrikethrough,
        toggleInlineCode,
        toggleHeading,
        toggleParagraph,
        toggleBlockquote,
        toggleBulletList,
        toggleOrderedList,
        toggleTodo,
        insertCodeBlock,
        insertDivider,
        insertTable,
        insertLink,
      }),
      [
        getMarkdown,
        setMarkdown,
        replaceSelection,
        appendContent,
        getSelectionInfo,
        focus,
        selectRange,
        insertMarkdown,
        insertText,
        insertDiagram,
        toggleBold,
        toggleItalic,
        toggleStrikethrough,
        toggleInlineCode,
        toggleHeading,
        toggleParagraph,
        toggleBlockquote,
        toggleBulletList,
        toggleOrderedList,
        toggleTodo,
        insertCodeBlock,
        insertDivider,
        insertTable,
        insertLink,
      ]
    );

    return (
      <div className="hetu-milkdown-root h-full w-full" data-placeholder={placeholder ?? ""}>
        <Milkdown />
      </div>
    );
  }
);

export const MilkdownEditor = forwardRef<MilkdownEditorHandle, MilkdownEditorProps>(
  function MilkdownEditor(props, ref) {
    return (
      <MilkdownProvider>
        <MilkdownEditorInner {...props} ref={ref} />
      </MilkdownProvider>
    );
  }
);
