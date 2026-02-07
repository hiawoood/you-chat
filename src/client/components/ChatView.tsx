import { useState, useRef, useEffect, useCallback } from "react";
import { ChatSession, Message, Agent, api } from "../lib/api";
import { useChat } from "../hooks/useChat";
import { useScrollDirection } from "../hooks/useScrollDirection";
import MessageList from "./MessageList";
import MessageInput from "./MessageInput";

interface ChatViewProps {
  session: ChatSession;
  messages: Message[];
  messagesLoading?: boolean;
  onMessageSent: (message: Message) => void;
  onMessageReceived: (message: Message) => void;
  onUpdateMessageId: (tempId: string, realId: string) => void;
  onUpdateSession: (id: string, updates: { title?: string; agent?: string }) => void;
  onToggleSidebar?: () => void;
  onEditMessage?: (messageId: string, content: string) => void;
  onDeleteMessage?: (messageId: string) => void;
  onTruncateAfter?: (messageId: string) => void;
  onFork?: (messageId: string) => void;
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
  actionLoading,
}: ChatViewProps) {
  const [streamingContent, setStreamingContent] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const streamingContentRef = useRef("");
  const pendingTempIdRef = useRef<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollDirection = useScrollDirection(scrollContainerRef);
  const hideHeader = scrollDirection === "down";
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const handleScroll = () => {
      const distFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
      setShowScrollBtn(distFromBottom > 200);
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

  const { sendMessage, regenerate, isStreaming } = useChat({
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
    onTruncateAfter?.(messageId);
    // Stream a new response
    await regenerate(messageId);
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

  const hasMessages = messages.length > 0;

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
        <h2 className="font-semibold text-sm truncate flex-1 text-gray-900 dark:text-white">{session.title}</h2>

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
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9V4.5M9 9H4.5M9 9L3.5 3.5M15 9h4.5M15 9V4.5M15 9l5.5-5.5M9 15v4.5M9 15H4.5M9 15l-5.5 5.5M15 15h4.5M15 15v4.5m0-4.5l5.5 5.5" />
              </svg>
            )}
          </button>
        )}

        <select
          value={session.agent}
          onChange={(e) => handleAgentChange(e.target.value)}
          disabled={isStreaming}
          className="text-sm px-2 py-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-gray-400"
        >
          {agents.filter(a => a.type === "agent").length > 0 && (
            <optgroup label="Custom Agents">
              {agents.filter(a => a.type === "agent").map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </optgroup>
          )}
          {agents.filter(a => a.type === "model").length > 0 && (
            <optgroup label="Models">
              {agents.filter(a => a.type === "model").map((agent) => (
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
      </div>
      </div>

      {/* Messages */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto bg-gray-50 dark:bg-gray-950">
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
              actionLoading={actionLoading}
              collapsedIds={collapsedIds}
            />
          </div>
        )}
      </div>

      {/* Input - h-14 fixed to align with sidebar bottom */}
      <div className="h-14 flex items-center border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex-shrink-0">
        <div className="max-w-3xl mx-auto w-full px-4">
          <MessageInput onSend={handleSend} disabled={isStreaming} />
        </div>
      </div>
    </div>
  );
}
