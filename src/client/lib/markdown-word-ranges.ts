import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

export interface SourceRange {
  start: number;
  end: number;
}

interface MarkdownNode {
  type?: string;
  value?: string;
  alt?: string;
  children?: MarkdownNode[];
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
}

export interface MarkdownWordSourceRange extends SourceRange {
  text: string;
}

const markdownProcessor = unified().use(remarkParse).use(remarkGfm);

function collectWords(text: string, sourceStartOffset: number, words: MarkdownWordSourceRange[]) {
  const matches = text.matchAll(/\S+/g);

  for (const match of matches) {
    const value = match[0];
    if (!value) continue;
    const start = sourceStartOffset + (match.index ?? 0);
    words.push({
      text: value,
      start,
      end: start + value.length,
    });
  }
}

function collectVisibleNodeWords(markdown: string, node: MarkdownNode, words: MarkdownWordSourceRange[]) {
  if (!node?.type) {
    return;
  }

  if (node.type === "text") {
    const value = node.value ?? "";
    const startOffset = node.position?.start?.offset ?? 0;
    collectWords(value, startOffset, words);
    return;
  }

  if (node.type === "inlineCode" || node.type === "code") {
    const value = node.value ?? "";
    if (!value) return;
    const rawStartOffset = node.position?.start?.offset ?? 0;
    const rawEndOffset = node.position?.end?.offset ?? rawStartOffset;
    const rawSlice = markdown.slice(rawStartOffset, rawEndOffset);
    const relativeContentStart = rawSlice.indexOf(value);
    const contentStartOffset = rawStartOffset + (relativeContentStart >= 0 ? relativeContentStart : 0);
    collectWords(value, contentStartOffset, words);
    return;
  }

  if (node.type === "html" || node.type === "image") {
    return;
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      collectVisibleNodeWords(markdown, child, words);
    }
  }
}

export function extractRenderedMarkdownWordSourceRanges(markdown: string): MarkdownWordSourceRange[] {
  const tree = markdownProcessor.parse(markdown) as MarkdownNode;
  const words: MarkdownWordSourceRange[] = [];
  collectVisibleNodeWords(markdown, tree, words);
  return words;
}
