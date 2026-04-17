import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message } from "../lib/api";
import { countAnthropicTokens, countEffectiveChatHistoryTokens } from "../lib/anthropic-tokens";
import { splitStreamingTextIntoDisplayChunkPlans, splitTextIntoDisplayChunkPlans, type TTSChunk } from "../hooks/useChunkedVastTTS";
import { extractRenderedMarkdownWordSourceRanges, type SourceRange } from "../lib/markdown-word-ranges";

const COLLAPSE_HEIGHT = 72;
const COLLAPSE_LINE_COUNT = 3;
const EDIT_TEXTAREA_MOBILE_MAX_HEIGHT = 260;
const EDIT_TEXTAREA_MAX_HEIGHT = 520;
const MOBILE_EDIT_MEDIA_QUERY = "(max-width: 768px), (pointer: coarse)";
const CHUNK_HITBOX_PADDING_X = 10;
const CHUNK_HITBOX_PADDING_Y = 6;
const CHUNK_ACTION_BUTTON_SIZE = 24;
const CHUNK_ACTION_BUTTON_MARGIN = 4;
const MAX_CHUNK_PLAN_CACHE_ENTRIES = 256;

interface ChunkHighlightRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ChunkHighlightLayout {
  rects: ChunkHighlightRect[];
  bounds: ChunkHighlightRect | null;
  hitBounds: ChunkHighlightRect | null;
}

interface TextWordRange {
  node: Text;
  startOffset: number;
  endOffset: number;
}

interface RenderedWordRange extends TextWordRange {
  sourceStartOffset: number;
  sourceEndOffset: number;
}

interface PreparedChunkPlan {
  sourceStartOffset: number;
  sourceEndOffset: number;
  wordCount: number;
}

function areMessagesEqual(left: Message[], right: Message[]) {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const leftMessage = left[index];
    const rightMessage = right[index];
    if (leftMessage === rightMessage) continue;
    if (!leftMessage || !rightMessage) return false;
    if (
      leftMessage.id !== rightMessage.id ||
      leftMessage.role !== rightMessage.role ||
      leftMessage.content !== rightMessage.content ||
      leftMessage.created_at !== rightMessage.created_at ||
      leftMessage.status !== rightMessage.status
    ) {
      return false;
    }
  }
  return true;
}

function areSetsEqual(left?: Set<string>, right?: Set<string>) {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function areTtsChunksEqual(left: TTSChunk[] = [], right: TTSChunk[] = []) {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const leftChunk = left[index];
    const rightChunk = right[index];
    if (leftChunk === rightChunk) continue;
    if (!leftChunk || !rightChunk) return false;
    if (
      leftChunk.text !== rightChunk.text ||
      leftChunk.displayText !== rightChunk.displayText ||
      leftChunk.sourceStartOffset !== rightChunk.sourceStartOffset ||
      leftChunk.sourceEndOffset !== rightChunk.sourceEndOffset ||
      leftChunk.status !== rightChunk.status
    ) {
      return false;
    }
  }
  return true;
}

function areSourceRangesEqual(left: SourceRange[] = [], right: SourceRange[] = []) {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const leftRange = left[index];
    const rightRange = right[index];
    if (!leftRange || !rightRange) return false;
    if (leftRange.start !== rightRange.start || leftRange.end !== rightRange.end) {
      return false;
    }
  }
  return true;
}

function areNumberArraysEqual(left: number[] = [], right: number[] = []) {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

const MemoizedMarkdownContent = memo(
  function MarkdownContent({ content }: { content: string }) {
    return <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>;
  },
  (previousProps, nextProps) => previousProps.content === nextProps.content,
);

interface MessageBubbleProps {
  message: Message;
  tokenCount: number;
  isStreaming?: boolean;
  isDeleting?: boolean;
  isSaving?: boolean;
  isForking?: boolean;
  onEdit?: (content: string) => void;
  onDelete?: () => void;
  onRegenerate?: (messageId: string) => void;
  regenerateTargetMessageId?: string | null;
  onFork?: () => void;
  onContinue?: (messageContent: string) => void;
  onCompact?: () => void;
  onToggleTTS?: () => void;
  onPlayTTSChunk?: (chunkIndex: number) => void;
  onWordClick?: (e: React.MouseEvent, wordIndex: number) => void;
  disableContinue?: boolean;
  forceCollapsed?: boolean;
  actionDisabled?: boolean;
  isTTSActive?: boolean;
  isTTSPlaying?: boolean;
  isTTSLoading?: boolean;
  ttsCurrentChunk?: number;
  ttsAutoScrollEnabled?: boolean;
  chunkSourceRanges?: SourceRange[];
  chunkWordCounts?: number[];
}

function collectRenderedWordRanges(root: HTMLElement): TextWordRange[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const words: TextWordRange[] = [];
  let currentNode = walker.nextNode();

  while (currentNode) {
    if (currentNode.nodeType === Node.TEXT_NODE) {
      const textNode = currentNode as Text;
      const content = textNode.textContent || "";
      const matches = content.matchAll(/\S+/g);

      for (const match of matches) {
        const startOffset = match.index ?? 0;
        words.push({
          node: textNode,
          startOffset,
          endOffset: startOffset + match[0].length,
        });
      }
    }

    currentNode = walker.nextNode();
  }

  return words;
}

function buildRangeLayout(root: HTMLElement, startWord: TextWordRange, endWord: TextWordRange): ChunkHighlightLayout {
  const rootRect = root.getBoundingClientRect();
  const range = document.createRange();
  range.setStart(startWord.node, startWord.startOffset);
  range.setEnd(endWord.node, endWord.endOffset);

  const rects = Array.from(range.getClientRects())
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => ({
      left: rect.left - rootRect.left,
      top: rect.top - rootRect.top,
      width: rect.width,
      height: rect.height,
    }));

  if (rects.length === 0) {
    return { rects: [], bounds: null, hitBounds: null };
  }

  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.left + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.top + rect.height));
  const hitLeft = Math.max(0, left - CHUNK_HITBOX_PADDING_X);
  const hitTop = Math.max(0, top - CHUNK_HITBOX_PADDING_Y);
  const hitRight = Math.min(rootRect.width, right + CHUNK_HITBOX_PADDING_X);
  const hitBottom = Math.min(rootRect.height, bottom + CHUNK_HITBOX_PADDING_Y);

  return {
    rects,
    bounds: {
      left,
      top,
      width: right - left,
      height: bottom - top,
    },
    hitBounds: {
      left: hitLeft,
      top: hitTop,
      width: Math.max(0, hitRight - hitLeft),
      height: Math.max(0, hitBottom - hitTop),
    },
  };
}

