import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  getChatSession, createMessage, getMessages, updateChatSession,
  deleteMessagesAfter, getMessage,
  createStreamingMessage, updateStreamingContent, completeStreamingMessage,
  getUserCredentials, getSessionYouChatId, updateSessionYouChatId,
} from "../db";
import { streamChat, callChat, deleteThread } from "../lib/you-client";
import type { StreamEvent } from "../lib/you-client";

const SAVE_INTERVAL_MS = 1000;

// Active streaming sessions — allows server-side abort when user clicks "Stop"
const activeStreams = new Map<string, AbortController>();

const chat = new Hono();

// Stop generation endpoint
chat.post("/stop", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const { sessionId } = await c.req.json();
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);

  const controller = activeStreams.get(sessionId);
  if (controller) {
    controller.abort();
    activeStreams.delete(sessionId);
  }

  return c.json({ stopped: true });
});

// Helper: build chat history as Q&A pairs for You.com API
function buildChatHistory(messages: { role: string; content: string }[]): Array<{ question: string; answer: string }> {
  // Build Q&A pairs resilient to gaps from deleted messages.
  // Walks through messages, collecting user→assistant pairs.
  // Consecutive user messages get merged. Orphaned assistant messages are skipped.
  const pairs: Array<{ question: string; answer: string }> = [];
  let pendingQuestion: string | null = null;

  for (const msg of messages) {
    if (msg.role === "user") {
      // If we already have a pending question with no answer, merge them
      if (pendingQuestion !== null) {
        pendingQuestion += "\n\n" + msg.content;
      } else {
        pendingQuestion = msg.content;
      }
    } else if (msg.role === "assistant") {
      if (pendingQuestion !== null) {
        pairs.push({ question: pendingQuestion, answer: msg.content });
        pendingQuestion = null;
      }
      // else: orphaned assistant message (preceding user was deleted) — skip
    }
  }
  // Any trailing pendingQuestion without an answer is excluded (it's the current query)
  return pairs;
}

// Helper: stream from You.com, save progressively, and pipe to SSE client
async function streamAndSave(
  options: {
    query: string;
    chatHistory: Array<{ question: string; answer: string }>;
    chatId: string;
    agentOrModel: string;
    dsCookie: string;
    dsrCookie: string;
    pastChatLength: number;
  },
  assistantMsgId: string,
  onEvent?: (event: StreamEvent) => Promise<void>,
  abortSignal?: AbortSignal,
): Promise<string> {
  let fullResponse = "";
  let lastSaveTime = Date.now();

  try {
    for await (const event of streamChat(options)) {
      // Check if stop was requested
      if (abortSignal?.aborted) break;

      if (event.type === "token") {
        fullResponse += event.text;

        const now = Date.now();
        if (now - lastSaveTime > SAVE_INTERVAL_MS) {
          updateStreamingContent(assistantMsgId, fullResponse);
          lastSaveTime = now;
        }
      }

      try {
        await onEvent?.(event);
      } catch {
        // Client disconnected (e.g. refresh) — keep going to save to DB
      }
    }
  } finally {
    // Always mark as complete, even on error — prevents stuck "streaming" messages
    completeStreamingMessage(assistantMsgId, fullResponse);
  }

  return fullResponse;
}

