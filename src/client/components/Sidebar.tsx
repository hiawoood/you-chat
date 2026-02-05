import { useState, useRef, useEffect } from "react";
import { ChatSession } from "../lib/api";

interface SidebarProps {
  sessions: ChatSession[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
  onDeleteSession: (id: string) => void;
  onUpdateSession: (id: string, updates: { title?: string }) => void;
  onSignOut: () => void;
  onSettings?: () => void;
  actionLoading?: string | null;
}

export default function Sidebar({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewChat,
  onDeleteSession,
  onUpdateSession,
  onSignOut,
  onSettings,
  actionLoading,
}: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const startEditing = (session: ChatSession, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(session.id);
    setEditValue(session.title);
  };

  const saveEdit = () => {
    if (editingId && editValue.trim()) {
      onUpdateSession(editingId, { title: editValue.trim() });
    }
    setEditingId(null);
    setEditValue("");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValue("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") saveEdit();
    else if (e.key === "Escape") cancelEdit();
  };

  return (
    <div className="h-full bg-gray-900 text-white flex flex-col">
      {/* New Chat - h-12 to match header */}
      <div className="h-12 flex items-center px-3 border-b border-gray-700/50">
        <button
          onClick={onNewChat}
          disabled={actionLoading === "new-chat"}
          className="w-full h-8 px-3 border border-gray-600 rounded-md hover:bg-gray-800 flex items-center justify-center gap-2 text-sm disabled:opacity-50"
        >
          {actionLoading === "new-chat" ? (
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          )}
          New Chat
        </button>
      </div>

      {/* Sessions list */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {sessions.map((session) => {
          const isDeleting = actionLoading === `delete-session-${session.id}`;
          return (
            <div
              key={session.id}
              className={`group flex items-center gap-2 px-3 py-2 rounded-md mb-1 cursor-pointer transition-colors ${
                isDeleting ? "opacity-50" : ""
              } ${
                session.id === activeSessionId
                  ? "bg-gray-700"
                  : "hover:bg-gray-800"
              }`}
              onClick={() => !isDeleting && editingId !== session.id && onSelectSession(session.id)}
            >
              <svg className="w-4 h-4 flex-shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>

              {editingId === session.id ? (
                <input
                  ref={inputRef}
                  type="text"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={saveEdit}
                  onKeyDown={handleKeyDown}
                  onClick={(e) => e.stopPropagation()}
                  className="flex-1 bg-gray-800 text-sm text-white px-1 py-0.5 rounded border border-gray-500 focus:outline-none focus:border-blue-500"
                />
              ) : (
                <span className="flex-1 truncate text-sm">{session.title}</span>
              )}

              {editingId !== session.id && !isDeleting && confirmDeleteId !== session.id && (
                <div className="flex items-center gap-0.5">
                  <button
                    onClick={(e) => startEditing(session, e)}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-600 rounded transition-opacity"
                    title="Edit title"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDeleteId(session.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-600 rounded transition-opacity"
                    title="Delete chat"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              )}

              {/* Delete confirmation */}
              {confirmDeleteId === session.id && (
                <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => { onDeleteSession(session.id); setConfirmDeleteId(null); }}
                    className="px-1.5 py-0.5 text-xs rounded bg-red-600 text-white hover:bg-red-700"
                  >
                    Delete
                  </button>
                  <button
                    onClick={() => setConfirmDeleteId(null)}
                    className="px-1.5 py-0.5 text-xs rounded text-gray-400 hover:text-white hover:bg-gray-600"
                  >
                    Cancel
                  </button>
                </div>
              )}

              {isDeleting && (
                <svg className="w-4 h-4 animate-spin text-gray-400" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              )}
            </div>
          );
        })}
      </div>

      {/* Bottom actions */}
      <div className="border-t border-gray-700/50 px-3 py-2 flex-shrink-0 space-y-1">
        {onSettings && (
          <button
            onClick={onSettings}
            className="w-full py-2 px-3 text-sm text-gray-400 hover:text-white hover:bg-gray-800 rounded-md flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Settings
          </button>
        )}
        <button
          onClick={onSignOut}
          disabled={actionLoading === "signout"}
          className="w-full py-2 px-3 text-sm text-gray-400 hover:text-white hover:bg-gray-800 rounded-md flex items-center gap-2 disabled:opacity-50"
        >
          {actionLoading === "signout" ? (
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          )}
          Sign Out
        </button>
      </div>
    </div>
  );
}
