import type { ComponentType, ReactElement } from "react";

export const INITIAL_RENDER_CHAR_BUDGET: number;

export function splitBlocks(text: string): string[];

export function hasDocumentScopedConstructs(text: string): boolean;

export interface WindowBlocksOptions {
  budget?: number;
}

export interface WindowBlocksResult {
  visible: string[];
  hiddenChars: number;
  hiddenBlocks: number;
  truncated: boolean;
}

export function windowBlocks(blocks: string[], options?: WindowBlocksOptions): WindowBlocksResult;

export interface MarkdownBlocksProps {
  text: string;
  budget?: number;
  renderBlock?: ComponentType<{ text: string }>;
}

export function MarkdownBlocks(props: MarkdownBlocksProps): ReactElement;
