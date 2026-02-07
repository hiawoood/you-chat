import { useState, useEffect, useCallback, useRef } from "react";
import { signOut } from "../lib/auth";
import { api, ChatSession, Message } from "../lib/api";
import Sidebar from "../components/Sidebar";
import ChatView from "../components/ChatView";
import Settings from "./Settings";

export default function Chat() {
  const [showSettings, setShowSettings] = useState(false);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(window.innerWidth >= 1024);
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const isMobile = typeof window !== "undefined" && window.innerWidth < 1024;

  const loadSessions = useCallback(async () => {
    try {
      const data = await api.getSessions();
      setSessions(data);
      if (data.length > 0 && !activeSessionId) {
        setActiveSessionId(data[0].id);
      }
    } catch (error) {
      console.error("Failed to load sessions:", error);
    } finally {
      setLoading(false);
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

  // Poll for streaming messages that were interrupted (e.g. page refresh during stream)
  const startPolling = useCallback((sessionId: string, messageId: string) => {
    if (pollingRef.current) clearInterval(pollingRef.current);

    let lastContent = "";
    let staleCount = 0;
    const MAX_STALE = 120; // stop after ~3 minutes of no change (120 * 1.5s)

    pollingRef.current = setInterval(async () => {
      try {
        const msg = await api.getMessage(sessionId, messageId) as any;
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, content: msg.content, status: msg.status } : m))
        );
        if (msg.status === "complete") {
          if (pollingRef.current) clearInterval(pollingRef.current);
          pollingRef.current = null;
          return;
        }
        // Detect stale streaming — if content hasn't changed, increment counter
        if (msg.content === lastContent) {
          staleCount++;
          if (staleCount >= MAX_STALE) {
            console.warn("[polling] Message stuck in streaming state, giving up");
            if (pollingRef.current) clearInterval(pollingRef.current);
            pollingRef.current = null;
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
        if (pollingRef.current) clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    }, 1500);
  }, []);

  useEffect(() => {
    if (activeSessionId) {
      loadMessages(activeSessionId);
    } else {
      setMessages([]);
    }
    // Cleanup polling on session change
    return () => {
      if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
    };
  }, [activeSessionId, loadMessages]);

  // Check for streaming messages after load
  useEffect(() => {
    if (!activeSessionId || messages.length === 0) return;
    const streamingMsg = messages.find((m: any) => m.status === "streaming");
    if (streamingMsg) {
      startPolling(activeSessionId, streamingMsg.id);
    }
  }, [activeSessionId, messagesLoading, startPolling]); // only when loading finishes

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
    setMessages((prev) =>
      prev.map((m) => (m.id === tempId ? { ...m, id: realId } : m))
    );
  };

  const handleMessageReceived = (assistantMessage: Message) => {
    setMessages((prev) => [...prev, assistantMessage]);
    loadSessions();
  };

  const handleEditMessage = async (messageId: string, content: string) => {
    if (!activeSessionId) return;
    setActionLoading(`edit-msg-${messageId}`);
    try {
      const updated = await api.editMessage(activeSessionId, messageId, content);
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, content: updated.content } : m))
      );
    } catch (error) {
      console.error("Failed to edit message:", error);
    } finally {
      setActionLoading(null);
    }
  };

  const handleFork = async (messageId: string) => {
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
  };

  const handleTruncateAfter = (messageId: string) => {
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx >= 0) {
      setMessages(messages.slice(0, idx + 1));
    }
  };

  const handleDeleteMessage = async (messageId: string) => {
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
            onStopGeneration={() => {
              // Give server a moment to delete the partial message, then reload
              setTimeout(() => { if (activeSessionId) loadMessages(activeSessionId); }, 500);
            }}
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