function buildChunkHighlightLayoutsFromWordCounts(root: HTMLElement, chunkWordCounts: number[]): ChunkHighlightLayout[] {
  const renderedWords = collectRenderedWordRanges(root);
  if (renderedWords.length === 0) {
    return chunkWordCounts.map(() => ({ rects: [], bounds: null, hitBounds: null }));
  }

  const layouts: ChunkHighlightLayout[] = [];
  let nextWordIndex = 0;

  for (let chunkIndex = 0; chunkIndex < chunkWordCounts.length; chunkIndex++) {
    const requestedWordCount = Math.max(1, chunkWordCounts[chunkIndex] || 0);
    if (nextWordIndex >= renderedWords.length) {
      layouts.push({ rects: [], bounds: null, hitBounds: null });
      continue;
    }

    const startWord = nextWordIndex;
    const endWord = chunkIndex === chunkWordCounts.length - 1
      ? renderedWords.length - 1
      : Math.min(renderedWords.length - 1, startWord + requestedWordCount - 1);
    nextWordIndex = endWord + 1;
    const startRenderedWord = renderedWords[startWord];
    const endRenderedWord = renderedWords[endWord];
    if (!startRenderedWord || !endRenderedWord) {
      layouts.push({ rects: [], bounds: null, hitBounds: null });
      continue;
    }

    layouts.push(buildRangeLayout(root, startRenderedWord, endRenderedWord));
  }

  return layouts;
}

function buildChunkHighlightLayouts(root: HTMLElement, markdown: string, chunkSourceRanges: SourceRange[], fallbackWordCounts: number[]): ChunkHighlightLayout[] {
  const renderedWords = collectRenderedWordRanges(root);
  if (renderedWords.length === 0) {
    return chunkSourceRanges.map(() => ({ rects: [], bounds: null, hitBounds: null }));
  }

  const sourceWords = extractRenderedMarkdownWordSourceRanges(markdown);
  if (sourceWords.length !== renderedWords.length) {
    return buildChunkHighlightLayoutsFromWordCounts(root, fallbackWordCounts);
  }

  const renderedWordsWithSource: RenderedWordRange[] = renderedWords.map((word, index) => ({
    ...word,
    sourceStartOffset: sourceWords[index]?.start ?? 0,
    sourceEndOffset: sourceWords[index]?.end ?? 0,
  }));

  const layouts: ChunkHighlightLayout[] = [];
  let searchStartIndex = 0;

  for (const chunkSourceRange of chunkSourceRanges) {
    let startWordIndex = -1;
    for (let wordIndex = searchStartIndex; wordIndex < renderedWordsWithSource.length; wordIndex++) {
      const renderedWord = renderedWordsWithSource[wordIndex];
      if (!renderedWord) continue;
      if (renderedWord.sourceEndOffset > chunkSourceRange.start) {
        startWordIndex = wordIndex;
        break;
      }
    }

    if (startWordIndex === -1) {
      layouts.push({ rects: [], bounds: null, hitBounds: null });
      continue;
    }

    let endWordIndex = startWordIndex;
    for (let wordIndex = startWordIndex; wordIndex < renderedWordsWithSource.length; wordIndex++) {
      const renderedWord = renderedWordsWithSource[wordIndex];
      if (!renderedWord || renderedWord.sourceStartOffset >= chunkSourceRange.end) {
        break;
      }
      endWordIndex = wordIndex;
    }

    searchStartIndex = endWordIndex + 1;
    const startRenderedWord = renderedWordsWithSource[startWordIndex];
    const endRenderedWord = renderedWordsWithSource[endWordIndex];
    if (!startRenderedWord || !endRenderedWord) {
      layouts.push({ rects: [], bounds: null, hitBounds: null });
      continue;
    }

    layouts.push(buildRangeLayout(root, startRenderedWord, endRenderedWord));
  }

  return layouts;
}

function isPointInRect(rect: ChunkHighlightRect | null, x: number, y: number) {
  if (!rect) return false;
  return x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height;
}

function findChunkIndexAtPoint(layouts: ChunkHighlightLayout[], x: number, y: number): number | null {
  let matchedChunkIndex: number | null = null;
  let matchedArea = Number.POSITIVE_INFINITY;

  for (let chunkIndex = 0; chunkIndex < layouts.length; chunkIndex++) {
    const layout = layouts[chunkIndex];
    if (!layout || !isPointInRect(layout.hitBounds, x, y)) continue;

    const area = (layout.hitBounds?.width ?? 0) * (layout.hitBounds?.height ?? 0);
    if (area < matchedArea) {
      matchedChunkIndex = chunkIndex;
      matchedArea = area;
    }
  }

  return matchedChunkIndex;
}

