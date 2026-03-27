import { useState, useRef, useEffect, useCallback, useMemo, type PointerEvent as ReactPointerEvent, type TouchEvent as ReactTouchEvent } from "react";
import { api } from "../lib/api";
import type { ChatSession, Message, Agent, SessionTtsSpeakerMapping, TtsVoiceReference, TtsVoiceListResponse, TtsStatusResponse } from "../lib/api";
import { useChat } from "../hooks/useChat";
import { useChunkedVastTTS } from "../hooks/useChunkedVastTTS";
import { useWordContextMenu } from "../hooks/useWordContextMenu";
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
const STREAMING_TTS_PLACEHOLDER_ID = "streaming";
const PULL_TO_REFRESH_TRIGGER_PX = 72;
const MAX_PULL_TO_REFRESH_PX = 96;

interface ChatViewProps {
  session: ChatSession;
  messages: Message[];
  messagesLoading?: boolean;
  onMessageSent: (message: Message) => void;
  onMessageReceived: (message: Message) => void;
  onUpdateMessageId: (tempId: string, realId: string) => void;
  onUpdateSession: (id: string, updates: { title?: string; agent?: string; lastTtsMessageId?: string | null }) => void;
  onToggleSidebar?: () => void;
  onEditMessage?: (messageId: string, content: string) => Promise<void>;
  onDeleteMessage?: (messageId: string) => void;
  onTruncateAfter?: (messageId: string) => void;
  onFork?: (messageId: string) => void;
  onStopGeneration?: () => void;
  onBeforeRegenerate?: (action: () => Promise<void>) => Promise<void>;
  onRefreshMessages?: () => Promise<void>;
  hasInFlightStream?: boolean;
  messagesRefreshing?: boolean;
  actionLoading?: string | null;
}

function sortSessionTtsSpeakers(speakers: SessionTtsSpeakerMapping[]): SessionTtsSpeakerMapping[] {
  return [...speakers].sort((left, right) => {
    if (left.hidden !== right.hidden) {
      return Number(left.hidden) - Number(right.hidden);
    }
    if (left.speakerKey === "narrator" && right.speakerKey !== "narrator") {
      return -1;
    }
    if (left.speakerKey !== "narrator" && right.speakerKey === "narrator") {
      return 1;
    }
    return left.speakerLabel.localeCompare(right.speakerLabel, undefined, { sensitivity: "base" });
  });
}

