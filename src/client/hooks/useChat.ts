import { useState, useCallback, useRef } from "react";

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
  const [isStreaming, setIsStreaming] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [thinkingStatus, setThinkingStatus] = useState<string | null>(null);
  const [streamedContent, setStreamedContent] = useState("");
  const abortRef = useRef<AbortController | null>(null);

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
      setStreamedContent("");
      setThinkingStatus(null);
      let fullContent = "";
      let assistantMsgId: string | null = null;
      let streamCompleted = false;
      let didFinish = false;
      let mirrorPollingStarted = false;

      const applyStreamContent = (content: string) => {
        if (content === fullContent) return;
        fullContent = content;
        setStreamedContent(content);
        onMessage?.(content);
      };

      const finishStream = (messageId: string, generatedTitle?: string) => {
        if (didFinish) return;
        didFinish = true;
        streamCompleted = true;
        setThinkingStatus(null);
        onDone?.(messageId);
        if (generatedTitle) onTitleGenerated?.(generatedTitle);
      };

      const startMirrorPolling = (messageId: string) => {
        if (mirrorPollingStarted) return;
        mirrorPollingStarted = true;

        void (async () => {
          const POLL_INTERVAL = 1500;

          while (!controller.signal.aborted && !streamCompleted) {
            try {
              const snapshot = await fetchMessageSnapshot(messageId, controller.signal);
              if (snapshot) {
                if (snapshot.content) {
                  setThinkingStatus(null);
                  applyStreamContent(snapshot.content);
                }

                if (snapshot.status !== "streaming") {
                  finishStream(messageId);
                  return;
                }
              }
            } catch {
              if (controller.signal.aborted) return;
            }

            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
          }
        })();
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

        await readStream(response, {
          onThinking: (status) => {
            setThinkingStatus(status);
            onThinking?.(status);
          },
          onDelta: (delta) => {
            setThinkingStatus(null);
            applyStreamContent(fullContent + delta);
          },
          onUserMessageId,
          onAssistantMessageId: (id) => {
            assistantMsgId = id;
            onAssistantMessageId?.(id);
            startMirrorPolling(id);
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
        if (controller.signal.aborted) return; // Server handles cleanup
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
    [sessionId, onAssistantMessageId, onMessage, onUserMessageId, onDone, onTitleGenerated, onThinking, onError]
  );

  const regenerate = useCallback(
    async (messageId: string) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setIsStreaming(true);
      setStreamedContent("");
      setThinkingStatus(null);
      let fullContent = "";
      let regenCompleted = false;
      let regenMsgId: string | null = null;
      let didFinish = false;
      let mirrorPollingStarted = false;

      const applyStreamContent = (content: string) => {
        if (content === fullContent) return;
        fullContent = content;
        setStreamedContent(content);
        onMessage?.(content);
      };

      const finishRegeneration = (nextMessageId: string) => {
        if (didFinish) return;
        didFinish = true;
        regenCompleted = true;
        setThinkingStatus(null);
        onDone?.(nextMessageId);
      };

      const startMirrorPolling = (nextMessageId: string) => {
        if (mirrorPollingStarted) return;
        mirrorPollingStarted = true;

        void (async () => {
          const POLL_INTERVAL = 1500;

          while (!controller.signal.aborted && !regenCompleted) {
            try {
              const snapshot = await fetchMessageSnapshot(nextMessageId, controller.signal);
              if (snapshot) {
                if (snapshot.content) {
                  setThinkingStatus(null);
                  applyStreamContent(snapshot.content);
                }

                if (snapshot.status !== "streaming") {
                  finishRegeneration(nextMessageId);
                  return;
                }
              }
            } catch {
              if (controller.signal.aborted) return;
            }

            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
          }
        })();
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

        await readStream(response, {
          onThinking: (status) => {
            setThinkingStatus(status);
            onThinking?.(status);
          },
          onDelta: (delta) => {
            setThinkingStatus(null);
            applyStreamContent(fullContent + delta);
          },
          onAssistantMessageId: (id) => {
            regenMsgId = id;
            onAssistantMessageId?.(id);
            startMirrorPolling(id);
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
        if (controller.signal.aborted) return;
        onError?.(error instanceof Error ? error.message : "Unknown error");
      } finally {
        setIsStreaming(false);
        setStreamedContent("");
        setThinkingStatus(null);
        abortRef.current = null;
      }
    },
    [sessionId, onAssistantMessageId, onMessage, onDone, onThinking, onError]
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