interface MessageListProps {
  messages: Message[];
  streamingContent: string;
  streamingMessageId?: string | null;
  thinkingStatus?: string | null;
  onEditMessage?: (messageId: string, content: string) => void;
  onDeleteMessage?: (messageId: string) => void;
  onRegenerate?: (messageId: string) => void;
  onFork?: (messageId: string) => void;
  onContinue?: (messageContent: string) => void;
  onCompact?: (messageId: string) => void;
  onToggleTTS?: (messageId: string, content: string) => void;
  onPlayTTSChunk?: (messageId: string, content: string, chunkIndex: number) => void;
  onWordClick?: (e: React.MouseEvent, wordIndex: number, messageId: string, text: string) => void;
  actionLoading?: string | null;
  collapsedIds?: Set<string>;
  suppressAutoScrollOnNextAppend?: boolean;
  onAutoScrollSuppressed?: () => void;
  disableAutoScroll?: boolean;
  disableQuickContinue?: boolean;
  isNearBottom?: () => boolean;
  compactBusy?: boolean;
  // TTS state
  ttsActiveMessageId?: string | null;
  ttsChunks?: TTSChunk[];
  ttsCurrentChunk?: number;
  ttsIsPlaying?: boolean;
  ttsIsLoading?: boolean;
  ttsAutoScrollEnabled?: boolean;
  bottomSpacerHeight?: number;
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return time;
  if (isYesterday) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

function formatTokenCount(count: number): string {
  return `${count.toLocaleString()} token${count === 1 ? "" : "s"}`;
}

function MessageList({
  messages,
  streamingContent,
  streamingMessageId,
  thinkingStatus,
  onEditMessage,
  onDeleteMessage,
  onRegenerate,
  onFork,
  onContinue,
  onCompact,
  onToggleTTS,
  onPlayTTSChunk,
  onWordClick,
  actionLoading,
  collapsedIds = new Set(),
  suppressAutoScrollOnNextAppend = false,
  onAutoScrollSuppressed,
  disableAutoScroll = false,
  disableQuickContinue = false,
  isNearBottom,
  compactBusy = false,
  ttsActiveMessageId,
  ttsChunks,
  ttsCurrentChunk,
  ttsIsPlaying,
  ttsIsLoading,
  ttsAutoScrollEnabled = false,
  bottomSpacerHeight = 0,
}: MessageListProps) {
  const dedupedMessages = useMemo(
    () => streamingContent && streamingMessageId
      ? messages.filter((message) => message.id !== streamingMessageId)
      : messages,
    [messages, streamingContent, streamingMessageId],
  );
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevMessageLengthRef = useRef(dedupedMessages.length);
  const chunkPlanCacheRef = useRef(new Map<string, { content: string; streaming: boolean; plans: PreparedChunkPlan[] }>());
  const activeTtsChunkPlans = useMemo(
    () => ttsChunks?.map((chunk) => ({
      sourceStartOffset: chunk.sourceStartOffset,
      sourceEndOffset: chunk.sourceEndOffset,
      wordCount: chunk.text.split(/\s+/).filter(Boolean).length,
    })) ?? [],
    [ttsChunks],
  );

  const items: (Message & { isStreaming?: boolean })[] = useMemo(
    () => [
      ...dedupedMessages,
      ...(streamingContent
        ? [{
            id: streamingMessageId || "streaming",
            session_id: "",
            role: "assistant" as const,
            content: streamingContent,
            created_at: Date.now() / 1000,
            isStreaming: true,
          }]
        : []),
    ],
    [dedupedMessages, streamingContent, streamingMessageId],
  );
  const tokenCountsByMessageId = useMemo(() => {
    const counts = new Map<string, number>();

    for (const item of items) {
      counts.set(item.id, countAnthropicTokens(item.content));
    }

    return counts;
  }, [items]);
  const effectiveHistoryTokenCount = useMemo(
    () => countEffectiveChatHistoryTokens(items),
    [items],
  );

  const regenerateTargetByMessageId = useMemo(() => {
    const targets = new Map<string, string | null>();
    let lastUserMessageId: string | null = null;

    for (const item of items) {
      if (item.role === "user") {
        lastUserMessageId = item.id;
        targets.set(item.id, item.id);
        continue;
      }

      targets.set(item.id, lastUserMessageId);
    }

    return targets;
  }, [items]);

  useEffect(() => {
    const cache = chunkPlanCacheRef.current;
    const validMessageIds = new Set(items.map((item) => item.id));
    for (const cacheKey of Array.from(cache.keys())) {
      const separatorIndex = cacheKey.indexOf(":");
      const messageId = separatorIndex >= 0 ? cacheKey.slice(0, separatorIndex) : cacheKey;
      if (!validMessageIds.has(messageId)) {
        cache.delete(cacheKey);
      }
    }
  }, [items]);

  const getCachedChunkPlans = (messageId: string, content: string, isStreamingMessage: boolean): PreparedChunkPlan[] => {
    const cacheKey = `${messageId}:${isStreamingMessage ? "streaming" : "static"}`;
    const cached = chunkPlanCacheRef.current.get(cacheKey);
    if (cached && cached.content === content && cached.streaming === isStreamingMessage) {
      return cached.plans;
    }

    const plans = (isStreamingMessage
      ? splitStreamingTextIntoDisplayChunkPlans(content)
      : splitTextIntoDisplayChunkPlans(content)
    ).map((chunk) => ({
      sourceStartOffset: chunk.sourceStartOffset,
      sourceEndOffset: chunk.sourceEndOffset,
      wordCount: chunk.text.split(/\s+/).filter(Boolean).length,
    }));

    chunkPlanCacheRef.current.set(cacheKey, {
      content,
      streaming: isStreamingMessage,
      plans,
    });

    while (chunkPlanCacheRef.current.size > MAX_CHUNK_PLAN_CACHE_ENTRIES) {
      const oldestKey = chunkPlanCacheRef.current.keys().next().value;
      if (!oldestKey) {
        break;
      }
      chunkPlanCacheRef.current.delete(oldestKey);
    }

    return plans;
  };

  useEffect(() => {
    const prevLength = prevMessageLengthRef.current;
    const nextLength = messages.length;
    const isAppend = nextLength > prevLength;

    const shouldAutoScroll = (() => {
      if (!isAppend) return false;
      if (suppressAutoScrollOnNextAppend || disableAutoScroll) return false;

      // For the very first append into an empty list, let it auto-scroll like before.
      if (prevLength === 0) return true;

      // Otherwise only auto-scroll when the user is already near the bottom.
      if (!isNearBottom) return true;

      return isNearBottom();
    })();

    if (isAppend && shouldAutoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    } else if (isAppend) {
      onAutoScrollSuppressed?.();
    }

    prevMessageLengthRef.current = nextLength;
  }, [dedupedMessages.length, disableAutoScroll, isNearBottom, onAutoScrollSuppressed, suppressAutoScrollOnNextAppend]);

  if (items.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 dark:text-gray-500">
        <div className="text-center">
          <svg className="w-12 h-12 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          <p>Start a conversation</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {items.map((item) => {
        const isDeleting = actionLoading === `delete-msg-${item.id}`;
        const isActivelyStreaming = !!item.isStreaming || item.status === "streaming";
        const isUserItem = item.role === "user";
        const regenerateTargetMessageId = regenerateTargetByMessageId.get(item.id) ?? null;

        const isTTSActive = ttsActiveMessageId === item.id;
        const messageChunkPlans = isTTSActive && activeTtsChunkPlans.length > 0
          ? activeTtsChunkPlans
          : getCachedChunkPlans(item.id, item.content, isActivelyStreaming);

        return (
          <MemoizedMessageBubble
            key={item.id}
            message={item}
            tokenCount={tokenCountsByMessageId.get(item.id) ?? 0}
            isStreaming={isActivelyStreaming}
            isDeleting={isDeleting}
            onEdit={onEditMessage && !isActivelyStreaming ? (content: string) => onEditMessage(item.id, content) : undefined}
            onDelete={onDeleteMessage && !isActivelyStreaming ? () => onDeleteMessage(item.id) : undefined}
            onRegenerate={onRegenerate && !isActivelyStreaming ? onRegenerate : undefined}
            regenerateTargetMessageId={regenerateTargetMessageId}
            onFork={onFork && !isActivelyStreaming ? () => onFork(item.id) : undefined}
            onContinue={onContinue && !isActivelyStreaming && !isUserItem ? () => onContinue(item.content) : undefined}
            onCompact={onCompact && !isActivelyStreaming ? () => onCompact(item.id) : undefined}
            onToggleTTS={onToggleTTS && !isUserItem ? () => onToggleTTS(item.id, item.content) : undefined}
            onPlayTTSChunk={onPlayTTSChunk && !isUserItem ? (chunkIndex: number) => onPlayTTSChunk(item.id, item.content, chunkIndex) : undefined}
            onWordClick={onWordClick ? (e, wordIndex) => onWordClick(e, wordIndex, item.id, item.content) : undefined}
            forceCollapsed={collapsedIds.has(item.id)}
            isSaving={actionLoading === `edit-msg-${item.id}`}
            isForking={actionLoading === `fork-${item.id}`}
            disableContinue={disableQuickContinue}
            actionDisabled={compactBusy}
            isTTSActive={isTTSActive}
            isTTSPlaying={isTTSActive && ttsIsPlaying}
            isTTSLoading={isTTSActive && ttsIsLoading}
            ttsCurrentChunk={ttsCurrentChunk}
            ttsAutoScrollEnabled={ttsAutoScrollEnabled}
            chunkSourceRanges={messageChunkPlans.map((chunk) => ({ start: chunk.sourceStartOffset, end: chunk.sourceEndOffset }))}
            chunkWordCounts={messageChunkPlans.map((chunk) => chunk.wordCount)}
          />
        );
      })}

      <div className="flex justify-center pt-1">
        <div className="rounded-full border border-gray-200 bg-white px-3 py-1 text-[11px] text-gray-500 shadow-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">
          Next request context: <span className="font-medium text-gray-700 dark:text-gray-100">{formatTokenCount(effectiveHistoryTokenCount)}</span>
        </div>
      </div>

      {/* Thinking indicator */}
      {thinkingStatus && !streamingContent && (
        <div className="flex flex-col items-start">
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-2.5 flex items-center gap-2">
            <div className="flex gap-1">
              <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
              <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
              <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
            <span className="text-xs text-gray-500 dark:text-gray-400">{thinkingStatus}…</span>
          </div>
        </div>
      )}

      {bottomSpacerHeight > 0 && <div aria-hidden="true" style={{ height: `${bottomSpacerHeight}px` }} />}
      <div ref={bottomRef} />
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1 px-1.5 py-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors rounded text-xs"
      title={copied ? "Copied!" : label || "Copy"}
    >
      {copied ? (
        <svg className="w-3.5 h-3.5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
    </button>
  );
}