function mergeSessionTtsSpeaker(
  speakers: SessionTtsSpeakerMapping[],
  updatedSpeaker: SessionTtsSpeakerMapping,
): SessionTtsSpeakerMapping[] {
  const existingIndex = speakers.findIndex((speaker) => speaker.speakerKey === updatedSpeaker.speakerKey);
  if (existingIndex === -1) {
    return sortSessionTtsSpeakers([...speakers, updatedSpeaker]);
  }

  return sortSessionTtsSpeakers(
    speakers.map((speaker) => speaker.speakerKey === updatedSpeaker.speakerKey ? updatedSpeaker : speaker),
  );
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
  onRefreshMessages,
  hasInFlightStream = false,
  messagesRefreshing = false,
  actionLoading,
}: ChatViewProps) {
  const [streamingAssistantMessageId, setStreamingAssistantMessageId] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [compactTarget, setCompactTarget] = useState<Message | null>(null);
  const streamingContentRef = useRef("");
  const pendingTempIdRef = useRef<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const hideHeader = false;
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const showScrollBtnRef = useRef(false);
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
  const [sessionTtsSpeakers, setSessionTtsSpeakers] = useState<SessionTtsSpeakerMapping[]>([]);
  const [sessionTtsSpeakerLoading, setSessionTtsSpeakerLoading] = useState(false);
  const [sessionTtsSpeakerError, setSessionTtsSpeakerError] = useState<string | null>(null);
  const [sessionTtsSpeakerActionKey, setSessionTtsSpeakerActionKey] = useState<string | null>(null);
  const [showHiddenSpeakers, setShowHiddenSpeakers] = useState(false);
  const [ttsServiceStatus, setTtsServiceStatus] = useState<TtsStatusResponse | null>(null);
  const [ttsServiceStatusError, setTtsServiceStatusError] = useState<string | null>(null);
  const [ttsInstanceActionLoading, setTtsInstanceActionLoading] = useState(false);
  const [showTtsLogsModal, setShowTtsLogsModal] = useState(false);
  const [ttsLogsContent, setTtsLogsContent] = useState("");
  const activeStreamingTtsMessageId = streamingAssistantMessageId ?? STREAMING_TTS_PLACEHOLDER_ID;
  const [ttsLogsInstanceId, setTtsLogsInstanceId] = useState<string | null>(null);
  const [ttsLogsLoading, setTtsLogsLoading] = useState(false);
  const [ttsLogsError, setTtsLogsError] = useState<string | null>(null);
  const [previewVoiceId, setPreviewVoiceId] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewVoiceIdRef = useRef<string | null>(null);
  const chunkPanelTouchStartRef = useRef<{ x: number; y: number } | null>(null);
  const playButtonLongPressTimerRef = useRef<number | null>(null);
  const suppressPlayButtonClickRef = useRef(false);
  const pendingCollapseSessionIdRef = useRef<string | null>(session.id);
  const pullRefreshStartYRef = useRef<number | null>(null);
  const pullRefreshTrackingRef = useRef(false);
  const [pullRefreshDistance, setPullRefreshDistance] = useState(0);
  const pullRefreshDistanceRef = useRef(0);
  const pullRefreshAnimationFrameRef = useRef<number | null>(null);

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
    setSpeakerContext,
    setPlaybackSpeed: ttsSetPlaybackSpeed,
    startPlayback,
    syncStreamingPlayback,
    pause: ttsPause,
    resume: ttsResume,
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

  const schedulePullRefreshDistance = useCallback((nextDistance: number) => {
    const clampedDistance = Math.max(0, Math.min(MAX_PULL_TO_REFRESH_PX, nextDistance));
    if (pullRefreshDistanceRef.current === clampedDistance) {
      return;
    }

    pullRefreshDistanceRef.current = clampedDistance;
    if (typeof window === "undefined") {
      setPullRefreshDistance((current) => current === clampedDistance ? current : clampedDistance);
      return;
    }

    if (pullRefreshAnimationFrameRef.current !== null) {
      return;
    }

    pullRefreshAnimationFrameRef.current = window.requestAnimationFrame(() => {
      pullRefreshAnimationFrameRef.current = null;
      const distance = pullRefreshDistanceRef.current;
      setPullRefreshDistance((current) => current === distance ? current : distance);
    });
  }, []);

  useEffect(() => () => {
    if (pullRefreshAnimationFrameRef.current !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(pullRefreshAnimationFrameRef.current);
      pullRefreshAnimationFrameRef.current = null;
    }
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
      const nextShowScrollBtn = distFromBottom > SCROLL_TRIGGER_BUFFER_PX;
      if (showScrollBtnRef.current === nextShowScrollBtn) {
        return;
      }

      showScrollBtnRef.current = nextShowScrollBtn;
      setShowScrollBtn(nextShowScrollBtn);
    };
    handleScroll();
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [messages.length, messagesLoading]);

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
  const activeChunkText = activeChunk?.displayText ?? "No chunk text available.";
  const currentChunkNumber = ttsTotalChunks > 0 ? ttsCurrentChunk + 1 : 0;
  const isCurrentChunkLoading = ttsLoadingChunkIndex === ttsCurrentChunk;
  const voiceById = useMemo(
    () => new Map(ttsVoices.map((voice) => [voice.id, voice])),
    [ttsVoices],
  );
  const selectedTtsVoice = useMemo(
    () => selectedTtsVoiceId ? voiceById.get(selectedTtsVoiceId) || null : null,
    [selectedTtsVoiceId, voiceById],
  );
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
  const showPullRefreshIndicator = pullRefreshDistance > 0 || messagesRefreshing;
  const pullRefreshProgress = Math.min(1, pullRefreshDistance / PULL_TO_REFRESH_TRIGGER_PX);
  const customAgents = useMemo(
    () => agents.filter((agent) => agent.type === "agent"),
    [agents],
  );
  const modelAgents = useMemo(
    () => agents.filter((agent) => agent.type === "model"),
    [agents],
  );

  useEffect(() => {
    if (!hasTtsOverlay || ttsTotalChunks === 0) {
      setShowChunkTextPanel(false);
      setShowVoiceMenu(false);
      setShowTtsStatusPanel(false);
      setShowTtsSpeedModal(false);
    }
  }, [hasTtsOverlay, ttsTotalChunks]);

  useEffect(() => {
    if (!messagesRefreshing) {
      schedulePullRefreshDistance(0);
    }
  }, [messagesRefreshing, schedulePullRefreshDistance]);

  const handleAgentChange = (newAgent: string) => {
    onUpdateSession(session.id, { agent: newAgent });
  };

  const persistLastPlayedMessage = useCallback((messageId: string | null) => {
    if (session.last_tts_message_id === messageId) {
      return;
    }

    onUpdateSession(session.id, { lastTtsMessageId: messageId });
  }, [onUpdateSession, session.id, session.last_tts_message_id]);

  const applyVoiceSelectionResponse = useCallback((response: TtsVoiceListResponse) => {
    setTtsVoices(response.voices || []);
    setSelectedTtsVoiceId(response.selectedVoiceId ?? null);
    setTtsVoicesLoaded(true);
    setTtsVoiceWarning(response.warning || null);
  }, []);

  const loadSessionTtsSpeakers = useCallback(async () => {
    setSessionTtsSpeakerLoading(true);
    setSessionTtsSpeakerError(null);
    try {
      const response = await api.getSessionTtsSpeakers(session.id);
      setSessionTtsSpeakers(sortSessionTtsSpeakers(response.speakers || []));
    } catch (error) {
      setSessionTtsSpeakerError(error instanceof Error ? error.message : "Failed to load session speakers");
    } finally {
      setSessionTtsSpeakerLoading(false);
    }
  }, [session.id]);

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

  useEffect(() => {
    setSpeakerContext({
      sessionId: session.id,
      defaultVoiceReferenceId: selectedTtsVoiceId,
      speakerMappings: sessionTtsSpeakers,
    });
  }, [selectedTtsVoiceId, session.id, sessionTtsSpeakers, setSpeakerContext]);

  const stopVoicePreview = useCallback(() => {
    const previewAudio = previewAudioRef.current;
    if (!previewAudio) {
      previewVoiceIdRef.current = null;
      setPreviewVoiceId(null);
      return;
    }

    previewAudio.pause();
    previewAudio.currentTime = 0;
    previewAudio.onended = null;
    previewAudio.onerror = null;
    previewAudioRef.current = null;
    previewVoiceIdRef.current = null;
    setPreviewVoiceId(null);
  }, []);

  useEffect(() => {
    return () => {
      stopVoicePreview();
    };
  }, [stopVoicePreview]);

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

  const {
    sendMessage,
    regenerate,
    compactMessage,
    stopGeneration,
    isStreaming,
    isCompacting,
    thinkingStatus,
    streamedContent: streamingContent,
  } = useChat({
    sessionId: session.id,
    onUserMessageId: (realId) => {
      if (pendingTempIdRef.current) {
        onUpdateMessageId(pendingTempIdRef.current, realId);
        pendingTempIdRef.current = null;
      }
    },
    onAssistantMessageId: (messageId) => {
      setStreamingAssistantMessageId(messageId);
    },
    onMessage: (content) => {
      streamingContentRef.current = content;
    },
    onDone: (messageId) => {
      const finalContent = streamingContentRef.current;
      setSuppressMessageAutoScroll((prev) => prev || !isNearBottom());
      onMessageReceived({
        id: messageId,
        session_id: session.id,
        role: "assistant",
        content: finalContent,
        created_at: Math.floor(Date.now() / 1000),
      });
      void syncActiveStreamingTtsToFinalMessage(messageId, finalContent);
      setStreamingAssistantMessageId(null);
      streamingContentRef.current = "";
    },
    onTitleGenerated: (title) => {
      onUpdateSession(session.id, { title });
    },
    onError: (error) => {
      console.error("Chat error:", error);
      setStreamingAssistantMessageId(null);
      streamingContentRef.current = "";
    },
  });

  const handleRegenerate = async (messageId: string) => {
    // Remove messages after this one from UI
    const runRegeneration = async () => {
      streamingContentRef.current = "";
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
    streamingContentRef.current = "";
    setStreamingAssistantMessageId(null);
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

  const syncActiveStreamingTtsToFinalMessage = async (messageId: string, content: string) => {
    if (ttsActiveMessageId !== STREAMING_TTS_PLACEHOLDER_ID || (!ttsIsPlaying && !ttsIsLoading) || !content.trim()) {
      return;
    }

    const voiceId = await resolvePlaybackVoiceId();
    await startPlayback(content, messageId, Math.max(0, ttsCurrentChunk), voiceId);
    persistLastPlayedMessage(messageId);
  };

  useEffect(() => {
    if (ttsActiveMessageId !== activeStreamingTtsMessageId || !streamingContent.trim()) {
      return;
    }

    void syncStreamingPlayback(streamingContent, activeStreamingTtsMessageId, selectedTtsVoiceId);
  }, [activeStreamingTtsMessageId, selectedTtsVoiceId, streamingContent, syncStreamingPlayback, ttsActiveMessageId]);

  const handleToggleTTS = async (messageId: string, content: string) => {
    stopVoicePreview();
    if (messageId === activeStreamingTtsMessageId && !!streamingContent.trim()) {
      const voiceId = await resolvePlaybackVoiceId();

      if (ttsActiveMessageId === messageId && (ttsIsPlaying || ttsIsLoading)) {
        ttsPause();
        return;
      }

      if (ttsActiveMessageId === messageId && ttsIsPaused) {
        setTtsAutoScrollEnabled(true);
        await ttsResume();
        return;
      }

      setTtsAutoScrollEnabled(true);
      await startPlayback(content, messageId, ttsActiveMessageId === messageId ? Math.max(0, ttsCurrentChunk) : 0, voiceId, { streaming: true });
      if (messageId !== STREAMING_TTS_PLACEHOLDER_ID) {
        persistLastPlayedMessage(messageId);
      }
      return;
    }

    if (ttsActiveMessageId === messageId && ttsIsPlaying) {
      ttsPause();
      return;
    }

    const voiceId = await resolvePlaybackVoiceId();
    setTtsAutoScrollEnabled(true);
    if (ttsActiveMessageId === messageId && ttsIsPaused) {
      await ttsResume();
    } else {
      await startPlayback(content, messageId, -1, voiceId);
    }
    persistLastPlayedMessage(messageId);
  };

  const handleStartTTSFromWord = async (messageId: string, content: string, wordIndex: number) => {
    stopVoicePreview();
    const voiceId = await resolvePlaybackVoiceId();
    setTtsAutoScrollEnabled(true);
    await startFromWord(content, messageId, wordIndex, voiceId);
    persistLastPlayedMessage(messageId);
    hideWordMenu();
  };

  const handlePlayTTSChunk = async (messageId: string, content: string, chunkIndex: number) => {
    stopVoicePreview();
    setTtsAutoScrollEnabled(true);
    if (ttsActiveMessageId === messageId) {
      await ttsSeekToChunk(chunkIndex);
      persistLastPlayedMessage(messageId);
      return;
    }

    const voiceId = await resolvePlaybackVoiceId();
    await startPlayback(content, messageId, chunkIndex, voiceId, { streaming: messageId === activeStreamingTtsMessageId });
    persistLastPlayedMessage(messageId);
  };

  const handleStopTTS = useCallback(async () => {
    stopVoicePreview();
    setTtsAutoScrollEnabled(false);

    if (ttsActiveMessageId) {
      setCollapsedIds((current) => {
        if (!current.has(ttsActiveMessageId)) {
          return current;
        }

        const next = new Set(current);
        next.delete(ttsActiveMessageId);
        return next;
      });
    }

    await ttsStop();
  }, [stopVoicePreview, ttsActiveMessageId, ttsStop]);

  const handleResumeSessionTts = async () => {
    stopVoicePreview();
    const lastPlayedMessageId = session.last_tts_message_id;
    if (!lastPlayedMessageId) {
      return;
    }

    if (ttsActiveMessageId === lastPlayedMessageId) {
      if (ttsIsPlaying) {
        ttsPause();
        return;
      }

      if (ttsIsPaused) {
        setTtsAutoScrollEnabled(true);
        await ttsResume();
        return;
      }
    }

    if (lastPlayedMessageId === activeStreamingTtsMessageId && streamingContentRef.current.trim()) {
      const voiceId = await resolvePlaybackVoiceId();
      setTtsAutoScrollEnabled(true);
      await startPlayback(streamingContentRef.current, lastPlayedMessageId, -1, voiceId, { streaming: true });
      return;
    }

    const targetMessage = messages.find((message) => message.id === lastPlayedMessageId);
    if (!targetMessage) {
      return;
    }

    const voiceId = await resolvePlaybackVoiceId();
    setTtsAutoScrollEnabled(true);
    await startPlayback(targetMessage.content, targetMessage.id, -1, voiceId);
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
      await handleStopTTS();
    }

    await onEditMessage(messageId, content);
  };

  const handleSelectTtsVoice = async (voiceId: string | null) => {
    stopVoicePreview();
    setTtsVoiceLoading(true);
    setTtsVoiceWarning(null);

    try {
      const response = voiceId ? await api.selectTtsVoice(voiceId) : await api.clearSelectedTtsVoice();
      applyVoiceSelectionResponse(response);
      setSpeakerContext({
        sessionId: session.id,
        defaultVoiceReferenceId: response.selectedVoiceId ?? null,
        speakerMappings: sessionTtsSpeakers,
      });
      setShowVoiceMenu(false);
      await restartCurrentTtsPlayback(sessionTtsSpeakers, response.selectedVoiceId ?? null);
    } catch (error) {
      setTtsVoiceWarning(error instanceof Error ? error.message : "Failed to update TTS voice");
    } finally {
      setTtsVoiceLoading(false);
    }
  };

  const restartCurrentTtsPlayback = useCallback(async (speakerMappingsOverride?: SessionTtsSpeakerMapping[], defaultVoiceOverride?: string | null) => {
    if (!ttsActiveMessageId) {
      return;
    }

    const shouldRestartImmediately = ttsIsPlaying || ttsIsLoading;
    const restartChunkIndex = ttsCurrentChunk;

    if (speakerMappingsOverride) {
      setSpeakerContext({
        sessionId: session.id,
        defaultVoiceReferenceId: defaultVoiceOverride ?? selectedTtsVoiceId,
        speakerMappings: speakerMappingsOverride,
      });
    }

    if (!shouldRestartImmediately) {
      return;
    }

    await handleStopTTS();

    if (ttsActiveMessageId === activeStreamingTtsMessageId && streamingContentRef.current.trim()) {
      await startPlayback(
        streamingContentRef.current,
        activeStreamingTtsMessageId,
        restartChunkIndex,
        defaultVoiceOverride ?? selectedTtsVoiceId,
        { streaming: true },
      );
      return;
    }

    const activeMessage = messages.find((message) => message.id === ttsActiveMessageId);
    if (activeMessage) {
      await startPlayback(
        activeMessage.content,
        activeMessage.id,
        restartChunkIndex,
        defaultVoiceOverride ?? selectedTtsVoiceId,
      );
    }
  }, [activeStreamingTtsMessageId, handleStopTTS, messages, selectedTtsVoiceId, setSpeakerContext, startPlayback, ttsActiveMessageId, ttsCurrentChunk, ttsIsLoading, ttsIsPlaying]);

  const handleAssignSpeakerVoice = async (speakerKey: string, voiceId: string | null) => {
    stopVoicePreview();
    setSessionTtsSpeakerActionKey(speakerKey);
    setSessionTtsSpeakerError(null);
    try {
      const response = await api.updateSessionTtsSpeaker(session.id, speakerKey, { voiceReferenceId: voiceId });
      const nextSpeakerMappings = mergeSessionTtsSpeaker(sessionTtsSpeakers, response.speaker);

      setSessionTtsSpeakers(nextSpeakerMappings);
      setSpeakerContext({
        sessionId: session.id,
        defaultVoiceReferenceId: selectedTtsVoiceId,
        speakerMappings: nextSpeakerMappings,
      });

      await restartCurrentTtsPlayback(nextSpeakerMappings, selectedTtsVoiceId);
      void loadSessionTtsSpeakers();
    } catch (error) {
      setSessionTtsSpeakerError(error instanceof Error ? error.message : "Failed to update speaker voice");
    } finally {
      setSessionTtsSpeakerActionKey(null);
    }
  };

  const handleSetSpeakerHidden = async (speakerKey: string, hidden: boolean) => {
    setSessionTtsSpeakerActionKey(speakerKey);
    setSessionTtsSpeakerError(null);
    try {
      const response = await api.updateSessionTtsSpeaker(session.id, speakerKey, { hidden });
      const nextSpeakerMappings = mergeSessionTtsSpeaker(sessionTtsSpeakers, response.speaker);

      setSessionTtsSpeakers(nextSpeakerMappings);
      setSpeakerContext({
        sessionId: session.id,
        defaultVoiceReferenceId: selectedTtsVoiceId,
        speakerMappings: nextSpeakerMappings,
      });
    } catch (error) {
      setSessionTtsSpeakerError(error instanceof Error ? error.message : "Failed to update speaker visibility");
    } finally {
      setSessionTtsSpeakerActionKey(null);
    }
  };

  const handlePreviewSpeakerVoice = async (voice: TtsVoiceReference | null) => {
    if (!voice) {
      setSessionTtsSpeakerError("Select a saved voice reference first to preview it.");
      return;
    }

    if (previewVoiceIdRef.current === voice.id) {
      stopVoicePreview();
      return;
    }

    stopVoicePreview();
    setSessionTtsSpeakerError(null);

    if (ttsIsPlaying) {
      ttsPause();
    } else if (ttsIsLoading) {
      await handleStopTTS();
    }

    const previewAudio = new Audio(voice.previewUrl || api.getTtsVoicePreviewUrl(voice.id));
    previewAudioRef.current = previewAudio;
    previewVoiceIdRef.current = voice.id;
    setPreviewVoiceId(voice.id);

    previewAudio.onended = () => {
      if (previewAudioRef.current !== previewAudio) return;
      previewAudioRef.current = null;
      previewVoiceIdRef.current = null;
      setPreviewVoiceId(null);
    };

    previewAudio.onerror = () => {
      if (previewAudioRef.current !== previewAudio) return;
      previewAudioRef.current = null;
      previewVoiceIdRef.current = null;
      setPreviewVoiceId(null);
      setSessionTtsSpeakerError(`Failed to preview "${voice.label}".`);
    };

    try {
      await previewAudio.play();
    } catch (error) {
      if (previewAudioRef.current === previewAudio) {
        previewAudioRef.current = null;
        previewVoiceIdRef.current = null;
        setPreviewVoiceId(null);
      }
      setSessionTtsSpeakerError(error instanceof Error ? error.message : `Failed to preview "${voice.label}".`);
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

  const handleMessageListTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (messagesLoading) return;

    const el = scrollContainerRef.current;
    const touch = event.touches[0];
    if (!el || !touch) return;

    if (el.scrollTop > 0) {
      pullRefreshTrackingRef.current = false;
      pullRefreshStartYRef.current = null;
      return;
    }

    pullRefreshTrackingRef.current = true;
    pullRefreshStartYRef.current = touch.clientY;
  };

  const handleMessageListTouchMove = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (!pullRefreshTrackingRef.current || messagesLoading || messagesRefreshing) return;

    const el = scrollContainerRef.current;
    const touch = event.touches[0];
    const startY = pullRefreshStartYRef.current;
    if (!el || !touch || startY === null) return;

    if (el.scrollTop > 0) {
      pullRefreshTrackingRef.current = false;
      pullRefreshStartYRef.current = null;
      schedulePullRefreshDistance(0);
      return;
    }

    const deltaY = touch.clientY - startY;
    if (deltaY <= 0) {
      schedulePullRefreshDistance(0);
      return;
    }

    schedulePullRefreshDistance(deltaY * 0.5);
  };

  const handleMessageListTouchEnd = () => {
    const shouldRefresh = pullRefreshDistanceRef.current >= PULL_TO_REFRESH_TRIGGER_PX && !messagesRefreshing;
    pullRefreshTrackingRef.current = false;
    pullRefreshStartYRef.current = null;

    if (shouldRefresh) {
      schedulePullRefreshDistance(PULL_TO_REFRESH_TRIGGER_PX);
      void onRefreshMessages?.();
      return;
    }

    schedulePullRefreshDistance(0);
  };

  const hasMessages = messages.length > 0;
  const hasActiveStream = isStreaming || isCompacting || hasInFlightStream;
  const canResumeSessionTts = Boolean(
    session.last_tts_message_id && (
      session.last_tts_message_id === activeStreamingTtsMessageId
        ? streamingContent.trim()
        : messages.some((message) => message.id === session.last_tts_message_id)
    )
  );

  useEffect(() => {
    void loadSessionTtsSpeakers();
  }, [loadSessionTtsSpeakers]);

  useEffect(() => {
    setShowHiddenSpeakers(false);
  }, [session.id]);

  useEffect(() => {
    if (sessionTtsSpeakers.some((speaker) => !speaker.hidden)) {
      return;
    }

    if (sessionTtsSpeakers.some((speaker) => speaker.hidden)) {
      setShowHiddenSpeakers(true);
    }
  }, [sessionTtsSpeakers]);

  useEffect(() => {
    if (!hasActiveStream) return;

    const timer = window.setTimeout(() => {
      void loadSessionTtsSpeakers();
    }, 1500);

    return () => window.clearTimeout(timer);
  }, [hasActiveStream, loadSessionTtsSpeakers, streamingContent]);

  const visibleSessionTtsSpeakers = useMemo(
    () => sessionTtsSpeakers.filter((speaker) => !speaker.hidden),
    [sessionTtsSpeakers],
  );
  const hiddenSessionTtsSpeakers = useMemo(
    () => sessionTtsSpeakers.filter((speaker) => speaker.hidden),
    [sessionTtsSpeakers],
  );
  const effectiveCollapsedIds = useMemo(
    () => ttsActiveMessageId
      ? new Set([...collapsedIds].filter((messageId) => messageId !== ttsActiveMessageId))
      : collapsedIds,
    [collapsedIds, ttsActiveMessageId],
  );
  const getSpeakerPreviewVoice = useCallback((speaker: SessionTtsSpeakerMapping) => {
    const effectiveVoiceId = speaker.voiceReferenceId ?? selectedTtsVoiceId;
    return effectiveVoiceId ? voiceById.get(effectiveVoiceId) || null : null;
  }, [selectedTtsVoiceId, voiceById]);

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
            <button
              onClick={() => void handleResumeSessionTts()}
              disabled={!canResumeSessionTts}
              className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md text-gray-500 dark:text-gray-400 disabled:opacity-40 disabled:cursor-not-allowed"
              title={session.last_tts_message_id ? "Resume session TTS" : "No TTS progress in this session yet"}
            >
              {ttsActiveMessageId === session.last_tts_message_id && ttsIsPlaying ? (
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>

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
              {customAgents.length > 0 && (
                <optgroup label="Custom Agents">
                  {customAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {modelAgents.length > 0 && (
                <optgroup label="Models">
                  {modelAgents.map((agent) => (
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
        onTouchStart={handleMessageListTouchStart}
        onTouchMove={handleMessageListTouchMove}
        onTouchEnd={handleMessageListTouchEnd}
        onTouchCancel={handleMessageListTouchEnd}
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
            {showPullRefreshIndicator && (
              <div className="flex justify-center pb-3">
                <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium shadow-sm transition-colors ${messagesRefreshing ? "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/70 dark:text-sky-300" : "border-gray-200 bg-white text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"}`}>
                  <svg
                    className={`h-3.5 w-3.5 ${messagesRefreshing ? "animate-spin" : ""}`}
                    style={messagesRefreshing ? undefined : { transform: `rotate(${pullRefreshProgress * 180}deg)` }}
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <path className="opacity-25" d="M12 2a10 10 0 1010 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                    <path d="M12 2a10 10 0 00-7.07 2.93" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                  </svg>
                  <span>{messagesRefreshing ? "Refreshing messages..." : pullRefreshDistance >= PULL_TO_REFRESH_TRIGGER_PX ? "Release to refresh" : "Pull to refresh"}</span>
                </div>
              </div>
            )}
            <MessageList
              messages={messages}
              streamingContent={streamingContent}
              streamingMessageId={streamingAssistantMessageId}
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
              collapsedIds={effectiveCollapsedIds}
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
          <div className="absolute -top-12 left-0 right-0 z-30 flex justify-center pointer-events-none">
            <div className="relative isolate z-30 max-w-[calc(100vw-1rem)] overflow-visible rounded-full border border-gray-200 bg-white text-gray-900 shadow-xl ring-1 ring-black/5 px-2 py-1 flex items-center gap-1 pointer-events-auto sm:px-3 sm:py-1.5 sm:gap-2 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:ring-white/10">
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
                      <span>{activeChunk?.status === "error" ? "Failed" : activeChunk?.parts?.every((part) => part.audio) ? "Cached" : "Queued"}</span>
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
                <div className="absolute bottom-full left-1/2 z-10 mb-2 flex h-[min(30rem,calc(100vh-10rem))] w-[min(21rem,calc(100vw-2rem))] -translate-x-1/2 flex-col rounded-2xl border border-gray-200 bg-white/95 px-3 py-2 shadow-xl backdrop-blur dark:border-gray-700 dark:bg-gray-900/95">
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

                  <div className="flex min-h-0 flex-1 flex-col">
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

                    <div className="mt-2 min-h-0 flex-[3] overflow-hidden rounded-xl border border-gray-200/80 p-2 dark:border-gray-700/80">
                      {ttsVoices.length === 0 ? (
                        <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-gray-200 px-3 py-3 text-center text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
                          No saved voice references yet. Add them in Settings.
                        </div>
                      ) : (
                        <div className="h-full overflow-y-auto space-y-1 pr-1">
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

                    <div className="mt-3 flex min-h-0 flex-[7] flex-col border-t border-gray-200 pt-3 dark:border-gray-700">
                      <div className="mb-2 flex items-center justify-between gap-2 text-[11px] font-medium text-gray-500 dark:text-gray-400">
                        <span>Session speaker voices</span>
                        {sessionTtsSpeakerLoading && (
                          <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                            <svg className="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                            </svg>
                            Syncing
                          </span>
                        )}
                      </div>

                      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                        <div className="space-y-2">
                          {visibleSessionTtsSpeakers.map((speaker) => {
                            const isBusy = sessionTtsSpeakerActionKey === speaker.speakerKey;
                            const previewVoice = getSpeakerPreviewVoice(speaker);
                            const isPreviewing = previewVoiceId === previewVoice?.id;

                            return (
                              <div key={speaker.speakerKey} className="rounded-xl border border-gray-200 px-3 py-2 dark:border-gray-700">
                                <div className="mb-2 flex items-center justify-between gap-2">
                                  <div className="min-w-0 text-xs font-medium text-gray-500 dark:text-gray-400">
                                    {speaker.speakerLabel}
                                  </div>
                                  <button
                                    type="button"
                                    disabled={isBusy}
                                    onClick={() => void handleSetSpeakerHidden(speaker.speakerKey, true)}
                                    className="rounded-md px-2 py-1 text-[11px] font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-60 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                                  >
                                    Hide
                                  </button>
                                </div>
                                <div className="flex items-center gap-2">
                                  <select
                                    value={speaker.voiceReferenceId ?? "default"}
                                    disabled={isBusy}
                                    onChange={(event) => void handleAssignSpeakerVoice(speaker.speakerKey, event.target.value === "default" ? null : event.target.value)}
                                    className="min-w-0 flex-1 rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
                                  >
                                    <option value="default">Default voice ({selectedTtsVoice?.label || "builtin"})</option>
                                    {ttsVoices.map((voice) => (
                                      <option key={`${speaker.speakerKey}-${voice.id}`} value={voice.id}>{voice.label}</option>
                                    ))}
                                  </select>
                                  <button
                                    type="button"
                                    disabled={isBusy || !previewVoice}
                                    onClick={() => void handlePreviewSpeakerVoice(previewVoice)}
                                    className={`inline-flex h-9 w-9 items-center justify-center rounded-md border transition-colors ${
                                      isPreviewing
                                        ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                                        : "border-gray-200 bg-white text-gray-500 hover:bg-gray-50 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                                    }`}
                                    title={previewVoice ? (isPreviewing ? `Stop previewing ${previewVoice.label}` : `Preview ${previewVoice.label}`) : "No saved voice reference available to preview"}
                                    aria-label={previewVoice ? (isPreviewing ? `Stop previewing ${previewVoice.label}` : `Preview ${previewVoice.label}`) : "No saved voice reference available to preview"}
                                  >
                                    {isPreviewing ? (
                                      <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                                        <rect x="6" y="6" width="12" height="12" rx="2" />
                                      </svg>
                                    ) : (
                                      <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                                        <path d="M8 5v14l11-7z" />
                                      </svg>
                                    )}
                                  </button>
                                </div>
                                <div className="mt-1 text-[10px] text-gray-400 dark:text-gray-500">
                                  {previewVoice
                                    ? `${speaker.voiceReferenceId ? "Speaker voice" : "Default voice"} preview: ${previewVoice.label}`
                                    : speaker.voiceReferenceId
                                      ? "Selected voice is unavailable."
                                      : "Default voice preview is unavailable until you select a saved default voice."}
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {hiddenSessionTtsSpeakers.length > 0 && (
                          <div className="rounded-xl border border-dashed border-gray-200 px-3 py-2 dark:border-gray-700">
                            <button
                              type="button"
                              onClick={() => setShowHiddenSpeakers((prev) => !prev)}
                              className="flex w-full items-center justify-between text-left text-[11px] font-medium text-gray-500 transition-colors hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                            >
                              <span>{showHiddenSpeakers ? "Hide hidden speakers" : `Show hidden speakers (${hiddenSessionTtsSpeakers.length})`}</span>
                              <svg
                                className={`h-3.5 w-3.5 transition-transform ${showHiddenSpeakers ? "rotate-180" : ""}`}
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </button>

                            {showHiddenSpeakers && (
                              <div className="mt-3 space-y-2">
                                {hiddenSessionTtsSpeakers.map((speaker) => {
                                  const isBusy = sessionTtsSpeakerActionKey === speaker.speakerKey;
                                  const previewVoice = getSpeakerPreviewVoice(speaker);
                                  const isPreviewing = previewVoiceId === previewVoice?.id;

                                  return (
                                    <div key={speaker.speakerKey} className="rounded-xl border border-gray-200 px-3 py-2 dark:border-gray-700">
                                      <div className="mb-2 flex items-center justify-between gap-2">
                                        <div className="min-w-0">
                                          <div className="text-xs font-medium text-gray-500 dark:text-gray-400">{speaker.speakerLabel}</div>
                                          <div className="text-[10px] text-gray-400 dark:text-gray-500">Hidden from the main speaker list</div>
                                        </div>
                                        <button
                                          type="button"
                                          disabled={isBusy}
                                          onClick={() => void handleSetSpeakerHidden(speaker.speakerKey, false)}
                                          className="rounded-md px-2 py-1 text-[11px] font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-60 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                                        >
                                          Unhide
                                        </button>
                                      </div>
                                      <div className="flex items-center gap-2">
                                        <select
                                          value={speaker.voiceReferenceId ?? "default"}
                                          disabled={isBusy}
                                          onChange={(event) => void handleAssignSpeakerVoice(speaker.speakerKey, event.target.value === "default" ? null : event.target.value)}
                                          className="min-w-0 flex-1 rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
                                        >
                                          <option value="default">Default voice ({selectedTtsVoice?.label || "builtin"})</option>
                                          {ttsVoices.map((voice) => (
                                            <option key={`${speaker.speakerKey}-${voice.id}`} value={voice.id}>{voice.label}</option>
                                          ))}
                                        </select>
                                        <button
                                          type="button"
                                          disabled={isBusy || !previewVoice}
                                          onClick={() => void handlePreviewSpeakerVoice(previewVoice)}
                                          className={`inline-flex h-9 w-9 items-center justify-center rounded-md border transition-colors ${
                                            isPreviewing
                                              ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                                              : "border-gray-200 bg-white text-gray-500 hover:bg-gray-50 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                                          }`}
                                          title={previewVoice ? (isPreviewing ? `Stop previewing ${previewVoice.label}` : `Preview ${previewVoice.label}`) : "No saved voice reference available to preview"}
                                          aria-label={previewVoice ? (isPreviewing ? `Stop previewing ${previewVoice.label}` : `Preview ${previewVoice.label}`) : "No saved voice reference available to preview"}
                                        >
                                          {isPreviewing ? (
                                            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                                              <rect x="6" y="6" width="12" height="12" rx="2" />
                                            </svg>
                                          ) : (
                                            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                                              <path d="M8 5v14l11-7z" />
                                            </svg>
                                          )}
                                        </button>
                                      </div>
                                      <div className="mt-1 text-[10px] text-gray-400 dark:text-gray-500">
                                        {previewVoice
                                          ? `${speaker.voiceReferenceId ? "Speaker voice" : "Default voice"} preview: ${previewVoice.label}`
                                          : speaker.voiceReferenceId
                                            ? "Selected voice is unavailable."
                                            : "Default voice preview is unavailable until you select a saved default voice."}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {sessionTtsSpeakerError && (
                        <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
                          {sessionTtsSpeakerError}
                        </div>
                      )}
                    </div>
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
                  <button onClick={() => void handleStopTTS()} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full" title="Close">
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
                        void loadSessionTtsSpeakers();
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
                      onClick={() => void handleStopTTS()}
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
                setStreamingAssistantMessageId(null);
                streamingContentRef.current = "";
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
