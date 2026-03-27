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
  ensureSessionNarratorSpeaker,
  getSelectedTtsVoiceReferenceId,
  getTtsVoiceReference,
  updateSessionYouChatId,
  getSessionTtsSpeakerMapping,
  listSessionTtsSpeakerMappings,
  rebuildSessionTtsSpeakerMappings,
  updateSessionTtsSpeakerHidden,
  updateSessionTtsSpeakerVoice,
  getUserCredentials,
  messageExistsInSession,
} from "../db";
import { deleteThread } from "../lib/you-client";
import type { AppEnv } from "../context";

const sessions = new Hono<AppEnv>();

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
  const sessionId = c.req.param("id");

  if (body.lastTtsMessageId !== undefined && body.lastTtsMessageId !== null) {
    const messageExists = messageExistsInSession(sessionId, body.lastTtsMessageId);
    if (!messageExists) {
      return c.json({ error: "Last played TTS message not found in session" }, 404);
    }
  }

  const session = updateChatSession(sessionId, user.id, body);
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
        await deleteThread(youChatId, creds.ds_cookie, creds.dsr_cookie, creds.uuid_guest);
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

sessions.get("/:id/tts-speakers", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const sessionId = c.req.param("id");
  const session = getChatSession(sessionId, user.id);
  if (!session) return c.json({ error: "Not found" }, 404);

  ensureSessionNarratorSpeaker(sessionId);
  rebuildSessionTtsSpeakerMappings(sessionId);
  const selectedVoiceId = getSelectedTtsVoiceReferenceId(user.id);
  const selectedVoice = selectedVoiceId ? getTtsVoiceReference(user.id, selectedVoiceId) : null;
  const speakers = listSessionTtsSpeakerMappings(sessionId).map((speaker) => {
    const validVoiceReferenceId = speaker.voice_reference_id && getTtsVoiceReference(user.id, speaker.voice_reference_id)
      ? speaker.voice_reference_id
      : null;

    if (speaker.voice_reference_id && !validVoiceReferenceId) {
      updateSessionTtsSpeakerVoice(sessionId, speaker.speaker_key, null);
    }

    return {
      speakerKey: speaker.speaker_key,
      speakerLabel: speaker.speaker_label,
      voiceReferenceId: validVoiceReferenceId,
      hidden: Boolean(speaker.hidden),
    };
  });

  return c.json({
    speakers,
    defaultVoiceReferenceId: selectedVoice?.id ?? null,
  });
});

sessions.patch("/:id/tts-speakers/:speakerKey", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const sessionId = c.req.param("id");
  const speakerKey = c.req.param("speakerKey");
  const session = getChatSession(sessionId, user.id);
  if (!session) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{ voiceReferenceId?: string | null; hidden?: boolean }>();
  if (body.voiceReferenceId === undefined && body.hidden === undefined) {
    return c.json({ error: "No speaker update provided" }, 400);
  }
  if (body.voiceReferenceId !== undefined && body.voiceReferenceId !== null && typeof body.voiceReferenceId !== "string") {
    return c.json({ error: "voiceReferenceId must be a string or null" }, 400);
  }
  if (body.hidden !== undefined && typeof body.hidden !== "boolean") {
    return c.json({ error: "hidden must be a boolean" }, 400);
  }

  const current = getSessionTtsSpeakerMapping(sessionId, speakerKey);
  if (!current) {
    return c.json({ error: "Speaker mapping not found" }, 404);
  }

  const voiceReferenceId = typeof body.voiceReferenceId === "string" && body.voiceReferenceId.trim()
    ? body.voiceReferenceId
    : null;
  if (body.voiceReferenceId !== undefined && voiceReferenceId) {
    const voice = getTtsVoiceReference(user.id, voiceReferenceId);
    if (!voice) {
      return c.json({ error: "Voice reference not found" }, 404);
    }
  }

  let updated = current;
  if (body.voiceReferenceId !== undefined) {
    const next = updateSessionTtsSpeakerVoice(sessionId, speakerKey, voiceReferenceId);
    if (!next) {
      return c.json({ error: "Speaker mapping not found" }, 404);
    }
    updated = next;
  }

  if (body.hidden !== undefined) {
    const next = updateSessionTtsSpeakerHidden(sessionId, speakerKey, Boolean(body.hidden));
    if (!next) {
      return c.json({ error: "Speaker mapping not found" }, 404);
    }
    updated = next;
  }

  return c.json({
    success: true,
    speaker: {
      speakerKey: updated.speaker_key,
      speakerLabel: updated.speaker_label,
      voiceReferenceId: updated.voice_reference_id,
      hidden: Boolean(updated.hidden),
    },
  });
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

  // Invalidate You.com thread — edited history means the old thread context is stale.
  // Next chat request will create a fresh thread with the corrected history.
  const oldYouChatId = getSessionYouChatId(sessionId);
  if (oldYouChatId) {
    const creds = getUserCredentials(user.id);
    if (creds) {
      deleteThread(oldYouChatId, creds.ds_cookie, creds.dsr_cookie, creds.uuid_guest).catch(() => {});
    }
    updateSessionYouChatId(sessionId, "");
  }

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

  // Invalidate You.com thread — history changed, old thread context is stale
  const oldYouChatId = getSessionYouChatId(sessionId);
  if (oldYouChatId) {
    const creds = getUserCredentials(user.id);
    if (creds) {
      deleteThread(oldYouChatId, creds.ds_cookie, creds.dsr_cookie, creds.uuid_guest).catch(() => {});
    }
    updateSessionYouChatId(sessionId, "");
  }

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