function IconButton({ onClick, title, children, className = "", disabled = false }: {
  onClick: (e: React.MouseEvent) => void;
  title: string;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 px-1.5 py-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors rounded text-xs ${disabled ? "opacity-50 cursor-not-allowed" : ""} ${className}`}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

function MessageBubble({
  message,
  tokenCount,
  isStreaming = false,
  isDeleting = false,
  isSaving = false,
  isForking = false,
  onEdit,
  onDelete,
  onRegenerate,
  regenerateTargetMessageId,
  onFork,
  onContinue,
  onCompact,
  onToggleTTS,
  onPlayTTSChunk,
  onWordClick,
  disableContinue = false,
  forceCollapsed = false,
  actionDisabled = false,
  isTTSActive = false,
  isTTSPlaying = false,
  isTTSLoading = false,
  ttsCurrentChunk,
  ttsAutoScrollEnabled = false,
  chunkSourceRanges = [],
  chunkWordCounts = [],
}: MessageBubbleProps) {
  const isUser = message.role === "user";
  const contentRef = useRef<HTMLDivElement>(null);
  const markdownRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isLong, setIsLong] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [confirmAction, setConfirmAction] = useState<"delete" | "regenerate" | null>(null);
  const [isMobileEditMode, setIsMobileEditMode] = useState(false);
  const [hoveredChunkIndex, setHoveredChunkIndex] = useState<number | null>(null);
  const [selectedChunkIndex, setSelectedChunkIndex] = useState<number | null>(null);
  const [chunkLayouts, setChunkLayouts] = useState<ChunkHighlightLayout[]>([]);
  const hoveredChunkFrameRef = useRef<number | null>(null);
  const pendingHoveredChunkIndexRef = useRef<number | null>(null);

  const resizeEditTextarea = (textarea: HTMLTextAreaElement) => {
    textarea.style.height = "auto";
    const maxHeight = isMobileEditMode ? EDIT_TEXTAREA_MOBILE_MAX_HEIGHT : EDIT_TEXTAREA_MAX_HEIGHT;
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mediaQuery = window.matchMedia(MOBILE_EDIT_MEDIA_QUERY);
    const handleChange = () => setIsMobileEditMode(mediaQuery.matches);
    handleChange();

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  useEffect(() => {
    if (contentRef.current && !editing) {
      const lineCount = message.content.split("\n").length;
      const height = contentRef.current.scrollHeight;
      setIsLong(lineCount > COLLAPSE_LINE_COUNT || height > COLLAPSE_HEIGHT + 20);
    }
  }, [message.content, editing]);

  useEffect(() => {
    if (isLong) setCollapsed(forceCollapsed);
  }, [forceCollapsed, isLong]);

  useEffect(() => {
    if (editing && textareaRef.current) {
      const textarea = textareaRef.current;
      const scrollContainer = textarea.closest("[data-chat-scroll-container]") as HTMLElement | null;
      const prevScrollTop = scrollContainer?.scrollTop;
      const prevWindowY = window.scrollY;

      try {
        textarea.focus({ preventScroll: true });
      } catch {
        textarea.focus();
      }
      resizeEditTextarea(textarea);

      if (scrollContainer) {
        requestAnimationFrame(() => {
          if (prevScrollTop !== undefined && prevScrollTop !== null) {
            scrollContainer.scrollTop = prevScrollTop;
          }
        });
        return;
      }

      requestAnimationFrame(() => {
        window.scrollTo({ top: prevWindowY, behavior: "auto" });
      });
    }
  }, [editing]);

  const startEdit = () => { setEditValue(message.content); setEditing(true); setCollapsed(false); };
  const cancelEdit = () => { setEditing(false); setEditValue(""); };
  const saveEdit = () => {
    if (editValue.trim() && editValue !== message.content) onEdit?.(editValue.trim());
    setEditing(false); setEditValue("");
  };
  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") cancelEdit();
    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEdit(); }
  };

  const isCollapsed = collapsed && isLong && !editing;
  const isBusy = isDeleting || isSaving || isForking || actionDisabled;
  const displayedTokenCount = editing ? countAnthropicTokens(editValue) : tokenCount;
  const shouldRenderChunkLayout = !isUser && chunkSourceRanges.length > 1;
  const shouldRenderChunkActions = !isUser && !!onPlayTTSChunk && chunkSourceRanges.length > 1;
  const shouldEnableChunkSelection = shouldRenderChunkLayout && !!onPlayTTSChunk;
  const interactiveChunkIndex = hoveredChunkIndex ?? selectedChunkIndex;
  const actionChunkIndex = interactiveChunkIndex ?? (isTTSActive ? (ttsCurrentChunk ?? null) : null);
  const showInlineTtsButton = !isUser && !editing && !!onToggleTTS;
  const chunkSourceSignature = chunkSourceRanges.map((range) => `${range.start}:${range.end}`).join("|");
  const chunkWordSignature = chunkWordCounts.join(",");

  useEffect(() => {
    setHoveredChunkIndex(null);
    setSelectedChunkIndex(null);
  }, [message.id]);

  useEffect(() => () => {
    if (hoveredChunkFrameRef.current !== null) {
      window.cancelAnimationFrame(hoveredChunkFrameRef.current);
      hoveredChunkFrameRef.current = null;
    }
  }, []);

  const scheduleHoveredChunkIndex = useCallback((nextChunkIndex: number | null) => {
    pendingHoveredChunkIndexRef.current = nextChunkIndex;

    if (hoveredChunkFrameRef.current !== null) {
      return;
    }

    hoveredChunkFrameRef.current = window.requestAnimationFrame(() => {
      hoveredChunkFrameRef.current = null;
      setHoveredChunkIndex((current) => current === pendingHoveredChunkIndexRef.current ? current : pendingHoveredChunkIndexRef.current);
    });
  }, []);

  useEffect(() => {
    const markdownElement = markdownRef.current;
    if (!markdownElement || !shouldRenderChunkLayout || !chunkSourceRanges.length || editing || isCollapsed) {
      setChunkLayouts([]);
      return;
    }

    const updateChunkLayouts = () => {
      const currentRoot = markdownRef.current;
      if (!currentRoot) return;
      setChunkLayouts(buildChunkHighlightLayouts(currentRoot, message.content, chunkSourceRanges, chunkWordCounts));
    };

    updateChunkLayouts();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateChunkLayouts);
      return () => window.removeEventListener("resize", updateChunkLayouts);
    }

    const resizeObserver = new ResizeObserver(() => {
      updateChunkLayouts();
    });
    resizeObserver.observe(markdownElement);
    window.addEventListener("resize", updateChunkLayouts);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateChunkLayouts);
    };
  }, [chunkSourceSignature, chunkWordSignature, chunkSourceRanges, chunkWordCounts, editing, isCollapsed, message.content, shouldRenderChunkLayout]);

  useEffect(() => {
    if (!ttsAutoScrollEnabled || !isTTSActive || isCollapsed || editing || !shouldRenderChunkLayout) {
      return;
    }

    if (ttsCurrentChunk === undefined || ttsCurrentChunk < 0) {
      return;
    }

    const targetLayout = chunkLayouts[ttsCurrentChunk];
    const targetBounds = targetLayout?.bounds;
    if (!targetBounds || !contentRef.current) {
      return;
    }

    requestAnimationFrame(() => {
      const scrollContainer = contentRef.current?.closest("[data-chat-scroll-container]") as HTMLElement | null;
      if (!scrollContainer || !contentRef.current) {
        return;
      }

      const contentRect = contentRef.current.getBoundingClientRect();
      const scrollRect = scrollContainer.getBoundingClientRect();
      const targetCenter = scrollContainer.scrollTop + (contentRect.top - scrollRect.top) + targetBounds.top + (targetBounds.height / 2);
      scrollContainer.scrollTo({
        top: Math.max(0, targetCenter - (scrollContainer.clientHeight / 2)),
        behavior: "smooth",
      });
    });
  }, [chunkLayouts, editing, isCollapsed, isTTSActive, shouldRenderChunkLayout, ttsAutoScrollEnabled, ttsCurrentChunk]);

  const resolveChunkIndexFromPointer = (clientX: number, clientY: number) => {
    const contentElement = contentRef.current;
    if (!contentElement) {
      return null;
    }

    const contentRect = contentElement.getBoundingClientRect();
    return findChunkIndexAtPoint(chunkLayouts, clientX - contentRect.left, clientY - contentRect.top);
  };

  const handleChunkPointerMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!shouldEnableChunkSelection) return;
    scheduleHoveredChunkIndex(resolveChunkIndexFromPointer(event.clientX, event.clientY));
  };

  const handleChunkPointerLeave = () => {
    scheduleHoveredChunkIndex(null);
  };

  const handleChunkPointerSelect = (clientX: number, clientY: number) => {
    if (!shouldEnableChunkSelection) return;
    const nextChunkIndex = resolveChunkIndexFromPointer(clientX, clientY);
    if (nextChunkIndex === null) {
      return;
    }

    setSelectedChunkIndex((current) => current === nextChunkIndex ? null : nextChunkIndex);
  };

  const activeChunkLayout = actionChunkIndex !== null ? chunkLayouts[actionChunkIndex] : null;
  const actionLayoutBounds = activeChunkLayout?.hitBounds ?? activeChunkLayout?.bounds ?? null;
  const contentWidth = contentRef.current?.clientWidth ?? 0;
  const contentHeight = contentRef.current?.clientHeight ?? 0;

  return (
    <div
      className={`group ${isUser ? "flex flex-col items-end" : "flex flex-col items-start"} ${isBusy ? "opacity-50" : ""}`}
      style={{ contentVisibility: "auto", containIntrinsicSize: "160px" }}
    >
      {/* Timestamp */}
      <div className={`text-[10px] text-gray-400 dark:text-gray-500 mb-0.5 px-1 ${isUser ? "text-right" : "text-left"}`}>
        {formatTime(message.created_at)}
      </div>

      {/* Message bubble */}
      <div
        className={`w-full sm:max-w-[85%] md:max-w-[80%] rounded-lg relative ${
          isUser
            ? "bg-gray-900 text-white dark:bg-gray-700 px-4 py-2"
            : `bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border px-4 py-2 ${
                isTTSActive
                  ? "border-emerald-500 dark:border-emerald-400 ring-2 ring-emerald-500/20 dark:ring-emerald-400/20"
                  : "border-gray-200 dark:border-gray-700"
              }`
        }`}
      >
        {showInlineTtsButton && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleTTS?.();
            }}
            className={`absolute right-2 top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full border shadow-sm backdrop-blur transition-colors ${isTTSActive ? "border-emerald-300 bg-emerald-50/95 text-emerald-600 hover:bg-emerald-100 dark:border-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300 dark:hover:bg-emerald-900/70" : "border-gray-200 bg-white/95 text-gray-400 hover:border-gray-300 hover:bg-gray-100 hover:text-gray-600 dark:border-gray-700 dark:bg-gray-800/95 dark:text-gray-400 dark:hover:border-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-200"}`}
            title={isTTSPlaying ? "Pause (Space)" : isTTSActive ? "Resume (Space)" : isStreaming ? "Read current stream aloud" : "Read aloud"}
            aria-label={isTTSPlaying ? "Pause reading aloud" : isTTSActive ? "Resume reading aloud" : isStreaming ? "Read current stream aloud" : "Read message aloud"}
          >
            {isTTSLoading ? (
              <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : isTTSPlaying ? (
              <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
            ) : (
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
              </svg>
            )}
          </button>
        )}

        {editing ? (
          <div className="space-y-2">
            <textarea
              ref={textareaRef}
              value={editValue}
              onChange={(e) => {
                setEditValue(e.target.value);
                resizeEditTextarea(e.target);
              }}
              onKeyDown={handleEditKeyDown}
              className={`w-full text-sm resize-none rounded-md p-2 focus:outline-none focus:ring-1 focus:ring-blue-500 ${
                isUser
                  ? "bg-gray-800 text-white border border-gray-600"
                  : "bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600"
              }`}
              rows={3}
            />
            <div className="flex items-center gap-2 justify-end">
              <span className="text-xs text-gray-400">Ctrl+Enter to save</span>
              <button onClick={cancelEdit} className={`text-xs px-2 py-1 rounded ${isUser ? "text-gray-300 hover:text-white hover:bg-gray-800" : "text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"}`}>Cancel</button>
              <button onClick={saveEdit} className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700">Save</button>
            </div>
          </div>
        ) : (
          <>
            <div
              ref={contentRef}
              onMouseMove={handleChunkPointerMove}
              onMouseLeave={handleChunkPointerLeave}
              onClick={(event) => {
                if (!shouldEnableChunkSelection) return;
                if ((event.target as HTMLElement).closest("button, a, input, textarea, select")) {
                  return;
                }
                handleChunkPointerSelect(event.clientX, event.clientY);
              }}
              onDoubleClick={(event) => {
                if (!shouldEnableChunkSelection) return;
                if ((event.target as HTMLElement).closest("button, a, input, textarea, select")) {
                  return;
                }

                const nextChunkIndex = resolveChunkIndexFromPointer(event.clientX, event.clientY);
                if (nextChunkIndex === null) {
                  return;
                }

                event.preventDefault();
                event.stopPropagation();
                setSelectedChunkIndex(nextChunkIndex);
                onPlayTTSChunk?.(nextChunkIndex);
              }}
              onTouchStart={(event) => {
                if (!shouldEnableChunkSelection) return;
                const touch = event.touches[0];
                if (!touch) return;
                handleChunkPointerSelect(touch.clientX, touch.clientY);
              }}
              className={`relative overflow-hidden transition-all duration-200 ${isCollapsed ? "max-h-[72px]" : ""}`}
            >
              <div ref={markdownRef} className={`relative z-10 flow-root markdown-content text-sm break-words ${isUser ? "markdown-user" : ""}`}>
                <div className="pointer-events-none absolute inset-0 z-0">
                  {chunkLayouts.map((layout, chunkIndex) => {
                    const isCurrentChunk = isTTSActive && ttsCurrentChunk === chunkIndex;
                    const isInteractiveChunk = interactiveChunkIndex === chunkIndex && !isCurrentChunk;
                    if (!isCurrentChunk && !isInteractiveChunk) {
                      return null;
                    }

                    return layout.rects.map((rect, rectIndex) => (
                      <div
                        key={`${message.id}-highlight-${chunkIndex}-${rectIndex}`}
                        className={`absolute rounded-sm ${
                          isCurrentChunk
                            ? "bg-emerald-200/85 ring-1 ring-emerald-300/80 dark:bg-emerald-400/20 dark:ring-emerald-300/35"
                            : "bg-amber-50/80 ring-1 ring-amber-200/70 dark:bg-amber-500/10 dark:ring-amber-400/20"
                        }`}
                        style={{
                          left: `${rect.left - 1}px`,
                          top: `${rect.top - 1}px`,
                          width: `${rect.width + 2}px`,
                          height: `${rect.height + 2}px`,
                        }}
                      />
                    ));
                  })}
                </div>
                <div className="relative z-10">
                  <MemoizedMarkdownContent content={message.content} />
                </div>
              </div>
              {shouldRenderChunkActions && actionChunkIndex !== null && actionLayoutBounds && (
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    onPlayTTSChunk?.(actionChunkIndex);
                  }}
                  className={`absolute z-20 inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border shadow-sm transition-all ${
                    isTTSActive && ttsCurrentChunk === actionChunkIndex
                      ? "border-emerald-400 bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:border-emerald-500 dark:bg-emerald-900 dark:text-emerald-300 dark:hover:bg-emerald-800"
                      : "border-amber-300 bg-white text-amber-700 hover:bg-amber-100 dark:border-amber-500/50 dark:bg-gray-900 dark:text-amber-300 dark:hover:bg-gray-800"
                  }`}
                  style={{
                    left: `${Math.min(
                      Math.max(0, actionLayoutBounds.left + actionLayoutBounds.width - CHUNK_ACTION_BUTTON_SIZE - CHUNK_ACTION_BUTTON_MARGIN),
                      Math.max(0, contentWidth - CHUNK_ACTION_BUTTON_SIZE - CHUNK_ACTION_BUTTON_MARGIN),
                    )}px`,
                    top: `${Math.min(
                      Math.max(0, actionLayoutBounds.top + actionLayoutBounds.height - CHUNK_ACTION_BUTTON_SIZE - CHUNK_ACTION_BUTTON_MARGIN),
                      Math.max(0, contentHeight - CHUNK_ACTION_BUTTON_SIZE - CHUNK_ACTION_BUTTON_MARGIN),
                    )}px`,
                  }}
                  title={isTTSActive && ttsCurrentChunk === actionChunkIndex ? `Replay chunk ${actionChunkIndex + 1}` : `Start TTS from chunk ${actionChunkIndex + 1}`}
                  aria-label={isTTSActive && ttsCurrentChunk === actionChunkIndex ? `Replay chunk ${actionChunkIndex + 1}` : `Start TTS from chunk ${actionChunkIndex + 1}`}
                >
                  {isTTSActive && ttsCurrentChunk === actionChunkIndex && isTTSLoading ? (
                    <svg className="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  ) : (
                    <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  )}
                </button>
              )}
              {isStreaming && !isCollapsed && <span className="inline-block w-2 h-4 ml-1 bg-gray-500 animate-pulse" />}
              {isCollapsed && (
                <div className={`absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t ${
                  isUser ? "from-gray-900 dark:from-gray-700" : "from-white dark:from-gray-800"
                } pointer-events-none`} />
              )}
            </div>

            {isLong && (
              <button
                onClick={() => setCollapsed((prev) => !prev)}
                className={`text-xs mt-1 flex items-center gap-1.5 ${isUser ? "text-gray-300 hover:text-white" : "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"}`}
              >
                {isCollapsed ? "▼ Show more" : "▲ Show less"}
                {isCollapsed && isStreaming && (
                  <span className="inline-flex items-center gap-1 text-blue-500 dark:text-blue-400">
                    <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse" />
                    streaming…
                  </span>
                )}
              </button>
            )}

            {/* In-place TTS chunk highlight via CSS — active chunk text gets a background highlight.
                We inject a style tag that targets words by data attribute. The markdown renderer
                doesn't support per-word spans, so we use a simple overlay approach:
                wrap the markdown output in a container that applies highlight styles. */}
          </>
        )}
      </div>

      <div className={`mt-1 px-1 text-[10px] text-gray-400 dark:text-gray-500 ${isUser ? "text-right" : "text-left"}`}>
        {formatTokenCount(displayedTokenCount)}
      </div>

      {/* Action buttons - horizontal under the bubble */}
      {!isStreaming && !editing && !isBusy && (
        confirmAction ? (
          <div className={`flex items-center gap-2 mt-1 text-xs ${isUser ? "justify-end" : "justify-start"}`}>
            <span className="text-gray-500 dark:text-gray-400">
              {confirmAction === "delete" ? "Delete this message?" : "Regenerate from here? Messages below will be deleted."}
            </span>
            <button
              onClick={() => {
                if (confirmAction === "delete") onDelete?.();
                else if (confirmAction === "regenerate" && regenerateTargetMessageId) onRegenerate?.(regenerateTargetMessageId);
                setConfirmAction(null);
              }}
              className="px-2 py-0.5 rounded bg-red-600 text-white hover:bg-red-700"
            >
              Yes
            </button>
            <button
              onClick={() => setConfirmAction(null)}
              className="px-2 py-0.5 rounded text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              No
            </button>
          </div>
        ) : (
          <div className={`flex items-center gap-0.5 mt-0.5 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-opacity ${isUser ? "flex-row-reverse" : ""}`}>
            <CopyButton text={message.content} />

            {/* TTS Button */}
            {onToggleTTS && (
              <IconButton
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleTTS();
                }}
                title={isTTSPlaying ? "Pause (Space)" : isTTSActive ? "Resume (Space)" : "Read aloud"}
                className={isTTSActive ? "!text-emerald-500" : ""}
              >
                {isTTSLoading ? (
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                ) : isTTSPlaying ? (
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                    <rect x="6" y="4" width="4" height="16" rx="1" />
                    <rect x="14" y="4" width="4" height="16" rx="1" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                  </svg>
                )}
              </IconButton>
            )}

            {onEdit && (
              <IconButton onClick={startEdit} title="Edit">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </IconButton>
            )}

            {onRegenerate && (
              <IconButton onClick={(e) => { e.stopPropagation(); setConfirmAction("regenerate"); }} title="Regenerate response" className="hover:!text-green-500">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </IconButton>
            )}

            {onFork && (
              <IconButton onClick={(e) => { e.stopPropagation(); onFork(); }} title="Fork chat from here" className="hover:!text-purple-500">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                </svg>
              </IconButton>
            )}

            {onContinue && !isUser && (
              <IconButton
                onClick={(e) => {
                  e.stopPropagation();
                  onContinue(message.content);
                }}
                title="Continue"
                disabled={disableContinue}
                className="hover:!text-sky-500"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 12h14" />
                </svg>
              </IconButton>
            )}

            {onCompact && (
              <IconButton onClick={(e) => { e.stopPropagation(); onCompact?.(); }} title="Compact" className="hover:!text-blue-500">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7h16M12 3v18M7 13l5-5 5 5" />
                </svg>
              </IconButton>
            )}

            {onDelete && (
              <IconButton onClick={(e) => { e.stopPropagation(); setConfirmAction("delete"); }} title="Delete" className="hover:!text-red-500">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </IconButton>
            )}
          </div>
        )
      )}

      {/* Loading spinner when busy */}
      {isBusy && (
        <div className="mt-0.5 px-1">
          <svg className="w-3.5 h-3.5 animate-spin text-gray-400" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        </div>
      )}
    </div>
  );
}

function areMessageBubblePropsEqual(previousProps: Readonly<MessageBubbleProps>, nextProps: Readonly<MessageBubbleProps>) {
  const sameMessage = previousProps.message === nextProps.message || (
    previousProps.message.id === nextProps.message.id
    && previousProps.message.role === nextProps.message.role
    && previousProps.message.content === nextProps.message.content
    && previousProps.message.created_at === nextProps.message.created_at
    && previousProps.message.status === nextProps.message.status
  );

  if (!sameMessage) return false;

  if (
    previousProps.tokenCount !== nextProps.tokenCount
    ||
    previousProps.isStreaming !== nextProps.isStreaming
    || previousProps.isDeleting !== nextProps.isDeleting
    || previousProps.isSaving !== nextProps.isSaving
    || previousProps.isForking !== nextProps.isForking
    || previousProps.regenerateTargetMessageId !== nextProps.regenerateTargetMessageId
    || previousProps.disableContinue !== nextProps.disableContinue
    || previousProps.forceCollapsed !== nextProps.forceCollapsed
    || previousProps.actionDisabled !== nextProps.actionDisabled
    || previousProps.isTTSActive !== nextProps.isTTSActive
    || previousProps.isTTSPlaying !== nextProps.isTTSPlaying
    || previousProps.isTTSLoading !== nextProps.isTTSLoading
    || previousProps.ttsAutoScrollEnabled !== nextProps.ttsAutoScrollEnabled
  ) {
    return false;
  }

  if (
    Boolean(previousProps.onEdit) !== Boolean(nextProps.onEdit)
    || Boolean(previousProps.onDelete) !== Boolean(nextProps.onDelete)
    || Boolean(previousProps.onRegenerate) !== Boolean(nextProps.onRegenerate)
    || Boolean(previousProps.onFork) !== Boolean(nextProps.onFork)
    || Boolean(previousProps.onContinue) !== Boolean(nextProps.onContinue)
    || Boolean(previousProps.onCompact) !== Boolean(nextProps.onCompact)
    || Boolean(previousProps.onToggleTTS) !== Boolean(nextProps.onToggleTTS)
    || Boolean(previousProps.onPlayTTSChunk) !== Boolean(nextProps.onPlayTTSChunk)
    || Boolean(previousProps.onWordClick) !== Boolean(nextProps.onWordClick)
  ) {
    return false;
  }

  if (!areSourceRangesEqual(previousProps.chunkSourceRanges, nextProps.chunkSourceRanges)) {
    return false;
  }

  if (!areNumberArraysEqual(previousProps.chunkWordCounts, nextProps.chunkWordCounts)) {
    return false;
  }

  if ((previousProps.isTTSActive || nextProps.isTTSActive) && previousProps.ttsCurrentChunk !== nextProps.ttsCurrentChunk) {
    return false;
  }

  return true;
}

const MemoizedMessageBubble = memo(MessageBubble, areMessageBubblePropsEqual);

function areMessageListPropsEqual(previousProps: Readonly<MessageListProps>, nextProps: Readonly<MessageListProps>) {
  return areMessagesEqual(previousProps.messages, nextProps.messages)
    && previousProps.streamingContent === nextProps.streamingContent
    && previousProps.streamingMessageId === nextProps.streamingMessageId
    && previousProps.thinkingStatus === nextProps.thinkingStatus
    && previousProps.actionLoading === nextProps.actionLoading
    && areSetsEqual(previousProps.collapsedIds, nextProps.collapsedIds)
    && previousProps.suppressAutoScrollOnNextAppend === nextProps.suppressAutoScrollOnNextAppend
    && previousProps.disableAutoScroll === nextProps.disableAutoScroll
    && previousProps.disableQuickContinue === nextProps.disableQuickContinue
    && previousProps.compactBusy === nextProps.compactBusy
    && previousProps.ttsActiveMessageId === nextProps.ttsActiveMessageId
    && areTtsChunksEqual(previousProps.ttsChunks, nextProps.ttsChunks)
    && previousProps.ttsCurrentChunk === nextProps.ttsCurrentChunk
    && previousProps.ttsIsPlaying === nextProps.ttsIsPlaying
    && previousProps.ttsIsLoading === nextProps.ttsIsLoading
    && previousProps.ttsAutoScrollEnabled === nextProps.ttsAutoScrollEnabled
    && previousProps.bottomSpacerHeight === nextProps.bottomSpacerHeight;
}

export default memo(MessageList, areMessageListPropsEqual);