chat.post("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  // Get user's You.com credentials
  const creds = getUserCredentials(user.id);
  if (!creds) {
    return c.json({ error: "You.com credentials required" }, 403);
  }

  const { sessionId, message } = await c.req.json();
  if (!sessionId || !message) {
    return c.json({ error: "sessionId and message required" }, 400);
  }

  const session = getChatSession(sessionId, user.id) as { id: string; agent: string; title: string } | null;
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const existingMessages = getMessages(sessionId) as { id: string }[];
  const isFirstMessage = existingMessages.length === 0;

  // Save user message
  const userMsg = createMessage(sessionId, "user", message);

  // Build chat history for You.com (Q&A pairs from previous messages, NOT including current)
  const allMessages = getMessages(sessionId) as { role: string; content: string }[];
  const historyMessages = allMessages.slice(0, -1);
  const chatHistory = buildChatHistory(historyMessages);

  // Get or create You.com thread ID
  let youChatId = getSessionYouChatId(sessionId);
  if (!youChatId) {
    youChatId = crypto.randomUUID();
    updateSessionYouChatId(sessionId, youChatId);
  }

  const assistantMsg = createStreamingMessage(sessionId, "assistant");

  // Register abort controller for this session (allows /stop to abort)
  const abortController = new AbortController();
  activeStreams.set(sessionId, abortController);

  return streamSSE(c, async (stream) => {
    try {
      await stream.writeSSE({ data: JSON.stringify({ userMessageId: userMsg.id, assistantMessageId: assistantMsg.id }) });

      // Show thinking indicator while waiting for first token
      await stream.writeSSE({ data: JSON.stringify({ thinking: "Thinking" }) });

      await streamAndSave(
        {
          query: message,
          chatHistory,
          chatId: youChatId!,
          agentOrModel: session.agent,
          dsCookie: creds.ds_cookie,
          dsrCookie: creds.dsr_cookie,
          pastChatLength: chatHistory.length,
        },
        assistantMsg.id,
        async (event) => {
          if (event.type === "thinking") {
            await stream.writeSSE({ data: JSON.stringify({ thinking: event.message }) });
          } else if (event.type === "token") {
            await stream.writeSSE({ data: JSON.stringify({ delta: event.text }) });
          }
        },
        abortController.signal,
      );

      // Auto-generate title if first message
      let generatedTitle: string | undefined;
      if (isFirstMessage && session.title === "untitled") {
        const titleChatId = crypto.randomUUID();
        try {
          const titlePrompt = `Generate a very short title (3-6 words max) for a conversation that starts with this message. Reply with ONLY the title, no quotes or punctuation:\n\n${message}`;
          const title = await callChat({
            query: titlePrompt,
            agentOrModel: "claude_4_5_haiku",
            dsCookie: creds.ds_cookie,
            dsrCookie: creds.dsr_cookie,
            _chatId: titleChatId,
          });
          // Clean raw response: remove quotes, extra whitespace, asterisks
          generatedTitle = title.trim().replace(/^["'*]+|["'*]+$/g, "").trim().slice(0, 60);
          console.log(`[title-gen] raw="${title.trim()}" cleaned="${generatedTitle}"`);
          if (generatedTitle && generatedTitle.length > 0) {
            updateChatSession(sessionId, user.id, { title: generatedTitle });
          }
        } catch (e) {
          console.error("[title-gen] Failed:", e);
        }
        // Always clean up the title generation chat from You.com
        try {
          await deleteThread(titleChatId, creds.ds_cookie, creds.dsr_cookie, creds.uuid_guest);
          console.log(`[title-gen] Cleaned up You.com thread ${titleChatId}`);
        } catch (e) {
          console.error("[title-gen] Cleanup failed:", e);
        }
      }

      await stream.writeSSE({
        data: JSON.stringify({ done: true, messageId: assistantMsg.id, generatedTitle }),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      try {
        await stream.writeSSE({ data: JSON.stringify({ error: errorMessage }) });
      } catch {
        // Client already gone
      }
    } finally {
      activeStreams.delete(sessionId);
    }
  });
});

// Regenerate from a specific message
chat.post("/regenerate", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const creds = getUserCredentials(user.id);
  if (!creds) {
    return c.json({ error: "You.com credentials required" }, 403);
  }

  const { sessionId, messageId } = await c.req.json();
  if (!sessionId || !messageId) {
    return c.json({ error: "sessionId and messageId required" }, 400);
  }

  const session = getChatSession(sessionId, user.id) as { id: string; agent: string } | null;
  if (!session) return c.json({ error: "Session not found" }, 404);

  const targetMsg = getMessage(messageId, sessionId) as { id: string; session_id: string } | null;
  if (!targetMsg) {
    return c.json({ error: "Message not found" }, 404);
  }

  deleteMessagesAfter(messageId, sessionId);

  // Delete old You.com thread and create new one (rebase)
  const oldYouChatId = getSessionYouChatId(sessionId);
  if (oldYouChatId) {
    try {
      await deleteThread(oldYouChatId, creds.ds_cookie, creds.dsr_cookie, creds.uuid_guest);
    } catch (e) {
      console.error("Failed to delete old You.com thread:", e);
    }
  }

  const newYouChatId = crypto.randomUUID();
  updateSessionYouChatId(sessionId, newYouChatId);

  // Build history from remaining messages (includes all up to + including the target user msg)
  const history = getMessages(sessionId) as { role: string; content: string }[];

  // The last user message is the query for regeneration
  const lastUserMsg = history.filter(m => m.role === "user").pop();
  const query = lastUserMsg?.content || "";

  // Build chat history from completed pairs (user+assistant exchanges before the regenerated message)
  // buildChatHistory only creates pairs from consecutive user/assistant messages,
  // so the unpaired last user message is already excluded
  const chatHistory = buildChatHistory(history);

  const assistantMsg = createStreamingMessage(sessionId, "assistant");

  // Register abort controller for this session
  const abortController = new AbortController();
  activeStreams.set(sessionId, abortController);

  return streamSSE(c, async (stream) => {
    try {
      await stream.writeSSE({ data: JSON.stringify({ assistantMessageId: assistantMsg.id }) });

      // Show thinking indicator while waiting for first token
      await stream.writeSSE({ data: JSON.stringify({ thinking: "Thinking" }) });

      await streamAndSave(
        {
          query,
          chatHistory, // all prior pairs — don't slice, the unpaired last user msg is already excluded
          chatId: newYouChatId,
          agentOrModel: session.agent,
          dsCookie: creds.ds_cookie,
          dsrCookie: creds.dsr_cookie,
          pastChatLength: Math.max(0, chatHistory.length),
        },
        assistantMsg.id,
        async (event) => {
          if (event.type === "thinking") {
            await stream.writeSSE({ data: JSON.stringify({ thinking: event.message }) });
          } else if (event.type === "token") {
            await stream.writeSSE({ data: JSON.stringify({ delta: event.text }) });
          }
        },
        abortController.signal,
      );

      await stream.writeSSE({
        data: JSON.stringify({ done: true, messageId: assistantMsg.id }),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      try {
        await stream.writeSSE({ data: JSON.stringify({ error: errorMessage }) });
      } catch { /* client gone */ }
    } finally {
      activeStreams.delete(sessionId);
    }
  });
});

export default chat;
