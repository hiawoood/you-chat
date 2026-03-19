import { useState, useRef, useEffect, useCallback, type TouchEvent as ReactTouchEvent } from "react";
import { api } from "../lib/api";
import type { ChatSession, Message, Agent } from "../lib/api";
import { useChat } from "../hooks/useChat";
import { useChunkedVastTTS } from "../hooks/useChunkedVastTTS";
import { useWordContextMenu } from "../hooks/useWordContextMenu";
import { useScrollDirection } from "../hooks/useScrollDirection";
import MessageList from "./MessageList";
import MessageInput from "./MessageInput";
import CompactModal from "./CompactModal";

const SCROLL_TRIGGER_BUFFER_PX = 200;
const TTS_CONTROL_BOTTOM_SPACER_PX = 76;
const TTS_CHUNK_PANEL_EXTRA_SPACER_PX = 168;
const TTS_SWIPE_THRESHOLD_PX = 48;

interface ChatViewProps {
  session: ChatSession;
  messages: Message[];
  messagesLoading?: boolean;
  onMessageSent: (message: Message) => void;
  onMessageReceived: (message: Message) => void;
  onUpdateMessageId: (tempId: string, realId: string) => void;
  onUpdateSession: (id: string, updates: { title?: string; agent?: string }) => void;
  onToggleSidebar?: () => void;
  onEditMessage?: (messageId: string, content: string) => Promise<void>;
  onDeleteMessage?: (messageId: string) => void;
  onTruncateAfter?: (messageId: string) => void;
  onFork?: (messageId: string) => void;
  onStopGeneration?: () => void;
  onBeforeRegenerate?: (action: () => Promise<void>) => Promise<void>;
  hasInFlightStream?: boolean;
  actionLoading?: string | null;
}

