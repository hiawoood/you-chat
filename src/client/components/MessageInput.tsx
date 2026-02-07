import { useState, useRef, useEffect } from "react";

interface MessageInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

const MAX_HEIGHT = 168; // ~7 lines at 24px line height

export default function MessageInput({ onSend, disabled }: MessageInputProps) {
  const [message, setMessage] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, MAX_HEIGHT)}px`;
    }
  }, [message]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (message.trim() && !disabled) {
      onSend(message.trim());
      setMessage("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex items-end gap-2 w-full">
      <textarea
        ref={textareaRef}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Message..."
        disabled={disabled}
        rows={1}
        className="flex-1 min-w-0 resize-none px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:border-transparent disabled:opacity-50 disabled:bg-gray-100 dark:disabled:bg-gray-800 text-sm leading-6"
        style={{ maxHeight: MAX_HEIGHT }}
      />
      <button
        type="submit"
        disabled={disabled || !message.trim()}
        className="p-2 bg-gray-900 dark:bg-gray-600 text-white rounded-lg hover:bg-gray-800 dark:hover:bg-gray-500 disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0 flex items-center justify-center h-9 w-9"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
        </svg>
      </button>
    </form>
  );
}
