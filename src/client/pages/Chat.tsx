import { useState, useEffect, useCallback, useRef } from "react";
import { signOut } from "../lib/auth";
import { api } from "../lib/api";
import type { ChatSession, Message } from "../lib/api";
import Sidebar from "../components/Sidebar";
import ChatView from "../components/ChatView";
import Settings from "./Settings";

const ACTIVE_SESSION_STORAGE_KEY = "active-chat-session-id";

export default function Chat() {
  const [showSettings, setShowSettings] = useState(false);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
  });
  const [messages, setMessages] = useState<Message[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(window.innerWidth >= 1024);
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollingSessionRef = useRef<string | null>(null);
  const pollingMessageRef = useRef<string | null>(null);

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const isMobile = typeof window !== "undefined" && window.innerWidth < 1024;

  const clearActiveStreamingMessages = useCallback(() => {
    setMessages((prev) => prev.filter((m) => m.status !== "streaming"));
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const data = await api.getSessions();
      setSessions(data);

      const storedSessionId = typeof window !== "undefined"
        ? window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY)
        : null;
      const preferredSessionId = activeSessionId || storedSessionId;
      const preferredSessionExists = preferredSessionId
        ? data.some((session) => session.id === preferredSessionId)
        : false;

      if (preferredSessionExists) {
        if (activeSessionId !== preferredSessionId) {
          setActiveSessionId(preferredSessionId);
        }
      } else {
        const fallbackSessionId = data[0]?.id || null;
        setActiveSessionId(fallbackSessionId);
      }
    } catch (error) {
      console.error("Failed to load sessions:", error);
    } finally {
      setLoading(false);
    }
  }, [activeSessionId]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    if (activeSessionId) {
      window.localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, activeSessionId);
    } else {
      window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
    }
  }, [activeSessionId]);

  const loadMessages = useCallback(async (sessionId: string) => {
    setMessagesLoading(true);
    try {
      const data = await api.getMessages(sessionId);
      setMessages(data);
    } catch (error) {
      console.error("Failed to load messages:", error);
    } finally {
      setMessagesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }

    pollingSessionRef.current = null;
    pollingMessageRef.current = null;
  }, []);

  // Poll for streaming messages that were interrupted (e.g. page refresh during stream)
  const startPolling = useCallback((sessionId: string, messageId: string) => {
    stopPolling();

    pollingSessionRef.current = sessionId;
    pollingMessageRef.current = messageId;

    let lastContent = "";
    let staleCount = 0;
    const MAX_STALE = 120; // stop after ~3 minutes of no change (120 * 1.5s)

    pollingRef.current = setInterval(async () => {
      try {
        const msg = await api.getMessage(sessionId, messageId) as Message;
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, content: msg.content, status: msg.status } : m))
        );

        if (msg.status !== "streaming") {
          stopPolling();
          return;
        }

        // Detect stale streaming — if content hasn't changed, increment counter
        if (msg.content === lastContent) {
          staleCount++;
          if (staleCount >= MAX_STALE) {
            console.warn("[polling] Message stuck in streaming state, giving up");
            stopPolling();
            // Update message to show as complete locally
            setMessages((prev) =>
              prev.map((m) => (m.id === messageId ? { ...m, status: "complete" } : m))
            );
          }
        } else {
          lastContent = msg.content;
          staleCount = 0;
        }
      } catch {
        stopPolling();
      }
    }, 1500);
  }, [stopPolling]);

  useEffect(() => {
    if (activeSessionId) {
      loadMessages(activeSessionId);
    } else {
      setMessages([]);
      stopPolling();
    }

    // Cleanup polling on session change
    return () => {
      stopPolling();
    };
  }, [activeSessionId, loadMessages, stopPolling]);

  // Check for streaming messages after load / message updates
  useEffect(() => {
    if (!activeSessionId || messagesLoading) return;

    const streamingMsg = messages.find((m: Message) => m.status === "streaming");
    if (!streamingMsg) {
      if (pollingSessionRef.current === activeSessionId) {
        stopPolling();
      }
      return;
    }

    if (pollingMessageRef.current !== streamingMsg.id) {
      startPolling(activeSessionId, streamingMsg.id);
    }
  }, [activeSessionId, messagesLoading, messages, startPolling, stopPolling]);

  const stopActiveSessionGeneration = useCallback(async () => {
    if (!activeSessionId) return;

    // Local-first stop for immediate UX; avoid refetching all messages.
    clearActiveStreamingMessages();
    stopPolling();

    try {
      await api.stopGeneration(activeSessionId);
    } catch (error) {
      console.error("Failed to stop generation:", error);
    }
  }, [activeSessionId, clearActiveStreamingMessages, stopPolling]);

  const stopThenRun = useCallback(
    async (action: () => Promise<void>) => {
      if (activeSessionId) {
        await stopActiveSessionGeneration();
      }
      await action();
    },
    [activeSessionId, stopActiveSessionGeneration],
  );

  const hasInFlightStream = messages.some((message) => message.status === "streaming");

  const handleSelectSession = (id: string) => {
    setActiveSessionId(id);
    if (isMobile) setSidebarOpen(false);
  };

  const handleNewChat = async () => {
    setActionLoading("new-chat");
    try {
      const session = await api.createSession();
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
      setMessages([]);
      if (isMobile) setSidebarOpen(false);
    } catch (error) {
      console.error("Failed to create session:", error);
    } finally {
      setActionLoading(null);
    }
  };

  const handleDeleteSession = async (id: string) => {
    setActionLoading(`delete-session-${id}`);
    try {
      await api.deleteSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (activeSessionId === id) {
        const remaining = sessions.filter((s) => s.id !== id);
        setActiveSessionId(remaining[0]?.id || null);
      }
    } catch (error) {
      console.error("Failed to delete session:", error);
    } finally {
      setActionLoading(null);
    }
  };

  const handleUpdateSession = async (id: string, updates: { title?: string; agent?: string }) => {
    try {
      const updated = await api.updateSession(id, updates);
      setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)));
    } catch (error) {
      console.error("Failed to update session:", error);
    }
  };

  const handleMessageSent = (userMessage: Message) => {
    setMessages((prev) => [...prev, userMessage]);
  };

  const handleUpdateMessageId = (tempId: string, realId: string) => {
    setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, id: realId } : m)));
  };

  const handleMessageReceived = (assistantMessage: Message) => {
    setMessages((prev) => [...prev, assistantMessage]);
    loadSessions();
  };

  const handleEditMessage = async (messageId: string, content: string) => {
    await stopThenRun(async () => {
      if (!activeSessionId) return;
      setActionLoading(`edit-msg-${messageId}`);
      const previousMessages = messages;
      try {
        setMessages((prev) => prev.map((message) => (
          message.id === messageId
            ? { ...message, content }
            : message
        )));

        const updated = await api.editMessage(activeSessionId, messageId, content);
        setMessages((prev) => prev.map((message) => (
          message.id === messageId
            ? { ...message, ...updated }
            : message
        )));

        await loadMessages(activeSessionId);
      } catch (error) {
        console.error("Failed to edit message:", error);
        setMessages(previousMessages);
      } finally {
        setActionLoading(null);
      }
    });
  };

  const handleFork = async (messageId: string) => {
    await stopThenRun(async () => {
      if (!activeSessionId) return;
      setActionLoading(`fork-${messageId}`);
      try {
        const newSession = await api.forkSession(activeSessionId, messageId);
        setSessions((prev) => [newSession, ...prev]);
        setActiveSessionId(newSession.id);
        if (isMobile) setSidebarOpen(false);
      } catch (error) {
        console.error("Failed to fork session:", error);
      } finally {
        setActionLoading(null);
      }
    });
  };

  const handleTruncateAfter = (messageId: string) => {
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx >= 0) {
      setMessages(messages.slice(0, idx + 1));
    }
  };

  const handleDeleteMessage = async (messageId: string) => {
    await stopThenRun(async () => {
      if (!activeSessionId) return;
      setActionLoading(`delete-msg-${messageId}`);
      try {
        await api.deleteMessage(activeSessionId, messageId);
        setMessages((prev) => prev.filter((m) => m.id !== messageId));
      } catch (error) {
        console.error("Failed to delete message:", error);
      } finally {
        setActionLoading(null);
      }
    });
  };

  const handleSignOut = async () => {
    setActionLoading("signout");
    await signOut();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50 dark:bg-gray-900">
        <div className="flex flex-col items-center gap-3">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-gray-300 dark:border-gray-600 border-t-gray-900 dark:border-t-white"></div>
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading...</p>
        </div>
      </div>
    );
  }

  if (showSettings) {
    return <Settings onBack={() => setShowSettings(false)} />;
  }

  return (
    <div className="flex h-[100dvh] bg-gray-100 dark:bg-gray-950 overflow-hidden">
      {/* Sidebar - always fixed/overlay so main area gets full width */}
      <div
        className={`${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        } fixed inset-y-0 left-0 z-40 w-72 transition-transform duration-300 ease-in-out`}
      >
        <Sidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={handleSelectSession}
          onNewChat={handleNewChat}
          onDeleteSession={handleDeleteSession}
          onUpdateSession={handleUpdateSession}
          onSignOut={handleSignOut}
          onSettings={() => { setShowSettings(true); setSidebarOpen(false); }}
          actionLoading={actionLoading}
        />
      </div>

      {/* Overlay when sidebar open */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {activeSession ? (
          <ChatView
            session={activeSession}
            messages={messages}
            messagesLoading={messagesLoading}
            onMessageSent={handleMessageSent}
            onMessageReceived={handleMessageReceived}
            onUpdateMessageId={handleUpdateMessageId}
            onUpdateSession={handleUpdateSession}
            onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
            onEditMessage={handleEditMessage}
            onDeleteMessage={handleDeleteMessage}
            onTruncateAfter={handleTruncateAfter}
            onFork={handleFork}
            onBeforeRegenerate={stopThenRun}
            onStopGeneration={stopActiveSessionGeneration}
            hasInFlightStream={hasInFlightStream}
            actionLoading={actionLoading}
          />
        ) : (
          <div className="flex-1 flex flex-col">
            {/* Empty state header with sidebar toggle */}
            <div className="flex items-center h-12 px-3 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
              <button
                onClick={() => setSidebarOpen(!sidebarOpen)}
                className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md text-gray-700 dark:text-gray-200"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
            </div>
            <div className="flex-1 flex items-center justify-center text-gray-500 dark:text-gray-400">
              <div className="text-center">
                <p className="text-xl mb-4">No chat selected</p>
                <button
                  onClick={handleNewChat}
                  className="px-4 py-2 bg-gray-900 dark:bg-gray-700 text-white rounded-md hover:bg-gray-800 dark:hover:bg-gray-600"
                >
                  Start a new chat
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
