import { useState, useCallback, useRef, startTransition } from "react";

interface UseChatOptions {
  sessionId: string;
  onMessage?: (content: string) => void;
  onUserMessageId?: (realId: string) => void;
  onAssistantMessageId?: (realId: string) => void;
  onDone?: (messageId: string) => void;
  onTitleGenerated?: (title: string) => void;
  onThinking?: (status: string) => void;
  onError?: (error: string) => void;
}

interface CompactOptions {
  messageId: string;
  prompt: string;
  agentOrModel: string;
  onMessage?: (content: string) => void;
  onDone?: (content: string) => void;
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
      const data = await fetchMessageSnapshot(messageId, signal);
      if (!data) {
        callbacks.onError?.("Polling failed");
        return;
      }

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

async function fetchMessageSnapshot(messageId: string, signal?: AbortSignal): Promise<{ content: string; status: string } | null> {
  const res = await fetch(`/api/chat/poll/${messageId}`, { credentials: "include", signal });
  if (!res.ok) {
    return null;
  }

  return res.json();
}

export function useChat({ sessionId, onMessage, onUserMessageId, onAssistantMessageId, onDone, onTitleGenerated, onThinking, onError }: UseChatOptions) {
  const STREAM_STALL_TIMEOUT_MS = 5000;
  const [isStreaming, setIsStreaming] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [thinkingStatus, setThinkingStatus] = useState<string | null>(null);
  const [streamedContent, setStreamedContent] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const pendingStreamContentRef = useRef("");
  const streamContentFrameRef = useRef<number | null>(null);

  const emitStreamContent = useCallback((content: string) => {
    startTransition(() => {
      setStreamedContent((current) => current === content ? current : content);
    });
    onMessage?.(content);
  }, [onMessage]);

  const flushPendingStreamContent = useCallback(() => {
    if (streamContentFrameRef.current !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(streamContentFrameRef.current);
      streamContentFrameRef.current = null;
    }

    emitStreamContent(pendingStreamContentRef.current);
  }, [emitStreamContent]);

  const scheduleStreamContent = useCallback((content: string) => {
    if (pendingStreamContentRef.current === content) {
      return;
    }

    pendingStreamContentRef.current = content;
    if (typeof window === "undefined") {
      emitStreamContent(content);
      return;
    }

    if (streamContentFrameRef.current !== null) {
      return;
    }

    streamContentFrameRef.current = window.requestAnimationFrame(() => {
      streamContentFrameRef.current = null;
      emitStreamContent(pendingStreamContentRef.current);
    });
  }, [emitStreamContent]);

  const resetStreamContent = useCallback(() => {
    pendingStreamContentRef.current = "";
    if (streamContentFrameRef.current !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(streamContentFrameRef.current);
      streamContentFrameRef.current = null;
    }
    startTransition(() => {
      setStreamedContent("");
    });
  }, []);

  const stopGeneration = useCallback(async () => {
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
      resetStreamContent();
      setThinkingStatus(null);
      let fullContent = "";
      let assistantMsgId: string | null = null;
      let streamCompleted = false;
      let didFinish = false;
      let streamStalled = false;
      let stallTimer: ReturnType<typeof setTimeout> | null = null;

      const clearStallTimer = () => {
        if (stallTimer !== null) {
          clearTimeout(stallTimer);
          stallTimer = null;
        }
      };

      const scheduleStallTimer = () => {
        clearStallTimer();
        stallTimer = setTimeout(() => {
          if (!assistantMsgId || streamCompleted || controller.signal.aborted) {
            return;
          }

          streamStalled = true;
          controller.abort();
        }, STREAM_STALL_TIMEOUT_MS);
      };

      const applyStreamContent = (content: string) => {
        if (content === fullContent) return;
        fullContent = content;
        scheduleStreamContent(content);
      };

      const finishStream = (messageId: string, generatedTitle?: string) => {
        if (didFinish) return;
        didFinish = true;
        streamCompleted = true;
        clearStallTimer();
        flushPendingStreamContent();
        setThinkingStatus(null);
        onDone?.(messageId);
        if (generatedTitle) onTitleGenerated?.(generatedTitle);
      };

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, message }),
          signal: controller.signal,
        });

        if (!response.ok) throw new Error("Failed to send message");

        scheduleStallTimer();

        await readStream(response, {
          onThinking: (status) => {
            scheduleStallTimer();
            setThinkingStatus(status);
            onThinking?.(status);
          },
          onDelta: (delta) => {
            scheduleStallTimer();
            setThinkingStatus(null);
            applyStreamContent(fullContent + delta);
          },
          onUserMessageId,
          onAssistantMessageId: (id) => {
            scheduleStallTimer();
            assistantMsgId = id;
            onAssistantMessageId?.(id);
          },
          onDone: (messageId, generatedTitle) => {
            assistantMsgId = messageId;
            finishStream(messageId, generatedTitle);
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
              applyStreamContent(content);
            },
            onDone: (msgId) => {
              finishStream(msgId);
            },
            onError,
          }, controller.signal);
        }
      } catch (error) {
        if (controller.signal.aborted && !streamStalled) return; // Server handles cleanup
        // Network error on initial fetch or during stream — try polling if we have assistant msg ID
        if (assistantMsgId && !controller.signal.aborted) {
          console.log("[useChat] Error during stream, falling back to polling", assistantMsgId);
          setThinkingStatus("Reconnecting…");
          await pollUntilDone(assistantMsgId, {
            onContent: (content) => {
              setThinkingStatus(null);
              applyStreamContent(content);
            },
            onDone: (msgId) => {
              finishStream(msgId);
            },
            onError,
          }, controller.signal);
        } else if (assistantMsgId && streamStalled) {
          console.log("[useChat] Stream stalled, falling back to polling", assistantMsgId);
          const pollingController = new AbortController();
          abortRef.current = pollingController;
          setThinkingStatus("Reconnecting…");
          await pollUntilDone(assistantMsgId, {
            onContent: (content) => {
              setThinkingStatus(null);
              applyStreamContent(content);
            },
            onDone: (msgId) => {
              finishStream(msgId);
            },
            onError,
          }, pollingController.signal);
        } else {
          onError?.(error instanceof Error ? error.message : "Unknown error");
        }
      } finally {
        clearStallTimer();
        setIsStreaming(false);
        resetStreamContent();
        setThinkingStatus(null);
        abortRef.current = null;
      }
    },
    [flushPendingStreamContent, onAssistantMessageId, onDone, onError, onThinking, onTitleGenerated, onUserMessageId, resetStreamContent, scheduleStreamContent, sessionId]
  );

  const regenerate = useCallback(
    async (messageId: string) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setIsStreaming(true);
      resetStreamContent();
      setThinkingStatus(null);
      let fullContent = "";
      let regenCompleted = false;
      let regenMsgId: string | null = null;
      let didFinish = false;
      let streamStalled = false;
      let stallTimer: ReturnType<typeof setTimeout> | null = null;

      const clearStallTimer = () => {
        if (stallTimer !== null) {
          clearTimeout(stallTimer);
          stallTimer = null;
        }
      };

      const scheduleStallTimer = () => {
        clearStallTimer();
        stallTimer = setTimeout(() => {
          if (!regenMsgId || regenCompleted || controller.signal.aborted) {
            return;
          }

          streamStalled = true;
          controller.abort();
        }, STREAM_STALL_TIMEOUT_MS);
      };

      const applyStreamContent = (content: string) => {
        if (content === fullContent) return;
        fullContent = content;
        scheduleStreamContent(content);
      };

      const finishRegeneration = (nextMessageId: string) => {
        if (didFinish) return;
        didFinish = true;
        regenCompleted = true;
        clearStallTimer();
        flushPendingStreamContent();
        setThinkingStatus(null);
        onDone?.(nextMessageId);
      };

      try {
        const response = await fetch("/api/chat/regenerate", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, messageId }),
          signal: controller.signal,
        });

        if (!response.ok) throw new Error("Failed to regenerate");

        scheduleStallTimer();

        await readStream(response, {
          onThinking: (status) => {
            scheduleStallTimer();
            setThinkingStatus(status);
            onThinking?.(status);
          },
          onDelta: (delta) => {
            scheduleStallTimer();
            setThinkingStatus(null);
            applyStreamContent(fullContent + delta);
          },
          onAssistantMessageId: (id) => {
            scheduleStallTimer();
            regenMsgId = id;
            onAssistantMessageId?.(id);
          },
          onDone: (msgId) => {
            finishRegeneration(msgId);
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
              applyStreamContent(content);
            },
            onDone: (msgId) => {
              finishRegeneration(msgId);
            },
            onError,
          }, controller.signal);
        }
      } catch (error) {
        if (controller.signal.aborted && !streamStalled) return;

        if (regenMsgId && streamStalled) {
          console.log("[useChat] Regenerate stream stalled, polling", regenMsgId);
          const pollingController = new AbortController();
          abortRef.current = pollingController;
          setThinkingStatus("Reconnecting…");
          await pollUntilDone(regenMsgId, {
            onContent: (content) => {
              setThinkingStatus(null);
              applyStreamContent(content);
            },
            onDone: (msgId) => {
              finishRegeneration(msgId);
            },
            onError,
          }, pollingController.signal);
          return;
        }

        if (regenMsgId && !controller.signal.aborted) {
          console.log("[useChat] Regenerate stream error, polling", regenMsgId);
          setThinkingStatus("Reconnecting…");
          await pollUntilDone(regenMsgId, {
            onContent: (content) => {
              setThinkingStatus(null);
              applyStreamContent(content);
            },
            onDone: (msgId) => {
              finishRegeneration(msgId);
            },
            onError,
          }, controller.signal);
          return;
        }

        onError?.(error instanceof Error ? error.message : "Unknown error");
      } finally {
        clearStallTimer();
        setIsStreaming(false);
        resetStreamContent();
        setThinkingStatus(null);
        abortRef.current = null;
      }
    },
    [flushPendingStreamContent, onAssistantMessageId, onDone, onError, onThinking, resetStreamContent, scheduleStreamContent, sessionId]
  );

  const compactMessage = useCallback(
    async ({
      messageId,
      prompt,
      agentOrModel,
      onMessage: onCompactMessage,
      onDone: onCompactDone,
    }: CompactOptions) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setIsCompacting(true);
      let fullContent = "";

      return (async () => {
        try {
          const response = await fetch("/api/chat/compact", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId,
              messageId,
              prompt,
              agentOrModel,
            }),
            signal: controller.signal,
          });

          if (!response.ok) throw new Error("Failed to compact message");

          let compactCompleted = false;

          await readStream(
            response,
            {
              onThinking: (status) => {
                setThinkingStatus(status);
              },
              onDelta: (delta) => {
                setThinkingStatus(null);
                fullContent += delta;
                onCompactMessage?.(fullContent);
              },
              onDone: () => {
                compactCompleted = true;
                setThinkingStatus(null);
                onCompactDone?.(fullContent);
              },
              onError: (error) => {
                compactCompleted = true;
                onError?.(error);
              },
            },
            controller.signal,
          );

          if (!compactCompleted && !controller.signal.aborted) {
            // No DB-backed fallback for compact; stream was interrupted mid-flight
            // and we already have the best-known partial content.
            onCompactDone?.(fullContent);
          }

          return fullContent;
        } catch (error) {
          if (controller.signal.aborted) return fullContent;
          const message = error instanceof Error ? error.message : "Unknown error";
          onError?.(message);
          return fullContent;
        } finally {
          setIsCompacting(false);
          setThinkingStatus(null);
          if (abortRef.current === controller) {
            abortRef.current = null;
          }
        }
      })();
    },
    [onError, sessionId],
  );

  return {
    sendMessage,
    regenerate,
    compactMessage,
    stopGeneration,
    isStreaming,
    isCompacting,
    thinkingStatus,
    streamedContent,
  };
}