export default function ChatView({
  session,
  messages,
  messagesLoading,
  onMessageSent,
  onMessageReceived,
  onUpdateMessageId,
  onUpdateSession,
  onToggleSidebar,
  onEditMessage,
  onDeleteMessage,
  onTruncateAfter,
  onFork,
  onStopGeneration,
  onBeforeRegenerate,
  hasInFlightStream = false,
  actionLoading,
}: ChatViewProps) {
  const [streamingContent, setStreamingContent] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [compactTarget, setCompactTarget] = useState<Message | null>(null);
  const streamingContentRef = useRef("");
  const pendingTempIdRef = useRef<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollDirection = useScrollDirection(scrollContainerRef);
  const hideHeader = scrollDirection === "down";
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [suppressMessageAutoScroll, setSuppressMessageAutoScroll] = useState(false);
  const [showChunkTextPanel, setShowChunkTextPanel] = useState(false);
  const chunkPanelTouchStartRef = useRef<{ x: number; y: number } | null>(null);

  // Initialize chunked TTS hook
  const {
    isLoading: ttsIsLoading,
    isPlaying: ttsIsPlaying,
    isPaused: ttsIsPaused,
    currentChunkIndex: ttsCurrentChunk,
    loadingChunkIndex: ttsLoadingChunkIndex,
    totalChunks: ttsTotalChunks,
    error: ttsError,
    activeMessageId: ttsActiveMessageId,
    chunks: ttsChunks,
    startPlayback,
    pause: ttsPause,
    resume: ttsResume,
    toggle: ttsToggle,
    nextChunk: ttsNextChunk,
    prevChunk: ttsPrevChunk,
    startFromWord,
    stop: ttsStop,
  } = useChunkedVastTTS();

  // Initialize word context menu
  const { menu: wordMenu, showMenu: showWordMenu, hideMenu: hideWordMenu } = useWordContextMenu();

  const isNearBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.clientHeight - el.scrollTop <= SCROLL_TRIGGER_BUFFER_PX;
  }, []);

  const getLastWords = (content: string, count: number) => {
    const words = content.trim().split(/\s+/).filter(Boolean);
    if (words.length <= count) return words.join(" ");
    return words.slice(-count).join(" ");
  };

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const handleScroll = () => {
      const distFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
      setShowScrollBtn(distFromBottom > SCROLL_TRIGGER_BUFFER_PX);
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  useEffect(() => {
    api.getAgents().then(setAgents).catch(console.error);
  }, []);

  const hasTtsOverlay = Boolean(ttsActiveMessageId || ttsIsLoading || ttsIsPlaying || ttsIsPaused || ttsError);
  const activeChunk = ttsChunks[ttsCurrentChunk] ?? null;
  const activeChunkText = activeChunk?.text ?? "No chunk text available.";
  const currentChunkNumber = ttsTotalChunks > 0 ? ttsCurrentChunk + 1 : 0;
  const isCurrentChunkLoading = ttsLoadingChunkIndex === ttsCurrentChunk;
  const ttsBottomSpacerHeight = hasTtsOverlay
    ? TTS_CONTROL_BOTTOM_SPACER_PX + (showChunkTextPanel ? TTS_CHUNK_PANEL_EXTRA_SPACER_PX : 0)
    : 0;

  useEffect(() => {
    if (!hasTtsOverlay || ttsTotalChunks === 0) {
      setShowChunkTextPanel(false);
    }
  }, [hasTtsOverlay, ttsTotalChunks]);

  const handleAgentChange = (newAgent: string) => {
    onUpdateSession(session.id, { agent: newAgent });
  };

  const [thinkingStatus, setThinkingStatus] = useState<string | null>(null);

  const { sendMessage, regenerate, compactMessage, stopGeneration, isStreaming, isCompacting } = useChat({
    sessionId: session.id,
    onUserMessageId: (realId) => {
      if (pendingTempIdRef.current) {
        onUpdateMessageId(pendingTempIdRef.current, realId);
        pendingTempIdRef.current = null;
      }
    },
    onThinking: (status) => {
      setThinkingStatus(status);
    },
    onMessage: (content) => {
      setThinkingStatus(null);
      streamingContentRef.current = content;
      setStreamingContent(content);
    },
    onDone: (messageId) => {
      setThinkingStatus(null);
      setSuppressMessageAutoScroll((prev) => prev || !isNearBottom());
      onMessageReceived({
        id: messageId,
        session_id: session.id,
        role: "assistant",
        content: streamingContentRef.current,
        created_at: Math.floor(Date.now() / 1000),
      });
      streamingContentRef.current = "";
      setStreamingContent("");
    },
    onTitleGenerated: (title) => {
      onUpdateSession(session.id, { title });
    },
    onError: (error) => {
      console.error("Chat error:", error);
      setThinkingStatus(null);
      streamingContentRef.current = "";
      setStreamingContent("");
    },
  });

  const handleRegenerate = async (messageId: string) => {
    // Remove messages after this one from UI
    const runRegeneration = async () => {
      onTruncateAfter?.(messageId);
      await regenerate(messageId);
    };

    if (onBeforeRegenerate) {
      await onBeforeRegenerate(runRegeneration);
      return;
    }

    await runRegeneration();
  };

  const handleSend = async (content: string) => {
    const tempId = `temp-${Date.now()}`;
    const userMessage: Message = {
      id: tempId,
      session_id: session.id,
      role: "user",
      content,
      created_at: Math.floor(Date.now() / 1000),
    };
    pendingTempIdRef.current = tempId;
    onMessageSent(userMessage);
    await sendMessage(content);
  };

  const handleContinue = async (assistantMessage: string) => {
    const snippet = getLastWords(assistantMessage, 20);
    await handleSend(`continue responding starting from ${snippet}`);
  };

  const handleOpenCompact = (messageId: string) => {
    const target = messages.find((message) => message.id === messageId);
    if (!target) return;

    setCompactTarget(target);
  };

  const handleToggleTTS = async (messageId: string, content: string) => {
    await ttsToggle(content, messageId);
  };

  const handleStartTTSFromWord = async (messageId: string, content: string, wordIndex: number) => {
    await startFromWord(content, messageId, wordIndex);
    hideWordMenu();
  };

  const handleCompactGenerate = async ({
    messageId,
    prompt,
    agentOrModel,
    onDelta,
  }: {
    messageId: string;
    prompt: string;
    agentOrModel: string;
    onDelta?: (content: string) => void;
  }): Promise<string> => {
    return compactMessage({
      messageId,
      prompt,
      agentOrModel,
      onMessage: onDelta,
    });
  };

  const handleCompactCommit = async (content: string) => {
    if (!compactTarget || !onEditMessage) return;
    await onEditMessage(compactTarget.id, content);
    closeCompact();
  };

  const closeCompact = () => {
    setCompactTarget(null);
  };

  const handleChunkPanelTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!touch) return;

    chunkPanelTouchStartRef.current = {
      x: touch.clientX,
      y: touch.clientY,
    };
  };

  const handleChunkPanelTouchEnd = (event: ReactTouchEvent<HTMLDivElement>) => {
    const start = chunkPanelTouchStartRef.current;
    const touch = event.changedTouches[0];
    chunkPanelTouchStartRef.current = null;

    if (!start || !touch) return;

    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;

    if (Math.abs(deltaX) < TTS_SWIPE_THRESHOLD_PX || Math.abs(deltaX) <= Math.abs(deltaY)) {
      return;
    }

    if (deltaX < 0 && ttsCurrentChunk < ttsTotalChunks - 1) {
      void ttsNextChunk();
      return;
    }

    if (deltaX > 0 && ttsCurrentChunk > 0) {
      void ttsPrevChunk();
    }
  };

  const hasMessages = messages.length > 0;
  const hasActiveStream = isStreaming || isCompacting || hasInFlightStream;

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      {/* Header wrapper - collapses on mobile scroll-down */}
      <div className={`overflow-hidden transition-all duration-300 ease-in-out flex-shrink-0 lg:!max-h-12 ${hideHeader ? "max-h-0" : "max-h-12"}`}>
        <div className="h-12 flex items-center px-3 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 gap-2">
          {onToggleSidebar && (
            <button
              onClick={onToggleSidebar}
              className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md text-gray-700 dark:text-gray-200"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          )}
          <h2 className="font-semibold text-sm truncate flex-1 min-w-0 text-gray-900 dark:text-white">{session.title}</h2>

          <div className="flex items-center gap-1 flex-shrink-0">
            {/* Scroll to bottom */}
            {showScrollBtn && (
              <button
                onClick={scrollToBottom}
                className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md text-gray-500 dark:text-gray-400"
                title="Scroll to bottom"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                </svg>
              </button>
            )}

            {/* Collapse/Expand All toggle */}
            {hasMessages && (
              <button
                onClick={() => {
                  if (collapsedIds.size > 0) {
                    // Expand all
                    setCollapsedIds(new Set());
                  } else {
                    // Collapse all current messages
                    setCollapsedIds(new Set(messages.map((m) => m.id)));
                  }
                }}
                className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md text-gray-500 dark:text-gray-400 text-xs flex items-center gap-1"
                title={collapsedIds.size > 0 ? "Expand all" : "Collapse all"}
              >
                {collapsedIds.size > 0 ? (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9V4.5M9 9H4.5M9 9l-5.5-5.5M15 9h4.5M15 9V4.5M15 9l5.5-5.5M9 15v4.5M9 15H4.5M9 15l-5.5 5.5M15 15h4.5M15 15v4.5m0-4.5l5.5 5.5" />
                  </svg>
                )}
              </button>
            )}

            <select
              value={session.agent}
              onChange={(e) => handleAgentChange(e.target.value)}
              disabled={hasActiveStream}
              className="text-sm px-2 py-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-gray-400 max-w-[120px] sm:max-w-none"
            >
              {agents.filter((a) => a.type === "agent").length > 0 && (
                <optgroup label="Custom Agents">
                  {agents.filter((a) => a.type === "agent").map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {agents.filter((a) => a.type === "model").length > 0 && (
                <optgroup label="Models">
                  {agents.filter((a) => a.type === "model").map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {agents.length === 0 && (
                <option value={session.agent}>{session.agent}</option>
              )}
            </select>

            {/* TTS Status moved to bottom overlay */}
          </div>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollContainerRef}
        data-chat-scroll-container
        className="flex-1 overflow-y-auto bg-gray-50 dark:bg-gray-950"
      >
        {messagesLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="flex flex-col items-center gap-2">
              <svg className="w-6 h-6 animate-spin text-gray-400" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <p className="text-xs text-gray-400">Loading messages...</p>
            </div>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto p-4">
            <MessageList
              messages={messages}
              streamingContent={streamingContent}
              thinkingStatus={thinkingStatus}
              onEditMessage={onEditMessage}
              onDeleteMessage={onDeleteMessage}
              onRegenerate={handleRegenerate}
              onFork={onFork}
              onContinue={handleContinue}
              onCompact={handleOpenCompact}
              onToggleTTS={handleToggleTTS}
              onWordClick={showWordMenu}
              actionLoading={actionLoading}
              collapsedIds={collapsedIds}
              suppressAutoScrollOnNextAppend={suppressMessageAutoScroll}
              onAutoScrollSuppressed={() => setSuppressMessageAutoScroll(false)}
              disableAutoScroll={hasActiveStream}
              isNearBottom={isNearBottom}
              disableQuickContinue={hasActiveStream}
              compactBusy={isCompacting}
              ttsActiveMessageId={ttsActiveMessageId}
              ttsChunks={ttsChunks}
              ttsCurrentChunk={ttsCurrentChunk}
              ttsIsPlaying={ttsIsPlaying}
              ttsIsLoading={ttsIsLoading}
              bottomSpacerHeight={ttsBottomSpacerHeight}
            />
          </div>
        )}
      </div>

      {compactTarget && (
        <CompactModal
          isOpen
          sourceMessage={compactTarget}
          sessionAgent={session.agent}
          agents={agents}
          isBusy={isCompacting}
          onClose={closeCompact}
          onGenerate={handleCompactGenerate}
          onCommit={handleCompactCommit}
          onStop={() => { void stopGeneration(); }}
        />
      )}

      {/* Input */}
      <div className="min-h-[3.5rem] flex items-end border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex-shrink-0 py-2 relative">
        {hasTtsOverlay && (
          <div className="absolute -top-12 left-0 right-0 flex justify-center pointer-events-none">
            <div className="relative bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-lg rounded-full px-3 py-1.5 flex items-center gap-2 pointer-events-auto transform transition-transform duration-200 hover:scale-105">
              {showChunkTextPanel && ttsTotalChunks > 0 && !ttsError && (
                <div
                  className="absolute bottom-full left-1/2 z-10 mb-2 w-[min(22rem,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl border border-gray-200 bg-white/95 px-3 py-2 shadow-xl backdrop-blur dark:border-gray-700 dark:bg-gray-900/95"
                  onTouchStart={handleChunkPanelTouchStart}
                  onTouchEnd={handleChunkPanelTouchEnd}
                  onTouchCancel={() => {
                    chunkPanelTouchStartRef.current = null;
                  }}
                >
                  <div className="mb-1 flex items-center justify-between gap-2 text-[11px] font-medium text-gray-500 dark:text-gray-400">
                    <span>Chunk {currentChunkNumber} of {ttsTotalChunks}</span>
                    {isCurrentChunkLoading ? (
                      <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                        <svg className="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        Loading audio
                      </span>
                    ) : (
                      <span>{activeChunk?.status === "error" ? "Failed" : activeChunk?.audio ? "Cached" : "Queued"}</span>
                    )}
                  </div>
                  <div className="max-h-32 overflow-y-auto text-sm leading-5 text-gray-700 dark:text-gray-200">
                    {activeChunkText}
                  </div>
                  {ttsTotalChunks > 1 && (
                    <div className="mt-2 text-[11px] text-gray-400 dark:text-gray-500">
                      Swipe left or right to skip chunks.
                    </div>
                  )}
                </div>
              )}
              {ttsError ? (
                <div className="flex items-center gap-2 text-xs font-medium text-red-600 dark:text-red-400">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" strokeWidth="2" /><path d="M12 8v4m0 4h.01" strokeWidth="2" strokeLinecap="round" /></svg>
                  <span>Error</span>
                  <button onClick={() => void ttsStop()} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full" title="Close">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
              ) : (
                <>
                  <button
                    onClick={() => void ttsPrevChunk()}
                    disabled={ttsCurrentChunk <= 0}
                    className="p-1.5 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full disabled:opacity-30 transition-colors"
                    title="Previous chunk"
                  >
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" /></svg>
                  </button>

                  <button
                    onClick={() => (ttsIsPlaying || ttsIsLoading) ? void ttsPause() : void ttsResume()}
                    className="p-1.5 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors"
                    title={(ttsIsPlaying || ttsIsLoading) ? "Pause" : "Resume"}
                  >
                    {(ttsIsPlaying || ttsIsLoading) ? (
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
                    ) : (
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                    )}
                  </button>

                  <div className="flex items-center gap-1 text-xs font-medium tabular-nums text-gray-600 dark:text-gray-300 min-w-[3.75rem] text-center select-none">
                    <span>{currentChunkNumber} / {ttsTotalChunks}</span>
                    {isCurrentChunkLoading && (
                      <svg className="w-3.5 h-3.5 animate-spin text-amber-500 dark:text-amber-400" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                    )}
                  </div>

                  {ttsTotalChunks > 0 && (
                    <button
                      onClick={() => setShowChunkTextPanel((prev) => !prev)}
                      className={`p-1.5 rounded-full transition-colors ${showChunkTextPanel ? "bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-white" : "text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"}`}
                      title={showChunkTextPanel ? "Hide current chunk text" : "Show current chunk text"}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h7m-7 4h10M5 5h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z" />
                      </svg>
                    </button>
                  )}

                  <button
                    onClick={() => void ttsNextChunk()}
                    disabled={ttsCurrentChunk >= ttsTotalChunks - 1}
                    className="p-1.5 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full disabled:opacity-30 transition-colors"
                    title="Next chunk"
                  >
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" /></svg>
                  </button>

                  <div className="w-px h-4 bg-gray-200 dark:bg-gray-700 mx-1" />

                  <button
                    onClick={() => void ttsStop()}
                    className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-full transition-colors"
                    title="Stop"
                  >
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h12v12H6z" /></svg>
                  </button>
                </>
              )}
            </div>
          </div>
        )}
        <div className="max-w-3xl mx-auto w-full px-4">
          {hasActiveStream ? (
            <button
              onClick={async () => {
                const stopRequest = onStopGeneration?.();
                stopGeneration();
                setStreamingContent("");
                setThinkingStatus(null);
                await stopRequest;
              }}
              className="w-full h-9 flex items-center justify-center gap-2 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors text-sm"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
              Stop generating
            </button>
          ) : (
            <MessageInput onSend={handleSend} disabled={hasActiveStream} />
          )}
        </div>
      </div>
    </div>
  );
}
