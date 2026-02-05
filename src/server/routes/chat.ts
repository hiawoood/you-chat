import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  getChatSession, createMessage, getMessages, updateChatSession,
  deleteMessagesAfter, getMessage,
  createStreamingMessage, updateStreamingContent, completeStreamingMessage,
} from "../db";
import { streamYouChat, callYouChat } from "../lib/you-client";

const SAVE_INTERVAL_MS = 1000; // Save to DB every second during streaming

const chat = new Hono();

// Helper: build consolidated conversation context from message history
function buildContext(history: { role: string; content: string }[]): string {
  const consolidated: { role: string; content: string }[] = [];
  for (const msg of history) {
    const last = consolidated[consolidated.length - 1];
    if (last && last.role === msg.role) {
      last.content += "\n" + msg.content;
    } else {
      consolidated.push({ role: msg.role, content: msg.content });
    }
  }
  return consolidated
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
}

// Helper: stream from You.com, save progressively, and pipe to SSE client
async function streamAndSave(
  fullInput: string,
  agent: string,
  assistantMsgId: string,
  onDelta?: (delta: string) => Promise<void>,
): Promise<string> {
  let fullResponse = "";
  let lastSaveTime = Date.now();

  for await (const delta of streamYouChat(fullInput, agent)) {
    fullResponse += delta;

    // Save to DB periodically
    const now = Date.now();
    if (now - lastSaveTime > SAVE_INTERVAL_MS) {
      updateStreamingContent(assistantMsgId, fullResponse);
      lastSaveTime = now;
    }

    // Try to send to client (may fail if disconnected)
    try {
      await onDelta?.(delta);
    } catch {
      // Client disconnected, keep going to save to DB
    }
  }

  // Final save with complete status
  completeStreamingMessage(assistantMsgId, fullResponse);
  return fullResponse;
}

chat.post("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

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

  // Build context
  const history = getMessages(sessionId) as { role: string; content: string }[];
  const fullInput = buildContext(history) || message;

  // Create assistant message in "streaming" state immediately
  const assistantMsg = createStreamingMessage(sessionId, "assistant");

  return streamSSE(c, async (stream) => {
    try {
      // Send real user message ID and assistant message ID
      await stream.writeSSE({ data: JSON.stringify({ userMessageId: userMsg.id, assistantMessageId: assistantMsg.id }) });

      // Stream, save progressively, and send deltas to client
      await streamAndSave(fullInput, session.agent, assistantMsg.id, async (delta) => {
        await stream.writeSSE({ data: JSON.stringify({ delta }) });
      });

      // Auto-generate title if first message
      let generatedTitle: string | undefined;
      if (isFirstMessage && session.title === "untitled") {
        try {
          const titlePrompt = `Generate a very short title (3-6 words max) for a conversation that starts with this message. Reply with ONLY the title, no quotes or punctuation:\n\n${message}`;
          const title = await callYouChat(titlePrompt, "express");
          generatedTitle = title.trim().slice(0, 60);
          if (generatedTitle) {
            updateChatSession(sessionId, user.id, { title: generatedTitle });
          }
        } catch (e) {
          console.error("Failed to generate title:", e);
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
    }
  });
});

// Regenerate from a specific message
chat.post("/regenerate", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

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

  const history = getMessages(sessionId) as { role: string; content: string }[];
  const fullInput = buildContext(history);

  const assistantMsg = createStreamingMessage(sessionId, "assistant");

  return streamSSE(c, async (stream) => {
    try {
      await stream.writeSSE({ data: JSON.stringify({ assistantMessageId: assistantMsg.id }) });

      await streamAndSave(fullInput, session.agent, assistantMsg.id, async (delta) => {
        await stream.writeSSE({ data: JSON.stringify({ delta }) });
      });

      await stream.writeSSE({
        data: JSON.stringify({ done: true, messageId: assistantMsg.id }),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      try {
        await stream.writeSSE({ data: JSON.stringify({ error: errorMessage }) });
      } catch { /* client gone */ }
    }
  });
});

export default chat;
