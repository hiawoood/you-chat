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

// Poll a message until it's complete (fallback when SSE stream disconnects)
async function pollUntilDone(
  messageId: string,
  callbacks: {
    onContent?: (content: string) => void;
    onDone?: (messageId: string) => void;
    onError?: (error: string) => void;
  },
  signal?: AbortSignal,
) {
  const POLL_INTERVAL = 1500;
  let lastContent = "";

  while (!signal?.aborted) {
    try {
      const res = await fetch(`/api/chat/poll/${messageId}`, { credentials: "include", signal });
      if (!res.ok) {
        callbacks.onError?.("Polling failed");
        return;
      }
      const data = await res.json();

      if (data.content && data.content !== lastContent) {
        lastContent = data.content;
        callbacks.onContent?.(data.content);
      }

      if (data.status !== "streaming") {
        callbacks.onDone?.(messageId);
        return;
      }
    } catch (err) {
      if (signal?.aborted) return;
      // Network error during poll — retry after interval
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

export function useChat({ sessionId, onMessage, onUserMessageId, onDone, onTitleGenerated, onThinking, onError }: UseChatOptions) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [thinkingStatus, setThinkingStatus] = useState<string | null>(null);
  const [streamedContent, setStreamedContent] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const stopGeneration = useCallback(async () => {
    // Tell server to abort the You.com stream
    try {
      await fetch("/api/chat/stop", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
    } catch { /* best effort */ }

    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, [sessionId]);

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

        let streamCompleted = false;

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
            streamCompleted = true;
            assistantMsgId = messageId;
            setThinkingStatus(null);
            onDone?.(messageId);
            if (generatedTitle) onTitleGenerated?.(generatedTitle);
          },
          onError: (err) => {
            streamCompleted = true;
            onError?.(err);
          },
        }, controller.signal);

        // If stream ended without a done/error event and we have an assistant message ID,
        // the connection was lost — fall back to polling
        if (!streamCompleted && assistantMsgId && !controller.signal.aborted) {
          console.log("[useChat] Stream disconnected, falling back to polling", assistantMsgId);
          setThinkingStatus("Reconnecting…");
          await pollUntilDone(assistantMsgId, {
            onContent: (content) => {
              setThinkingStatus(null);
              fullContent = content;
              setStreamedContent(content);
              onMessage?.(content);
            },
            onDone: (msgId) => {
              setThinkingStatus(null);
              onDone?.(msgId);
            },
            onError,
          }, controller.signal);
        }
      } catch (error) {
        if (controller.signal.aborted) return; // Server handles cleanup
        // Network error on initial fetch or during stream — try polling if we have assistant msg ID
        if (assistantMsgId && !controller.signal.aborted) {
          console.log("[useChat] Error during stream, falling back to polling", assistantMsgId);
          setThinkingStatus("Reconnecting…");
          await pollUntilDone(assistantMsgId, {
            onContent: (content) => {
              setThinkingStatus(null);
              fullContent = content;
              setStreamedContent(content);
              onMessage?.(content);
            },
            onDone: (msgId) => {
              setThinkingStatus(null);
              onDone?.(msgId);
            },
            onError,
          }, controller.signal);
        } else {
          onError?.(error instanceof Error ? error.message : "Unknown error");
        }
      } finally {
        setIsStreaming(false);
        setStreamedContent("");
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

      try {
        const response = await fetch("/api/chat/regenerate", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, messageId }),
          signal: controller.signal,
        });

        if (!response.ok) throw new Error("Failed to regenerate");

        let regenCompleted = false;
        let regenMsgId: string | null = null;

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
          onAssistantMessageId: (id) => { regenMsgId = id; },
          onDone: (msgId) => {
            regenCompleted = true;
            setThinkingStatus(null);
            onDone?.(msgId);
          },
          onError: (err) => {
            regenCompleted = true;
            onError?.(err);
          },
        }, controller.signal);

        // Fall back to polling if stream disconnected
        if (!regenCompleted && regenMsgId && !controller.signal.aborted) {
          console.log("[useChat] Regenerate stream disconnected, polling", regenMsgId);
          setThinkingStatus("Reconnecting…");
          await pollUntilDone(regenMsgId, {
            onContent: (content) => {
              setThinkingStatus(null);
              fullContent = content;
              setStreamedContent(content);
              onMessage?.(content);
            },
            onDone: (msgId) => {
              setThinkingStatus(null);
              onDone?.(msgId);
            },
            onError,
          }, controller.signal);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        onError?.(error instanceof Error ? error.message : "Unknown error");
      } finally {
        setIsStreaming(false);
        setStreamedContent("");
        setThinkingStatus(null);
        abortRef.current = null;
      }
    },
    [sessionId, onMessage, onDone, onThinking, onError]
  );

  return { sendMessage, regenerate, stopGeneration, isStreaming, thinkingStatus, streamedContent };
}
