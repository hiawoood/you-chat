import { useState, useRef, useEffect, useCallback } from "react";
import { api } from "../lib/api";
import type { ChatSession, Message, Agent } from "../lib/api";
import { useChat } from "../hooks/useChat";
import { useVastTTS } from "../hooks/useVastTTS";
import { useScrollDirection } from "../hooks/useScrollDirection";
import MessageList from "./MessageList";
import MessageInput from "./MessageInput";
import CompactModal from "./CompactModal";

const SCROLL_TRIGGER_BUFFER_PX = 200;

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

  // Initialize Vast TTS hook
  const { 
    status: ttsStatus, 
    isActive: ttsIsActive, 
    isHealthy: ttsIsHealthy,
    isStarting: ttsIsStarting,
    startInstance: startTTSInstance,
    stopInstance: stopTTSInstance,
    speak: ttsSpeak,
    playAudio: ttsPlayAudio,
  } = useVastTTS();

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
    if (!ttsIsActive || !ttsIsHealthy) {
      // Don't play if GPU not ready - UI will show warning
      return;
    }
    
    try {
      const result = await ttsSpeak(content);
      if (result.success && result.audio) {
        await ttsPlayAudio(result.audio);
      }
    } catch (err) {
      console.error("TTS playback failed:", err);
    }
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

            {/* GPU TTS Status Indicator */}
            <div className="flex items-center gap-1 ml-2">
              {ttsIsStarting ? (
                <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-yellow-600 bg-yellow-50 dark:bg-yellow-900/20 rounded-full">
                  <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Starting GPU...
                </span>
              ) : ttsIsActive && ttsIsHealthy ? (
                <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-green-600 bg-green-50 dark:bg-green-900/20 rounded-full">
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                  </svg>
                  {ttsStatus?.instance?.gpuName || "GPU Ready"}
                  {ttsStatus?.instance?.hourlyRate && (
                    <span className="text-green-500">${Number(ttsStatus.instance.hourlyRate).toFixed(3)}/hr</span>
                  )}
                  <button
                    onClick={() => void stopTTSInstance()}
                    className="ml-1 p-0.5 hover:bg-green-200 dark:hover:bg-green-800 rounded"
                    title="Stop GPU"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <rect x="6" y="6" width="12" height="12" rx="2" strokeWidth="2" />
                    </svg>
                  </button>
                </span>
              ) : ttsIsActive && !ttsIsHealthy ? (
                <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-orange-600 bg-orange-50 dark:bg-orange-900/20 rounded-full">
                  <svg className="w-3 h-3 animate-pulse" fill="currentColor" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" />
                  </svg>
                  Initializing...
                </span>
              ) : (
                <button
                  onClick={() => void startTTSInstance()}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 dark:text-gray-300 rounded-full transition-colors"
                  title="Start GPU for TTS"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  Start GPU
                </button>
              )}
            </div>
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
              onToggleTTS={ttsIsActive && ttsIsHealthy ? handleToggleTTS : undefined}
              actionLoading={actionLoading}
              collapsedIds={collapsedIds}
              suppressAutoScrollOnNextAppend={suppressMessageAutoScroll}
              onAutoScrollSuppressed={() => setSuppressMessageAutoScroll(false)}
              disableAutoScroll={hasActiveStream}
              isNearBottom={isNearBottom}
              disableQuickContinue={hasActiveStream}
              compactBusy={isCompacting}
              ttsEnabled={ttsIsActive && ttsIsHealthy}
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
      <div className="min-h-[3.5rem] flex items-end border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex-shrink-0 py-2">
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
