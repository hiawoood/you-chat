import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Message } from "../lib/api";

const COLLAPSE_HEIGHT = 72;
const COLLAPSE_LINE_COUNT = 3;

interface MessageListProps {
  messages: Message[];
  streamingContent: string;
  thinkingStatus?: string | null;
  onEditMessage?: (messageId: string, content: string) => void;
  onDeleteMessage?: (messageId: string) => void;
  onRegenerate?: (messageId: string) => void;
  onFork?: (messageId: string) => void;
  actionLoading?: string | null;
  collapsedIds?: Set<string>;
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

export default function MessageList({
  messages,
  streamingContent,
  thinkingStatus,
  onEditMessage,
  onDeleteMessage,
  onRegenerate,
  onFork,
  actionLoading,
  collapsedIds = new Set(),
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  const items: (Message & { isStreaming?: boolean })[] = [
    ...messages,
    ...(streamingContent
      ? [{
          id: "streaming",
          session_id: "",
          role: "assistant" as const,
          content: streamingContent,
          created_at: Date.now() / 1000,
          isStreaming: true,
        }]
      : []),
  ];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, streamingContent, thinkingStatus]);

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
        return (
          <MessageBubble
            key={item.id}
            message={item}
            isStreaming={isActivelyStreaming}
            isDeleting={isDeleting}
            onEdit={onEditMessage && !isActivelyStreaming ? (content: string) => onEditMessage(item.id, content) : undefined}
            onDelete={onDeleteMessage && !isActivelyStreaming ? () => onDeleteMessage(item.id) : undefined}
            onRegenerate={onRegenerate && !isActivelyStreaming && item.role === "user" ? () => onRegenerate(item.id) : undefined}
            onFork={onFork && !isActivelyStreaming ? () => onFork(item.id) : undefined}
            forceCollapsed={collapsedIds.has(item.id)}
            isSaving={actionLoading === `edit-msg-${item.id}`}
            isForking={actionLoading === `fork-${item.id}`}
          />
        );
      })}
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
      title={copied ? "Copied!" : "Copy"}
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

function IconButton({ onClick, title, children, className = "" }: {
  onClick: (e: React.MouseEvent) => void;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 px-1.5 py-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors rounded text-xs ${className}`}
      title={title}
    >
      {children}
    </button>
  );
}

function MessageBubble({
  message,
  isStreaming = false,
  isDeleting = false,
  isSaving = false,
  isForking = false,
  onEdit,
  onDelete,
  onRegenerate,
  onFork,
  forceCollapsed = false,
}: {
  message: Message;
  isStreaming?: boolean;
  isDeleting?: boolean;
  isSaving?: boolean;
  isForking?: boolean;
  onEdit?: (content: string) => void;
  onDelete?: () => void;
  onRegenerate?: () => void;
  onFork?: () => void;
  forceCollapsed?: boolean;
}) {
  const isUser = message.role === "user";
  const contentRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isLong, setIsLong] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [confirmAction, setConfirmAction] = useState<"delete" | "regenerate" | null>(null);

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
      textareaRef.current.focus();
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = textareaRef.current.scrollHeight + "px";
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

  const isCollapsed = collapsed && isLong && !isStreaming && !editing;
  const isBusy = isDeleting || isSaving || isForking;

  return (
    <div className={`group ${isUser ? "flex flex-col items-end" : "flex flex-col items-start"} ${isBusy ? "opacity-50" : ""}`}>
      {/* Timestamp */}
      <div className={`text-[10px] text-gray-400 dark:text-gray-500 mb-0.5 px-1 ${isUser ? "text-right" : "text-left"}`}>
        {formatTime(message.created_at)}
      </div>

      {/* Message bubble */}
      <div
        className={`w-full sm:max-w-[85%] md:max-w-[80%] rounded-lg relative ${
          isUser
            ? "bg-gray-900 text-white dark:bg-gray-700 px-4 py-2"
            : "bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-700 px-4 py-2"
        }`}
      >
        {editing ? (
          <div className="space-y-2">
            <textarea
              ref={textareaRef}
              value={editValue}
              onChange={(e) => {
                setEditValue(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = e.target.scrollHeight + "px";
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
              className={`relative overflow-hidden transition-all duration-200 ${isCollapsed ? "max-h-[72px]" : ""}`}
            >
              <div className={`markdown-content text-sm break-words ${isUser ? "markdown-user" : ""}`}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
              </div>
              {isStreaming && <span className="inline-block w-2 h-4 ml-1 bg-gray-500 animate-pulse" />}
              {isCollapsed && (
                <div className={`absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t ${
                  isUser ? "from-gray-900 dark:from-gray-700" : "from-white dark:from-gray-800"
                } pointer-events-none`} />
              )}
            </div>
            {isLong && !isStreaming && (
              <button
                onClick={() => setCollapsed((prev) => !prev)}
                className={`text-xs mt-1 ${isUser ? "text-gray-300 hover:text-white" : "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"}`}
              >
                {isCollapsed ? "▼ Show more" : "▲ Show less"}
              </button>
            )}
          </>
        )}
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
                else if (confirmAction === "regenerate") onRegenerate?.();
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
          <div className={`flex items-center gap-0.5 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity ${isUser ? "flex-row-reverse" : ""}`}>
            <CopyButton text={message.content} />

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
