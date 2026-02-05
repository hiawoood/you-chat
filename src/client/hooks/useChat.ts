import { useState, useCallback } from "react";

interface UseChatOptions {
  sessionId: string;
  onMessage?: (content: string) => void;
  onUserMessageId?: (realId: string) => void;
  onDone?: (messageId: string) => void;
  onTitleGenerated?: (title: string) => void;
  onError?: (error: string) => void;
}

// Shared SSE stream reader
async function readStream(
  response: Response,
  callbacks: {
    onDelta?: (delta: string) => void;
    onUserMessageId?: (id: string) => void;
    onDone?: (messageId: string, generatedTitle?: string) => void;
    onError?: (error: string) => void;
  }
) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;

      const data = trimmed.slice(6);
      try {
        const parsed = JSON.parse(data);

        if (parsed.error) {
          callbacks.onError?.(parsed.error);
          break;
        }

        if (parsed.userMessageId) {
          callbacks.onUserMessageId?.(parsed.userMessageId);
        }

        if (parsed.delta) {
          callbacks.onDelta?.(parsed.delta);
        }

        if (parsed.done) {
          callbacks.onDone?.(parsed.messageId, parsed.generatedTitle);
        }
      } catch {
        // Skip non-JSON
      }
    }
  }
}

export function useChat({ sessionId, onMessage, onUserMessageId, onDone, onTitleGenerated, onError }: UseChatOptions) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamedContent, setStreamedContent] = useState("");

  const sendMessage = useCallback(
    async (message: string) => {
      setIsStreaming(true);
      setStreamedContent("");
      let fullContent = "";

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, message }),
        });

        if (!response.ok) throw new Error("Failed to send message");

        await readStream(response, {
          onDelta: (delta) => {
            fullContent += delta;
            setStreamedContent(fullContent);
            onMessage?.(fullContent);
          },
          onUserMessageId,
          onDone: (messageId, generatedTitle) => {
            onDone?.(messageId);
            if (generatedTitle) onTitleGenerated?.(generatedTitle);
          },
          onError,
        });
      } catch (error) {
        onError?.(error instanceof Error ? error.message : "Unknown error");
      } finally {
        setIsStreaming(false);
      }
    },
    [sessionId, onMessage, onUserMessageId, onDone, onTitleGenerated, onError]
  );

  const regenerate = useCallback(
    async (messageId: string) => {
      setIsStreaming(true);
      setStreamedContent("");
      let fullContent = "";

      try {
        const response = await fetch("/api/chat/regenerate", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, messageId }),
        });

        if (!response.ok) throw new Error("Failed to regenerate");

        await readStream(response, {
          onDelta: (delta) => {
            fullContent += delta;
            setStreamedContent(fullContent);
            onMessage?.(fullContent);
          },
          onDone: (msgId) => onDone?.(msgId),
          onError,
        });
      } catch (error) {
        onError?.(error instanceof Error ? error.message : "Unknown error");
      } finally {
        setIsStreaming(false);
      }
    },
    [sessionId, onMessage, onDone, onError]
  );

  return { sendMessage, regenerate, isStreaming, streamedContent };
}
