import { useState, useRef, useEffect, useCallback, type PointerEvent as ReactPointerEvent, type TouchEvent as ReactTouchEvent } from "react";
import { api } from "../lib/api";
import type { ChatSession, Message, Agent, TtsVoiceReference, TtsVoiceListResponse, TtsStatusResponse } from "../lib/api";
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
const TTS_VOICE_PANEL_EXTRA_SPACER_PX = 196;
const TTS_STATUS_PANEL_EXTRA_SPACER_PX = 212;
const TTS_SWIPE_THRESHOLD_PX = 48;
const TTS_PLAY_BUTTON_LONG_PRESS_MS = 450;

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
  const [showVoiceMenu, setShowVoiceMenu] = useState(false);
  const [showTtsStatusPanel, setShowTtsStatusPanel] = useState(false);
  const [showTtsSpeedModal, setShowTtsSpeedModal] = useState(false);
  const [ttsAutoScrollEnabled, setTtsAutoScrollEnabled] = useState(false);
  const [ttsVoices, setTtsVoices] = useState<TtsVoiceReference[]>([]);
  const [selectedTtsVoiceId, setSelectedTtsVoiceId] = useState<string | null>(null);
  const [ttsVoicesLoaded, setTtsVoicesLoaded] = useState(false);
  const [ttsVoiceLoading, setTtsVoiceLoading] = useState(false);
  const [ttsVoiceWarning, setTtsVoiceWarning] = useState<string | null>(null);
  const [ttsServiceStatus, setTtsServiceStatus] = useState<TtsStatusResponse | null>(null);
  const [ttsServiceStatusError, setTtsServiceStatusError] = useState<string | null>(null);
  const [ttsInstanceActionLoading, setTtsInstanceActionLoading] = useState(false);
  const [showTtsLogsModal, setShowTtsLogsModal] = useState(false);
  const [ttsLogsContent, setTtsLogsContent] = useState("");
  const [ttsLogsInstanceId, setTtsLogsInstanceId] = useState<string | null>(null);
  const [ttsLogsLoading, setTtsLogsLoading] = useState(false);
  const [ttsLogsError, setTtsLogsError] = useState<string | null>(null);
  const chunkPanelTouchStartRef = useRef<{ x: number; y: number } | null>(null);
  const playButtonLongPressTimerRef = useRef<number | null>(null);
  const suppressPlayButtonClickRef = useRef(false);
  const pendingCollapseSessionIdRef = useRef<string | null>(session.id);

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
    motionAutoStopEnabled: ttsMotionAutoStopEnabled,
    motionIdleRemainingMs: ttsMotionIdleRemainingMs,
    motionFadeActive: ttsMotionFadeActive,
    playbackSpeed: ttsPlaybackSpeed,
    setPlaybackSpeed: ttsSetPlaybackSpeed,
    startPlayback,
    pause: ttsPause,
    resume: ttsResume,
    toggle: ttsToggle,
    nextChunk: ttsNextChunk,
    prevChunk: ttsPrevChunk,
    seekToChunk: ttsSeekToChunk,
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

  const formatCountdown = (remainingMs: number) => {
    const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
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

  useEffect(() => {
    pendingCollapseSessionIdRef.current = session.id;
  }, [session.id]);

  useEffect(() => {
    if (pendingCollapseSessionIdRef.current !== session.id) return;
    if (messagesLoading) return;

    setCollapsedIds(new Set(messages.map((message) => message.id)));
    pendingCollapseSessionIdRef.current = null;
  }, [messages, messagesLoading, session.id]);

  const hasTtsOverlay = Boolean(ttsActiveMessageId || ttsIsLoading || ttsIsPlaying || ttsIsPaused || ttsError);
  const activeChunk = ttsChunks[ttsCurrentChunk] ?? null;
  const activeChunkText = activeChunk?.text ?? "No chunk text available.";
  const currentChunkNumber = ttsTotalChunks > 0 ? ttsCurrentChunk + 1 : 0;
  const isCurrentChunkLoading = ttsLoadingChunkIndex === ttsCurrentChunk;
  const selectedTtsVoice = ttsVoices.find((voice) => voice.id === selectedTtsVoiceId) || null;
  const ttsLifecycle = ttsServiceStatus?.lifecycle;
  const isTtsProvisioning = Boolean(ttsLifecycle?.provisioning);
  const ttsStatusSummary = ttsLifecycle?.message || (ttsServiceStatus?.active ? "GPU instance ready." : "No GPU instance is active.");
  const roundedHourlyRate = typeof ttsServiceStatus?.instance?.hourlyRate === "number"
    ? ttsServiceStatus.instance.hourlyRate.toFixed(3)
    : null;
  const formattedBalance = typeof ttsServiceStatus?.accountBalance === "number"
    ? `$${ttsServiceStatus.accountBalance.toFixed(2)}`
    : null;
  const ttsBottomSpacerHeight = hasTtsOverlay
    ? TTS_CONTROL_BOTTOM_SPACER_PX + Math.max(
      showChunkTextPanel ? TTS_CHUNK_PANEL_EXTRA_SPACER_PX : 0,
      showVoiceMenu ? TTS_VOICE_PANEL_EXTRA_SPACER_PX : 0,
      showTtsStatusPanel ? TTS_STATUS_PANEL_EXTRA_SPACER_PX : 0,
    )
    : 0;
  const motionAutoStopLabel = ttsMotionAutoStopEnabled && ttsMotionIdleRemainingMs !== null
    ? `${ttsMotionFadeActive ? "Fade" : "Stop"} ${formatCountdown(ttsMotionIdleRemainingMs)}`
    : null;

  useEffect(() => {
    if (!hasTtsOverlay || ttsTotalChunks === 0) {
      setShowChunkTextPanel(false);
      setShowVoiceMenu(false);
      setShowTtsStatusPanel(false);
      setShowTtsSpeedModal(false);
    }
  }, [hasTtsOverlay, ttsTotalChunks]);

  const handleAgentChange = (newAgent: string) => {
    onUpdateSession(session.id, { agent: newAgent });
  };

  const [thinkingStatus, setThinkingStatus] = useState<string | null>(null);

  const applyVoiceSelectionResponse = useCallback((response: TtsVoiceListResponse) => {
    setTtsVoices(response.voices || []);
    setSelectedTtsVoiceId(response.selectedVoiceId ?? null);
    setTtsVoicesLoaded(true);
    setTtsVoiceWarning(response.warning || null);
  }, []);

  const loadTtsVoices = useCallback(async () => {
    try {
      const response = await api.getTtsVoices();
      applyVoiceSelectionResponse(response);
      return response;
    } catch (error) {
      console.error("Failed to load TTS voices:", error);
      setTtsVoicesLoaded(true);
      setTtsVoiceWarning(error instanceof Error ? error.message : "Failed to load voices");
      return null;
    }
  }, [applyVoiceSelectionResponse]);

  const loadTtsServiceStatus = useCallback(async () => {
    try {
      const response = await api.getTtsStatus();
      setTtsServiceStatus(response);
      setTtsServiceStatusError(null);
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load TTS service status";
      setTtsServiceStatusError(message);
      return null;
    }
  }, []);

  useEffect(() => {
    void loadTtsVoices();
  }, [loadTtsVoices]);

  useEffect(() => {
    if (!hasTtsOverlay && !showTtsStatusPanel && !showTtsLogsModal) {
      return;
    }

    void loadTtsServiceStatus();

    const eventSource = api.streamTtsStatus(
      (status) => {
        setTtsServiceStatus(status);
        setTtsServiceStatusError(null);
      },
      () => {
        void loadTtsServiceStatus();
      },
    );

    return () => {
      eventSource.close();
    };
  }, [hasTtsOverlay, loadTtsServiceStatus, showTtsLogsModal, showTtsStatusPanel]);

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

  const resolvePlaybackVoiceId = async () => {
    if (ttsVoicesLoaded) {
      return selectedTtsVoiceId;
    }

    const response = await loadTtsVoices();
    return response?.selectedVoiceId ?? null;
  };

  const handleToggleTTS = async (messageId: string, content: string) => {
    const voiceId = await resolvePlaybackVoiceId();
    await ttsToggle(content, messageId, voiceId);
  };

  const handleStartTTSFromWord = async (messageId: string, content: string, wordIndex: number) => {
    const voiceId = await resolvePlaybackVoiceId();
    await startFromWord(content, messageId, wordIndex, voiceId);
    hideWordMenu();
  };

  const handlePlayTTSChunk = async (messageId: string, content: string, chunkIndex: number) => {
    if (ttsActiveMessageId === messageId) {
      await ttsSeekToChunk(chunkIndex);
      return;
    }

    const voiceId = await resolvePlaybackVoiceId();
    await startPlayback(content, messageId, chunkIndex, voiceId);
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
    if (!compactTarget) return;
    await handleEditMessage(compactTarget.id, content);
    closeCompact();
  };

  const closeCompact = () => {
    setCompactTarget(null);
  };

  const handleEditMessage = async (messageId: string, content: string) => {
    if (!onEditMessage) return;

    if (ttsActiveMessageId === messageId) {
      ttsStop();
    }

    await onEditMessage(messageId, content);
  };

  const handleSelectTtsVoice = async (voiceId: string | null) => {
    setTtsVoiceLoading(true);
    setTtsVoiceWarning(null);

    try {
      const response = voiceId ? await api.selectTtsVoice(voiceId) : await api.clearSelectedTtsVoice();
      applyVoiceSelectionResponse(response);
      setShowVoiceMenu(false);

      if (ttsActiveMessageId && (ttsIsPlaying || ttsIsLoading)) {
        const activeMessage = messages.find((message) => message.id === ttsActiveMessageId);
        if (activeMessage) {
          await startPlayback(activeMessage.content, activeMessage.id, ttsCurrentChunk, voiceId);
        }
      }
    } catch (error) {
      setTtsVoiceWarning(error instanceof Error ? error.message : "Failed to update TTS voice");
    } finally {
      setTtsVoiceLoading(false);
    }
  };

  const handleRestartTtsInstance = async () => {
    setTtsInstanceActionLoading(true);
    setTtsServiceStatusError(null);

    try {
      await api.restartTtsInstance();
      await loadTtsServiceStatus();
    } catch (error) {
      setTtsServiceStatusError(error instanceof Error ? error.message : "Failed to recreate the GPU instance");
    } finally {
      setTtsInstanceActionLoading(false);
    }
  };

  const handleDestroyTtsInstance = async () => {
    setTtsInstanceActionLoading(true);
    setTtsServiceStatusError(null);

    try {
      await api.stopTtsInstance();
      await loadTtsServiceStatus();
      setShowTtsStatusPanel(false);
    } catch (error) {
      setTtsServiceStatusError(error instanceof Error ? error.message : "Failed to destroy the GPU instance");
    } finally {
      setTtsInstanceActionLoading(false);
    }
  };

  const handleOpenTtsLogs = async () => {
    setShowTtsLogsModal(true);
    setTtsLogsLoading(true);
    setTtsLogsError(null);

    try {
      const response = await api.getTtsLogs();
      setTtsLogsContent(response.logs || "");
      setTtsLogsInstanceId(response.instanceId || null);
    } catch (error) {
      setTtsLogsContent("");
      setTtsLogsInstanceId(ttsServiceStatus?.instance?.id || ttsLifecycle?.instanceId || null);
      setTtsLogsError(error instanceof Error ? error.message : "Failed to load TTS instance logs");
    } finally {
      setTtsLogsLoading(false);
    }
  };

  const handleCloseTtsLogs = () => {
    setShowTtsLogsModal(false);
    setTtsLogsError(null);
  };

  const clearPlayButtonLongPress = () => {
    if (playButtonLongPressTimerRef.current !== null) {
      window.clearTimeout(playButtonLongPressTimerRef.current);
      playButtonLongPressTimerRef.current = null;
    }
  };

  const handlePlayButtonPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;

    clearPlayButtonLongPress();
    playButtonLongPressTimerRef.current = window.setTimeout(() => {
      suppressPlayButtonClickRef.current = true;
      setShowTtsSpeedModal(true);
    }, TTS_PLAY_BUTTON_LONG_PRESS_MS);
  };

  const handlePlayButtonPointerUp = () => {
    clearPlayButtonLongPress();
  };

  const handlePlayButtonClick = async () => {
    if (suppressPlayButtonClickRef.current) {
      suppressPlayButtonClickRef.current = false;
      return;
    }

    if (ttsIsPlaying || ttsIsLoading) {
      await ttsPause();
      return;
    }

    await ttsResume();
  };

  useEffect(() => () => {
    clearPlayButtonLongPress();
  }, []);

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
    <div className="relative flex flex-col h-full bg-white dark:bg-gray-900">
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

      {motionAutoStopLabel && (
        <div
          className={`pointer-events-none absolute left-1/2 z-20 -translate-x-1/2 transition-all duration-300 ease-in-out ${hideHeader ? "top-2" : "top-14"}`}
        >
          <div
            className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-medium tabular-nums shadow-sm backdrop-blur sm:text-[11px] ${ttsMotionFadeActive ? "border-amber-200 bg-amber-50/95 text-amber-700 dark:border-amber-800 dark:bg-amber-950/85 dark:text-amber-300" : "border-sky-200 bg-sky-50/95 text-sky-700 dark:border-sky-800 dark:bg-sky-950/85 dark:text-sky-300"}`}
            title="Countdown until playback fades out and stops if the phone stays still"
          >
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l2.5 2.5M9 3h6M12 5a8 8 0 100 16 8 8 0 000-16z" />
            </svg>
            <span>{motionAutoStopLabel}</span>
          </div>
        </div>
      )}

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
              onEditMessage={handleEditMessage}
              onDeleteMessage={onDeleteMessage}
              onRegenerate={handleRegenerate}
              onFork={onFork}
              onContinue={handleContinue}
              onCompact={handleOpenCompact}
              onToggleTTS={handleToggleTTS}
              onPlayTTSChunk={handlePlayTTSChunk}
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
              ttsAutoScrollEnabled={ttsAutoScrollEnabled}
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

      {showTtsLogsModal && (
        <div className="fixed inset-0 z-50 bg-black/55 dark:bg-black/70 flex flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-gray-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-gray-800 dark:bg-gray-950/95">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Vast.ai TTS Logs</h2>
              <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                {ttsLogsInstanceId ? `Instance ${ttsLogsInstanceId}` : "Current tracked instance"}
              </p>
            </div>
            <button
              onClick={handleCloseTtsLogs}
              className="rounded-md px-2 py-1 text-sm text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white"
              title="Close logs"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="flex-1 overflow-hidden bg-white dark:bg-gray-950">
            {ttsLogsLoading ? (
              <div className="flex h-full items-center justify-center">
                <div className="flex flex-col items-center gap-3 text-gray-500 dark:text-gray-400">
                  <svg className="h-6 w-6 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  <p className="text-sm">Loading logs...</p>
                </div>
              </div>
            ) : ttsLogsError ? (
              <div className="flex h-full items-center justify-center px-4">
                <div className="max-w-lg rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
                  {ttsLogsError}
                </div>
              </div>
            ) : (
              <div className="h-full overflow-auto p-4 sm:p-6">
                <pre className="min-h-full whitespace-pre-wrap break-words rounded-xl border border-gray-200 bg-gray-50 p-4 text-xs leading-5 text-gray-800 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-100">
                  {ttsLogsContent || "No logs returned."}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}

      {showTtsSpeedModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4 dark:bg-black/65">
          <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-4 shadow-2xl dark:border-gray-700 dark:bg-gray-900">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Playback Speed</h2>
                <p className="text-xs text-gray-500 dark:text-gray-400">Adjust TTS speed from 0.5x to 3x.</p>
              </div>
              <button
                onClick={() => setShowTtsSpeedModal(false)}
                className="rounded-md p-1 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
                title="Close speed controls"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="mt-5">
              <div className="mb-2 flex items-center justify-between text-xs font-medium text-gray-500 dark:text-gray-400">
                <span>0.5x</span>
                <span className="rounded-full bg-gray-100 px-2 py-1 text-gray-900 dark:bg-gray-800 dark:text-white">
                  {ttsPlaybackSpeed.toFixed(2).replace(/\.00$/, "") }x
                </span>
                <span>3x</span>
              </div>
              <input
                type="range"
                min="0.5"
                max="3"
                step="0.05"
                value={ttsPlaybackSpeed}
                onChange={(event) => {
                  void ttsSetPlaybackSpeed(Number(event.target.value));
                }}
                className="w-full accent-gray-900 dark:accent-gray-200"
              />
            </div>

            <div className="mt-4 flex justify-end">
              <button
                onClick={() => setShowTtsSpeedModal(false)}
                className="rounded-lg bg-gray-900 px-3 py-1.5 text-sm text-white transition-colors hover:bg-gray-800 dark:bg-gray-700 dark:hover:bg-gray-600"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Input */}
      <div className="min-h-[3.5rem] flex items-end border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex-shrink-0 py-2 relative">
        {hasTtsOverlay && (
          <div className="absolute -top-12 left-0 right-0 flex justify-center pointer-events-none">
            <div className="relative max-w-[calc(100vw-1rem)] overflow-visible bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-lg rounded-full px-2 py-1 flex items-center gap-1 sm:px-3 sm:py-1.5 sm:gap-2 pointer-events-auto transform transition-transform duration-200 hover:scale-105">
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
              {showVoiceMenu && !ttsError && (
                <div className="absolute bottom-full left-1/2 z-10 mb-2 w-[min(20rem,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl border border-gray-200 bg-white/95 px-3 py-2 shadow-xl backdrop-blur dark:border-gray-700 dark:bg-gray-900/95">
                  <div className="mb-2 flex items-center justify-between gap-2 text-[11px] font-medium text-gray-500 dark:text-gray-400">
                    <span>{selectedTtsVoice ? `Voice: ${selectedTtsVoice.label}` : "Voice: No reference"}</span>
                    {ttsVoiceLoading && (
                      <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                        <svg className="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        Applying
                      </span>
                    )}
                  </div>

                  <div className="space-y-1">
                    <button
                      onClick={() => void handleSelectTtsVoice(null)}
                      disabled={ttsVoiceLoading}
                      className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm transition-colors ${selectedTtsVoiceId === null ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300" : "text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"}`}
                    >
                      <span>No reference</span>
                      {selectedTtsVoiceId === null && (
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>

                    {ttsVoices.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-gray-200 px-3 py-3 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
                        No saved voice references yet. Add them in Settings.
                      </div>
                    ) : (
                      <div className="max-h-44 overflow-y-auto space-y-1">
                        {ttsVoices.map((voice) => {
                          const isSelected = selectedTtsVoiceId === voice.id;

                          return (
                            <button
                              key={voice.id}
                              onClick={() => void handleSelectTtsVoice(voice.id)}
                              disabled={ttsVoiceLoading}
                              className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm transition-colors ${isSelected ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300" : "text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"}`}
                            >
                              <span className="truncate">{voice.label}</span>
                              {isSelected && (
                                <svg className="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {ttsVoiceWarning && (
                    <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
                      {ttsVoiceWarning}
                    </div>
                  )}
                </div>
              )}
              {showTtsStatusPanel && !ttsError && (
                <div className="absolute bottom-full left-1/2 z-10 mb-2 w-[min(22rem,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl border border-gray-200 bg-white/95 px-3 py-2 shadow-xl backdrop-blur dark:border-gray-700 dark:bg-gray-900/95">
                  <div className="mb-2 flex items-center justify-between gap-3 text-[11px] font-medium text-gray-500 dark:text-gray-400">
                    <span>Vast.ai TTS Service</span>
                    <span className={`inline-flex h-2.5 w-2.5 rounded-full ${isTtsProvisioning ? "bg-amber-500" : ttsServiceStatus?.active ? "bg-emerald-500" : "bg-gray-400"}`} />
                  </div>

                  <div className="space-y-2 text-sm text-gray-700 dark:text-gray-200">
                    <div className="text-xs text-gray-600 dark:text-gray-300">
                      {ttsStatusSummary}
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-[12px]">
                      <div className="rounded-xl border border-gray-200 px-3 py-2 dark:border-gray-700">
                        <div className="text-gray-500 dark:text-gray-400">Instance</div>
                        <div className="mt-1 font-medium text-gray-900 dark:text-white">{ttsServiceStatus?.instance?.id || ttsLifecycle?.instanceId || "Not ready yet"}</div>
                      </div>
                      <div className="rounded-xl border border-gray-200 px-3 py-2 dark:border-gray-700">
                        <div className="text-gray-500 dark:text-gray-400">Health</div>
                        <div className="mt-1 font-medium text-gray-900 dark:text-white">
                          {ttsServiceStatus?.healthy === undefined ? "Pending" : ttsServiceStatus.healthy ? "Healthy" : "Unhealthy"}
                        </div>
                      </div>
                      <div className="rounded-xl border border-gray-200 px-3 py-2 dark:border-gray-700">
                        <div className="text-gray-500 dark:text-gray-400">GPU</div>
                        <div className="mt-1 font-medium text-gray-900 dark:text-white">{ttsServiceStatus?.instance?.gpuName || "Allocating"}</div>
                      </div>
                      <div className="rounded-xl border border-gray-200 px-3 py-2 dark:border-gray-700">
                        <div className="text-gray-500 dark:text-gray-400">Rate</div>
                        <div className="mt-1 font-medium text-gray-900 dark:text-white">
                          {roundedHourlyRate ? `$${roundedHourlyRate}/hr` : "-"}
                        </div>
                      </div>
                      <div className="rounded-xl border border-gray-200 px-3 py-2 dark:border-gray-700">
                        <div className="text-gray-500 dark:text-gray-400">Balance</div>
                        <div className="mt-1 font-medium text-gray-900 dark:text-white">
                          {formattedBalance || "-"}
                        </div>
                      </div>
                      <div className="rounded-xl border border-gray-200 px-3 py-2 dark:border-gray-700">
                        <div className="text-gray-500 dark:text-gray-400">Machine</div>
                        <div className="mt-1 font-medium text-gray-900 dark:text-white">
                          {ttsServiceStatus?.instance?.machineId || "-"}
                        </div>
                      </div>
                    </div>

                    {(ttsServiceStatusError || ttsLifecycle?.lastError) && (
                      <div className="text-[11px] text-amber-600 dark:text-amber-400">
                        {ttsServiceStatusError || ttsLifecycle?.lastError}
                      </div>
                    )}

                    <div className="flex justify-end gap-2 pt-1">
                      <button
                        onClick={() => void handleOpenTtsLogs()}
                        disabled={ttsLogsLoading || (!ttsServiceStatus?.instance?.id && !ttsLifecycle?.instanceId)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                        title="View instance logs"
                      >
                        {ttsLogsLoading && (
                          <svg className="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                          </svg>
                        )}
                        {!ttsLogsLoading && (
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6M7 4h7l5 5v11a2 2 0 01-2 2H7a2 2 0 01-2-2V6a2 2 0 012-2z" />
                          </svg>
                        )}
                      </button>
                      <button
                        onClick={() => void handleRestartTtsInstance()}
                        disabled={ttsInstanceActionLoading}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-gray-900 text-white transition-colors hover:bg-gray-800 disabled:opacity-50 dark:bg-gray-700 dark:hover:bg-gray-600"
                        title="Recreate instance"
                      >
                        {ttsInstanceActionLoading && (
                          <svg className="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                          </svg>
                        )}
                        {!ttsInstanceActionLoading && (
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m14.836 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0H15m4.419 0A8.003 8.003 0 016.582 15" />
                          </svg>
                        )}
                      </button>
                      <button
                        onClick={() => void handleDestroyTtsInstance()}
                        disabled={ttsInstanceActionLoading}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-red-200 text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-900/40 dark:text-red-400 dark:hover:bg-red-950/30"
                        title="Destroy instance"
                      >
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 7h12m-9 0V5a1 1 0 011-1h4a1 1 0 011 1v2m-7 0l1 12h6l1-12M10 11v6m4-6v6" />
                        </svg>
                      </button>
                    </div>
                  </div>
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
                    className="p-1 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full disabled:opacity-30 transition-colors sm:p-1.5"
                    title="Previous chunk"
                  >
                    <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" /></svg>
                  </button>

                  <button
                    onClick={() => void handlePlayButtonClick()}
                    onPointerDown={handlePlayButtonPointerDown}
                    onPointerUp={handlePlayButtonPointerUp}
                    onPointerLeave={handlePlayButtonPointerUp}
                    onPointerCancel={handlePlayButtonPointerUp}
                    onContextMenu={(event) => event.preventDefault()}
                    className="p-1 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors sm:p-1.5"
                    title={`${(ttsIsPlaying || ttsIsLoading) ? "Pause" : "Resume"} (long press for speed)`}
                  >
                    {(ttsIsPlaying || ttsIsLoading) ? (
                      <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
                    ) : (
                      <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                    )}
                  </button>

                  <div className="flex items-center gap-1 text-[11px] sm:text-xs font-medium tabular-nums text-gray-600 dark:text-gray-300 min-w-[3rem] sm:min-w-[3.75rem] text-center select-none">
                    <span>{currentChunkNumber} / {ttsTotalChunks}</span>
                    {isCurrentChunkLoading && (
                      <svg className="w-3 h-3 sm:w-3.5 sm:h-3.5 animate-spin text-amber-500 dark:text-amber-400" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                    )}
                  </div>

                  {(isTtsProvisioning || !!ttsServiceStatus?.instance || !!ttsServiceStatusError) && (
                    <button
                      onClick={() => {
                        setShowChunkTextPanel(false);
                        setShowVoiceMenu(false);
                        setShowTtsStatusPanel((prev) => !prev);
                      }}
                      className={`inline-flex items-center justify-center rounded-full p-1 transition-colors sm:p-1.5 ${showTtsStatusPanel ? "bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-white" : isTtsProvisioning ? "bg-amber-50 text-amber-700 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-300" : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"}`}
                      title={ttsStatusSummary}
                    >
                      {isTtsProvisioning && (
                        <svg className="h-3 w-3 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                      )}
                      {!isTtsProvisioning && (
                        <svg className="h-3.5 w-3.5 sm:h-4 sm:w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L6 20.75V17H3.25v-5.5H6V7.75L9.75 11.5m4.5 5.5L18 20.75V17h2.75v-5.5H18V7.75L14.25 11.5" />
                        </svg>
                      )}
                    </button>
                  )}

                  {ttsTotalChunks > 0 && (
                    <button
                      onClick={() => {
                        setShowTtsStatusPanel(false);
                        setShowVoiceMenu(false);
                        setShowChunkTextPanel((prev) => !prev);
                      }}
                      className={`p-1 rounded-full transition-colors sm:p-1.5 ${showChunkTextPanel ? "bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-white" : "text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"}`}
                      title={showChunkTextPanel ? "Hide current chunk text" : "Show current chunk text"}
                    >
                      <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h7m-7 4h10M5 5h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z" />
                      </svg>
                    </button>
                  )}

                  <button
                    onClick={() => {
                      if (!showVoiceMenu) {
                        void loadTtsVoices();
                      }
                      setShowChunkTextPanel(false);
                      setShowTtsStatusPanel(false);
                      setShowVoiceMenu((prev) => !prev);
                    }}
                    className={`p-1 rounded-full transition-colors sm:p-1.5 ${showVoiceMenu ? "bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-white" : "text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"}`}
                    title={showVoiceMenu ? "Hide voice selector" : "Choose TTS voice"}
                  >
                    <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5h2M12 3v2m6.364 1.636l-1.414 1.414M20 12h-2M6 12H4m2.05-5.364l1.414 1.414M12 19v2m6-9a6 6 0 11-12 0 6 6 0 0112 0zm-6 3a3 3 0 100-6 3 3 0 000 6z" />
                    </svg>
                  </button>

                  {ttsTotalChunks > 0 && (
                    <button
                      onClick={() => setTtsAutoScrollEnabled((prev) => !prev)}
                      className={`p-1 rounded-full transition-colors sm:p-1.5 ${ttsAutoScrollEnabled ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" : "text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"}`}
                      title={ttsAutoScrollEnabled ? "Disable chunk auto-scroll" : "Enable chunk auto-scroll"}
                    >
                      <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14m0 0l-4-4m4 4l4-4M5 12h14" />
                      </svg>
                    </button>
                  )}

                  <button
                    onClick={() => void ttsNextChunk()}
                    disabled={ttsCurrentChunk >= ttsTotalChunks - 1}
                    className="p-1 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full disabled:opacity-30 transition-colors sm:p-1.5"
                    title="Next chunk"
                  >
                    <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" /></svg>
                  </button>

                  <div className="w-px h-4 bg-gray-200 dark:bg-gray-700 mx-0.5 sm:mx-1" />

                  <button
                    onClick={() => void ttsStop()}
                    className="p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-full transition-colors sm:p-1.5"
                    title="Stop"
                  >
                    <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h12v12H6z" /></svg>
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
