import { Hono } from "hono";
import {
  getChatSessions,
  getChatSession,
  createChatSession,
  updateChatSession,
  deleteChatSession,
  getMessages,
  updateMessage,
  deleteMessage,
  getMessage,
  forkSession,
  getSessionYouChatId,
  getUserCredentials,
} from "../db";
import { deleteThread } from "../lib/you-client";

const sessions = new Hono();

// List all sessions for user
sessions.get("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const chatSessions = getChatSessions(user.id);
  return c.json(chatSessions);
});

// Create new session
sessions.post("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json().catch(() => ({}));
  const session = createChatSession(user.id, body.title, body.agent);
  return c.json(session, 201);
});

// Get single session
sessions.get("/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const session = getChatSession(c.req.param("id"), user.id);
  if (!session) return c.json({ error: "Not found" }, 404);

  return c.json(session);
});

// Update session
sessions.patch("/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json();
  const session = updateChatSession(c.req.param("id"), user.id, body);
  if (!session) return c.json({ error: "Not found" }, 404);

  return c.json(session);
});

// Delete session
sessions.delete("/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const sessionId = c.req.param("id");

  // Also delete the You.com thread if one exists
  const youChatId = getSessionYouChatId(sessionId);
  console.log(`[delete-session] session=${sessionId} youChatId=${youChatId}`);
  if (youChatId) {
    const creds = getUserCredentials(user.id);
    if (creds) {
      try {
        await deleteThread(youChatId, creds.ds_cookie, creds.dsr_cookie, creds.all_cookies);
        console.log(`[delete-session] You.com thread ${youChatId} deleted`);
      } catch (e) {
        console.error(`[delete-session] Failed to delete You.com thread ${youChatId}:`, e);
      }
    } else {
      console.warn(`[delete-session] No credentials found for user ${user.id}`);
    }
  }

  deleteChatSession(sessionId, user.id);
  return c.json({ success: true });
});

// Get messages for session
sessions.get("/:id/messages", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const session = getChatSession(c.req.param("id"), user.id);
  if (!session) return c.json({ error: "Not found" }, 404);

  const messages = getMessages(c.req.param("id"));
  return c.json(messages);
});

// Get a single message (for polling streaming status)
sessions.get("/:id/messages/:messageId", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const session = getChatSession(c.req.param("id"), user.id);
  if (!session) return c.json({ error: "Not found" }, 404);

  const msg = getMessage(c.req.param("messageId"), c.req.param("id"));
  if (!msg) return c.json({ error: "Message not found" }, 404);

  return c.json(msg);
});

// Edit a message
sessions.patch("/:id/messages/:messageId", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const sessionId = c.req.param("id");
  const messageId = c.req.param("messageId");
  const { content } = await c.req.json();

  if (!content || typeof content !== "string") {
    return c.json({ error: "content is required" }, 400);
  }

  const session = getChatSession(sessionId, user.id);
  if (!session) return c.json({ error: "Not found" }, 404);

  const updated = updateMessage(messageId, sessionId, content);
  if (!updated) return c.json({ error: "Message not found" }, 404);

  return c.json(updated);
});

// Delete a message
sessions.delete("/:id/messages/:messageId", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const sessionId = c.req.param("id");
  const messageId = c.req.param("messageId");

  // Verify session belongs to user
  const session = getChatSession(sessionId, user.id);
  if (!session) return c.json({ error: "Not found" }, 404);

  // Delete the message
  deleteMessage(messageId, sessionId);
  return c.json({ success: true });
});

// Fork a session up to a specific message
sessions.post("/:id/fork", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const sessionId = c.req.param("id");
  const { messageId } = await c.req.json();

  if (!messageId) return c.json({ error: "messageId is required" }, 400);

  const result = forkSession(sessionId, user.id, messageId);
  if (!result) return c.json({ error: "Not found" }, 404);

  return c.json(result.session, 201);
});

export default sessions;
