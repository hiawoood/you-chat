import { useState, useCallback, useRef } from "react";

interface UseChatOptions {
  sessionId: string;
  onMessage?: (content: string) => void;
  onUserMessageId?: (realId: string) => void;
  onDone?: (messageId: string) => void;
  onTitleGenerated?: (title: string) => void;
  onThinking?: (status: string) => void;
  onError?: (error: string) => void;
}

// Shared SSE stream reader
async function readStream(
  response: Response,
  callbacks: {
    onDelta?: (delta: string) => void;
    onUserMessageId?: (id: string) => void;
    onAssistantMessageId?: (id: string) => void;
    onThinking?: (status: string) => void;
    onDone?: (messageId: string, generatedTitle?: string) => void;
    onError?: (error: string) => void;
  },
  signal?: AbortSignal
) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) {
        reader.cancel();
        break;
      }

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

          if (parsed.assistantMessageId) {
            callbacks.onAssistantMessageId?.(parsed.assistantMessageId);
          }

          if (parsed.thinking) {
            callbacks.onThinking?.(parsed.thinking);
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
  } catch (err) {
    if (signal?.aborted) return; // Expected abort
    throw err;
  }
}

export function useChat({ sessionId, onMessage, onUserMessageId, onDone, onTitleGenerated, onThinking, onError }: UseChatOptions) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [thinkingStatus, setThinkingStatus] = useState<string | null>(null);
  const [streamedContent, setStreamedContent] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const stopGeneration = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const sendMessage = useCallback(
    async (message: string) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setIsStreaming(true);
      setStreamedContent("");
      setThinkingStatus(null);
      let fullContent = "";
      let assistantMsgId: string | null = null;

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, message }),
          signal: controller.signal,
        });

        if (!response.ok) throw new Error("Failed to send message");

        await readStream(response, {
          onThinking: (status) => {
            setThinkingStatus(status);
            onThinking?.(status);
          },
          onDelta: (delta) => {
            setThinkingStatus(null);
            fullContent += delta;
            setStreamedContent(fullContent);
            onMessage?.(fullContent);
          },
          onUserMessageId,
          onAssistantMessageId: (id) => { assistantMsgId = id; },
          onDone: (messageId, generatedTitle) => {
            assistantMsgId = messageId;
            setThinkingStatus(null);
            onDone?.(messageId);
            if (generatedTitle) onTitleGenerated?.(generatedTitle);
          },
          onError,
        }, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) {
          // User stopped generation — delete the partial assistant message
          if (assistantMsgId) {
            try {
              await fetch(`/api/sessions/${sessionId}/messages/${assistantMsgId}`, {
                method: "DELETE",
                credentials: "include",
              });
            } catch { /* best effort */ }
          }
          return;
        }
        onError?.(error instanceof Error ? error.message : "Unknown error");
      } finally {
        setIsStreaming(false);
        setThinkingStatus(null);
        abortRef.current = null;
      }
    },
    [sessionId, onMessage, onUserMessageId, onDone, onTitleGenerated, onThinking, onError]
  );

  const regenerate = useCallback(
    async (messageId: string) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setIsStreaming(true);
      setStreamedContent("");
      setThinkingStatus(null);
      let fullContent = "";
      let assistantMsgId: string | null = null;

      try {
        const response = await fetch("/api/chat/regenerate", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, messageId }),
          signal: controller.signal,
        });

        if (!response.ok) throw new Error("Failed to regenerate");

        await readStream(response, {
          onThinking: (status) => {
            setThinkingStatus(status);
            onThinking?.(status);
          },
          onDelta: (delta) => {
            setThinkingStatus(null);
            fullContent += delta;
            setStreamedContent(fullContent);
            onMessage?.(fullContent);
          },
          onAssistantMessageId: (id) => { assistantMsgId = id; },
          onDone: (msgId) => {
            assistantMsgId = msgId;
            setThinkingStatus(null);
            onDone?.(msgId);
          },
          onError,
        }, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) {
          if (assistantMsgId) {
            try {
              await fetch(`/api/sessions/${sessionId}/messages/${assistantMsgId}`, {
                method: "DELETE",
                credentials: "include",
              });
            } catch { /* best effort */ }
          }
          return;
        }
        onError?.(error instanceof Error ? error.message : "Unknown error");
      } finally {
        setIsStreaming(false);
        setThinkingStatus(null);
        abortRef.current = null;
      }
    },
    [sessionId, onMessage, onDone, onThinking, onError]
  );

  return { sendMessage, regenerate, stopGeneration, isStreaming, thinkingStatus, streamedContent };
}
