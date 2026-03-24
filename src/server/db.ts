import { Database } from "bun:sqlite";
import { accessSync, mkdirSync, constants } from "node:fs";
import { dirname } from "node:path";

// Determine DB directory: explicit env > /data (Railway volume) > local ./data
function resolveDbDir(): string {
  if (process.env.DATABASE_DIR) return process.env.DATABASE_DIR;

  // Check if /data exists and is writable (Railway volume mount)
  try {
    accessSync("/data", constants.W_OK);
    return "/data";
  } catch {
    // No volume mounted — warn loudly
    console.warn("⚠️  /data is not writable. Using ./data (NOT persistent across deploys!)");
    console.warn("   Mount a Railway Volume at /data for persistence.");
    return "./data";
  }
}

export const dataDir = resolveDbDir();
const dbPath = process.env.DATABASE_URL || `${dataDir}/you-chat.db`;

// Ensure directory exists
try { mkdirSync(dirname(dbPath), { recursive: true }); } catch {}

console.log(`Database path: ${dbPath}`);
export const db = new Database(dbPath, { create: true });
const tableColumnCache = new Map<string, Set<string>>();

// Enable foreign keys
db.run("PRAGMA foreign_keys = ON");

// Initialize schema
export function initDb() {
  db.run(`
    CREATE TABLE IF NOT EXISTS user (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      emailVerified INTEGER,
      image TEXT,
      createdAt INTEGER,
      updatedAt INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      expiresAt INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      createdAt INTEGER,
      updatedAt INTEGER,
      ipAddress TEXT,
      userAgent TEXT,
      userId TEXT NOT NULL,
      FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS account (
      id TEXT PRIMARY KEY,
      accountId TEXT NOT NULL,
      providerId TEXT NOT NULL,
      userId TEXT NOT NULL,
      accessToken TEXT,
      refreshToken TEXT,
      idToken TEXT,
      accessTokenExpiresAt INTEGER,
      refreshTokenExpiresAt INTEGER,
      scope TEXT,
      password TEXT,
      createdAt INTEGER,
      updatedAt INTEGER,
      FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS verification (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      value TEXT NOT NULL,
      expiresAt INTEGER NOT NULL,
      createdAt INTEGER,
      updatedAt INTEGER
    )
  `);

  // Custom tables for chat
  db.run(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      user_id TEXT NOT NULL,
      title TEXT DEFAULT 'New Chat',
      agent TEXT DEFAULT 'express',
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    )
  `);

  // Add status column if missing (migration)
  try {
    db.run(`ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'complete'`);
  } catch {
    // Column already exists
  }

  // User-configurable agents
  db.run(`
    CREATE TABLE IF NOT EXISTS user_agents (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      position INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
    )
  `);

  // Add you_chat_id column to chat_sessions if missing
  try {
    db.run(`ALTER TABLE chat_sessions ADD COLUMN you_chat_id TEXT`);
  } catch {
    // Column already exists
  }
  ensureTableColumn("chat_sessions", "tts_mapping_updated_at", `ALTER TABLE chat_sessions ADD COLUMN tts_mapping_updated_at INTEGER DEFAULT (unixepoch())`);

  // User credentials for You.com cookies
  db.run(`
    CREATE TABLE IF NOT EXISTS user_credentials (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      user_id TEXT NOT NULL UNIQUE,
      ds_cookie TEXT NOT NULL,
      dsr_cookie TEXT NOT NULL,
      all_cookies TEXT DEFAULT '',
      uuid_guest TEXT DEFAULT '',
      you_email TEXT,
      you_name TEXT,
      subscription_type TEXT,
      validated_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
    )
  `);

  // Migration: add columns if missing
  try { db.run(`ALTER TABLE user_credentials ADD COLUMN all_cookies TEXT DEFAULT ''`); } catch { /* exists */ }
  try { db.run(`ALTER TABLE user_credentials ADD COLUMN uuid_guest TEXT DEFAULT ''`); } catch { /* exists */ }

  // TTS chunk progress per message
  db.run(`
    CREATE TABLE IF NOT EXISTS tts_progress (
      message_id TEXT PRIMARY KEY,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tts_voice_references (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      user_id TEXT NOT NULL,
      label TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      remote_voice_id TEXT,
      remote_voice_name TEXT,
      sync_status TEXT DEFAULT 'pending',
      last_synced_at INTEGER,
      last_sync_error TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
    )
  `);
  try { db.run(`ALTER TABLE tts_voice_references ADD COLUMN remote_voice_id TEXT`); } catch { /* exists */ }
  try { db.run(`ALTER TABLE tts_voice_references ADD COLUMN remote_voice_name TEXT`); } catch { /* exists */ }
  try { db.run(`ALTER TABLE tts_voice_references ADD COLUMN sync_status TEXT DEFAULT 'pending'`); } catch { /* exists */ }
  try { db.run(`ALTER TABLE tts_voice_references ADD COLUMN last_synced_at INTEGER`); } catch { /* exists */ }
  try { db.run(`ALTER TABLE tts_voice_references ADD COLUMN last_sync_error TEXT`); } catch { /* exists */ }

  db.run(`
    CREATE TABLE IF NOT EXISTS session_tts_speaker_mappings (
      session_id TEXT NOT NULL,
      speaker_key TEXT NOT NULL,
      speaker_label TEXT NOT NULL,
      voice_reference_id TEXT DEFAULT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (session_id, speaker_key),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (voice_reference_id) REFERENCES tts_voice_references(id) ON DELETE SET NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tts_message_speaker_state (
      message_id TEXT PRIMARY KEY,
      processed_length INTEGER NOT NULL DEFAULT 0,
      pending_line TEXT NOT NULL DEFAULT '',
      updated_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_tts_settings (
      user_id TEXT PRIMARY KEY,
      selected_voice_id TEXT DEFAULT NULL,
      updated_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
      FOREIGN KEY (selected_voice_id) REFERENCES tts_voice_references(id) ON DELETE SET NULL
    )
  `);

  // TTS chunk progress per message (cross-device persistence)
  db.run(`
    CREATE TABLE IF NOT EXISTS tts_progress (
      message_id TEXT PRIMARY KEY,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    )
  `);

  // Indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_user_agents_user ON user_agents(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tts_voice_references_user ON tts_voice_references(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_session_tts_speaker_mappings_session ON session_tts_speaker_mappings(session_id)`);

  console.log("Database initialized");
}

function readTableColumns(tableName: string): Set<string> {
  const rows = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  const columns = new Set(rows.map((row) => row.name));
  tableColumnCache.set(tableName, columns);
  return columns;
}

function hasTableColumn(tableName: string, columnName: string): boolean {
  const cachedColumns = tableColumnCache.get(tableName);
  if (cachedColumns?.has(columnName)) {
    return true;
  }

  return readTableColumns(tableName).has(columnName);
}

function ensureTableColumn(tableName: string, columnName: string, alterSql: string): boolean {
  if (hasTableColumn(tableName, columnName)) {
    return true;
  }

  try {
    db.run(alterSql);
  } catch {
    // Column may already exist or migration may fail on older state
  }

  return hasTableColumn(tableName, columnName);
}

// Helper functions
export function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function getChatSessions(userId: string) {
  return db.query(`
    SELECT * FROM chat_sessions
    WHERE user_id = ?
    ORDER BY updated_at DESC
  `).all(userId);
}

export function getChatSession(id: string, userId: string) {
  return db.query(`
    SELECT * FROM chat_sessions
    WHERE id = ? AND user_id = ?
  `).get(id, userId);
}

export function createChatSession(userId: string, title = "untitled", agent = "express") {
  const id = generateId();
  const now = Math.floor(Date.now() / 1000);
  db.run(
    `INSERT INTO chat_sessions (id, user_id, title, agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, userId, title, agent, now, now]
  );
  ensureSessionNarratorSpeaker(id);
  return { id, user_id: userId, title, agent, created_at: now, updated_at: now };
}

export function updateChatSession(id: string, userId: string, updates: { title?: string; agent?: string }) {
  const now = Math.floor(Date.now() / 1000);
  const sets: string[] = ["updated_at = ?"];
  const values: (string | number)[] = [now];

  if (updates.title) {
    sets.push("title = ?");
    values.push(updates.title);
  }
  if (updates.agent) {
    sets.push("agent = ?");
    values.push(updates.agent);
  }

  values.push(id, userId);
  db.run(`UPDATE chat_sessions SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, values);
  return getChatSession(id, userId);
}

export function deleteChatSession(id: string, userId: string) {
  db.run(`DELETE FROM chat_sessions WHERE id = ? AND user_id = ?`, [id, userId]);
}

export function getMessages(sessionId: string) {
  return db.query(`
    SELECT * FROM messages
    WHERE session_id = ?
    ORDER BY created_at ASC
  `).all(sessionId);
}

export function createMessage(sessionId: string, role: "user" | "assistant", content: string) {
  const id = generateId();
  const now = Math.floor(Date.now() / 1000);
  db.run(
    `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
    [id, sessionId, role, content, now]
  );
  // Update session's updated_at
  db.run(`UPDATE chat_sessions SET updated_at = ? WHERE id = ?`, [now, sessionId]);
  if (role === "assistant") {
    rebuildSessionTtsSpeakerMappings(sessionId);
  }
  return { id, session_id: sessionId, role, content, created_at: now };
}

// Create a message in "streaming" state
export function createStreamingMessage(sessionId: string, role: "user" | "assistant") {
  const id = generateId();
  const now = Math.floor(Date.now() / 1000);
  db.run(
    `INSERT INTO messages (id, session_id, role, content, created_at, status) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, sessionId, role, "", now, "streaming"]
  );
  db.run(`UPDATE chat_sessions SET updated_at = ? WHERE id = ?`, [now, sessionId]);
  return { id, session_id: sessionId, role, content: "", created_at: now, status: "streaming" };
}

// Update streaming message content progressively
export function updateStreamingContent(messageId: string, content: string) {
  db.run(`UPDATE messages SET content = ? WHERE id = ?`, [content, messageId]);
  const row = db.query(`SELECT session_id FROM messages WHERE id = ?`).get(messageId) as { session_id: string } | null;
  if (row?.session_id) {
    syncStreamingMessageSpeakers(row.session_id, messageId, content, false);
  }
}

// Mark a streaming message as complete
export function completeStreamingMessage(messageId: string, content: string) {
  db.run(`UPDATE messages SET content = ?, status = 'complete' WHERE id = ?`, [content, messageId]);
  const row = db.query(`SELECT session_id FROM messages WHERE id = ?`).get(messageId) as { session_id: string } | null;
  if (row?.session_id) {
    syncStreamingMessageSpeakers(row.session_id, messageId, content, true);
  }
}

export function updateMessage(messageId: string, sessionId: string, content: string) {
  db.run(`UPDATE messages SET content = ? WHERE id = ? AND session_id = ?`, [content, messageId, sessionId]);
  rebuildSessionTtsSpeakerMappings(sessionId);
  return db.query(`SELECT * FROM messages WHERE id = ? AND session_id = ?`).get(messageId, sessionId);
}

export function deleteMessage(messageId: string, sessionId: string) {
  db.run(`DELETE FROM messages WHERE id = ? AND session_id = ?`, [messageId, sessionId]);
  deleteTtsMessageSpeakerState(messageId);
  rebuildSessionTtsSpeakerMappings(sessionId);
}

export function deleteStreamingMessages(sessionId: string) {
  const result = db.run(`DELETE FROM messages WHERE session_id = ? AND status = 'streaming'`, [sessionId]);
  db.run(`DELETE FROM tts_message_speaker_state WHERE message_id NOT IN (SELECT id FROM messages)`);
  rebuildSessionTtsSpeakerMappings(sessionId);
  return result.changes;
}

// Delete all messages after a given message (by created_at). Keeps the target message.
export function deleteMessagesAfter(messageId: string, sessionId: string) {
  const msg = db.query(`SELECT created_at FROM messages WHERE id = ? AND session_id = ?`).get(messageId, sessionId) as { created_at: number } | null;
  if (!msg) return 0;
  // Delete messages created after this one, or same time but different id (later inserted)
  const result = db.run(
    `DELETE FROM messages WHERE session_id = ? AND (created_at > ? OR (created_at = ? AND id != ?))`,
    [sessionId, msg.created_at, msg.created_at, messageId]
  );
  db.run(`DELETE FROM tts_message_speaker_state WHERE message_id NOT IN (SELECT id FROM messages)`);
  rebuildSessionTtsSpeakerMappings(sessionId);
  return result.changes;
}

export function getMessage(messageId: string, sessionId?: string) {
  if (sessionId) {
    return db.query(`SELECT * FROM messages WHERE id = ? AND session_id = ?`).get(messageId, sessionId);
  }
  return db.query(`SELECT * FROM messages WHERE id = ?`).get(messageId);
}

export function forkSession(
  sourceSessionId: string,
  userId: string,
  upToMessageId: string
): { session: ReturnType<typeof getChatSession>; messageCount: number } | null {
  // Get the source session
  const source = getChatSession(sourceSessionId, userId) as { id: string; title: string; agent: string } | null;
  if (!source) return null;

  // Get the target message to find its created_at
  const targetMsg = db.query(`SELECT created_at FROM messages WHERE id = ? AND session_id = ?`).get(upToMessageId, sourceSessionId) as { created_at: number } | null;
  if (!targetMsg) return null;

  // Create new session
  const newTitle = `${source.title} (fork)`;
  const newSession = createChatSession(userId, newTitle, source.agent);

  // Copy messages up to and including the target message
  const messagesToCopy = db.query(`
    SELECT role, content, created_at FROM messages
    WHERE session_id = ? AND (created_at < ? OR (created_at = ? AND id <= ?))
    ORDER BY created_at ASC
  `).all(sourceSessionId, targetMsg.created_at, targetMsg.created_at, upToMessageId) as { role: string; content: string; created_at: number }[];

  for (const msg of messagesToCopy) {
    const id = generateId();
    db.run(
      `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
      [id, newSession.id, msg.role, msg.content, msg.created_at]
    );
  }

  rebuildSessionTtsSpeakerMappings(newSession.id);

  return { session: getChatSession(newSession.id, userId), messageCount: messagesToCopy.length };
}

export function getUserCount() {
  const result = db.query("SELECT COUNT(*) as count FROM user").get() as { count: number };
  return result.count;
}

// ─── User Agents CRUD ────────────────────────────────────────

export function getUserAgents(userId: string) {
  return db.query(`
    SELECT * FROM user_agents WHERE user_id = ? ORDER BY position ASC, created_at ASC
  `).all(userId);
}

export function createUserAgent(userId: string, agentId: string, name: string, description = "") {
  const id = generateId();
  const now = Math.floor(Date.now() / 1000);
  // Get next position
  const max = db.query(`SELECT MAX(position) as maxPos FROM user_agents WHERE user_id = ?`).get(userId) as { maxPos: number | null };
  const position = (max?.maxPos ?? -1) + 1;
  db.run(
    `INSERT INTO user_agents (id, user_id, agent_id, name, description, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, agentId, name, description, position, now]
  );
  return { id, user_id: userId, agent_id: agentId, name, description, position, created_at: now };
}

export function updateUserAgent(id: string, userId: string, updates: { agent_id?: string; name?: string; description?: string; position?: number }) {
  const sets: string[] = [];
  const values: (string | number)[] = [];

  if (updates.agent_id !== undefined) { sets.push("agent_id = ?"); values.push(updates.agent_id); }
  if (updates.name !== undefined) { sets.push("name = ?"); values.push(updates.name); }
  if (updates.description !== undefined) { sets.push("description = ?"); values.push(updates.description); }
  if (updates.position !== undefined) { sets.push("position = ?"); values.push(updates.position); }

  if (sets.length === 0) return null;

  values.push(id, userId);
  db.run(`UPDATE user_agents SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, values);
  return db.query(`SELECT * FROM user_agents WHERE id = ? AND user_id = ?`).get(id, userId);
}

export function deleteUserAgent(id: string, userId: string) {
  db.run(`DELETE FROM user_agents WHERE id = ? AND user_id = ?`, [id, userId]);
}

// ─── User Credentials CRUD (You.com cookies) ────────────────

export interface UserCredentials {
  id: string;
  user_id: string;
  ds_cookie: string;
  dsr_cookie: string;
  all_cookies: string;
  uuid_guest: string;
  you_email: string | null;
  you_name: string | null;
  subscription_type: string | null;
  validated_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface TtsVoiceReference {
  id: string;
  user_id: string;
  label: string;
  original_filename: string;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  remote_voice_id: string | null;
  remote_voice_name: string | null;
  sync_status: string | null;
  last_synced_at: number | null;
  last_sync_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface SessionTtsSpeakerMapping {
  session_id: string;
  speaker_key: string;
  speaker_label: string;
  voice_reference_id: string | null;
  created_at: number;
  updated_at: number;
}

interface TtsMessageSpeakerState {
  message_id: string;
  processed_length: number;
  pending_line: string;
  updated_at: number;
}

export function getUserCredentials(userId: string): UserCredentials | null {
  return db.query(`SELECT * FROM user_credentials WHERE user_id = ?`).get(userId) as UserCredentials | null;
}

export function saveUserCredentials(
  userId: string,
  ds: string,
  dsr: string,
  youEmail?: string,
  youName?: string,
  subscription?: string,
  allCookies?: string,
  uuidGuest?: string
) {
  const now = Math.floor(Date.now() / 1000);
  const existing = getUserCredentials(userId);
  if (existing) {
    db.run(
      `UPDATE user_credentials SET ds_cookie = ?, dsr_cookie = ?, all_cookies = ?, uuid_guest = ?, you_email = ?, you_name = ?, subscription_type = ?, validated_at = ?, updated_at = ? WHERE user_id = ?`,
      [ds, dsr, allCookies || "", uuidGuest || "", youEmail || null, youName || null, subscription || null, now, now, userId]
    );
  } else {
    const id = generateId();
    db.run(
      `INSERT INTO user_credentials (id, user_id, ds_cookie, dsr_cookie, all_cookies, uuid_guest, you_email, you_name, subscription_type, validated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, ds, dsr, allCookies || "", uuidGuest || "", youEmail || null, youName || null, subscription || null, now, now, now]
    );
  }
}

export function deleteUserCredentials(userId: string) {
  db.run(`DELETE FROM user_credentials WHERE user_id = ?`, [userId]);
}

// ─── Session You.com Thread ID ──────────────────────────────

export function updateSessionYouChatId(sessionId: string, youChatId: string | null) {
  db.run(`UPDATE chat_sessions SET you_chat_id = ? WHERE id = ?`, [youChatId, sessionId]);
}

export function getSessionYouChatId(sessionId: string): string | null {
  const row = db.query(`SELECT you_chat_id FROM chat_sessions WHERE id = ?`).get(sessionId) as { you_chat_id: string | null } | null;
  return row?.you_chat_id || null;
}

// ─── TTS Chunk Progress ─────────────────────────────────────

export function getTtsProgress(messageId: string): number {
  const row = db.query(`SELECT chunk_index FROM tts_progress WHERE message_id = ?`).get(messageId) as { chunk_index: number } | null;
  return row?.chunk_index ?? 0;
}

export function setTtsProgress(messageId: string, chunkIndex: number) {
  const now = Math.floor(Date.now() / 1000);
  db.run(
    `INSERT INTO tts_progress (message_id, chunk_index, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET chunk_index = excluded.chunk_index, updated_at = excluded.updated_at`,
    [messageId, chunkIndex, now]
  );
}

export function listTtsVoiceReferences(userId: string): TtsVoiceReference[] {
  return db.query(`
    SELECT * FROM tts_voice_references
    WHERE user_id = ?
    ORDER BY created_at ASC, label COLLATE NOCASE ASC
  `).all(userId) as TtsVoiceReference[];
}

export function listAllTtsVoiceReferences(): TtsVoiceReference[] {
  return db.query(`
    SELECT * FROM tts_voice_references
    ORDER BY user_id ASC, created_at ASC, label COLLATE NOCASE ASC
  `).all() as TtsVoiceReference[];
}

export function getTtsVoiceReference(userId: string, voiceId: string): TtsVoiceReference | null {
  return db.query(`
    SELECT * FROM tts_voice_references
    WHERE user_id = ? AND id = ?
  `).get(userId, voiceId) as TtsVoiceReference | null;
}

export function createTtsVoiceReference(
  userId: string,
  label: string,
  originalFilename: string,
  storagePath: string,
  mimeType: string,
  sizeBytes: number,
  remoteVoice?: { id: string; name: string } | null,
  syncStatus: string = remoteVoice ? "synced" : "pending",
  lastSyncError: string | null = null
): TtsVoiceReference {
  const id = generateId();
  const now = Math.floor(Date.now() / 1000);
  db.run(
    `INSERT INTO tts_voice_references (id, user_id, label, original_filename, storage_path, mime_type, size_bytes, remote_voice_id, remote_voice_name, sync_status, last_synced_at, last_sync_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      userId,
      label,
      originalFilename,
      storagePath,
      mimeType,
      sizeBytes,
      remoteVoice?.id ?? null,
      remoteVoice?.name ?? null,
      syncStatus,
      remoteVoice ? now : null,
      lastSyncError,
      now,
      now,
    ]
  );
  return getTtsVoiceReference(userId, id)!;
}

export function updateTtsVoiceReference(userId: string, voiceId: string, updates: {
  label?: string;
  storage_path?: string;
  mime_type?: string;
  size_bytes?: number;
  original_filename?: string;
  remote_voice_id?: string | null;
  remote_voice_name?: string | null;
  sync_status?: string | null;
  last_synced_at?: number | null;
  last_sync_error?: string | null;
}) {
  const sets: string[] = ["updated_at = ?"];
  const values: Array<string | number | null> = [Math.floor(Date.now() / 1000)];

  if (updates.label !== undefined) {
    sets.push("label = ?");
    values.push(updates.label);
  }
  if (updates.storage_path !== undefined) {
    sets.push("storage_path = ?");
    values.push(updates.storage_path);
  }
  if (updates.mime_type !== undefined) {
    sets.push("mime_type = ?");
    values.push(updates.mime_type);
  }
  if (updates.size_bytes !== undefined) {
    sets.push("size_bytes = ?");
    values.push(updates.size_bytes);
  }
  if (updates.original_filename !== undefined) {
    sets.push("original_filename = ?");
    values.push(updates.original_filename);
  }
  if (updates.remote_voice_id !== undefined) {
    sets.push("remote_voice_id = ?");
    values.push(updates.remote_voice_id);
  }
  if (updates.remote_voice_name !== undefined) {
    sets.push("remote_voice_name = ?");
    values.push(updates.remote_voice_name);
  }
  if (updates.sync_status !== undefined) {
    sets.push("sync_status = ?");
    values.push(updates.sync_status);
  }
  if (updates.last_synced_at !== undefined) {
    sets.push("last_synced_at = ?");
    values.push(updates.last_synced_at);
  }
  if (updates.last_sync_error !== undefined) {
    sets.push("last_sync_error = ?");
    values.push(updates.last_sync_error);
  }

  values.push(userId, voiceId);
  db.run(`UPDATE tts_voice_references SET ${sets.join(", ")} WHERE user_id = ? AND id = ?`, values);
  return getTtsVoiceReference(userId, voiceId);
}

export function deleteTtsVoiceReference(userId: string, voiceId: string) {
  const affectedSessionIds = db.query(`
    SELECT DISTINCT session_id FROM session_tts_speaker_mappings WHERE voice_reference_id = ?
  `).all(voiceId) as Array<{ session_id: string }>;

  db.run(`UPDATE session_tts_speaker_mappings SET voice_reference_id = NULL, updated_at = ? WHERE voice_reference_id = ?`, [Math.floor(Date.now() / 1000), voiceId]);
  db.run(`UPDATE user_tts_settings SET selected_voice_id = NULL, updated_at = ? WHERE user_id = ? AND selected_voice_id = ?`, [Math.floor(Date.now() / 1000), userId, voiceId]);
  db.run(`DELETE FROM tts_voice_references WHERE user_id = ? AND id = ?`, [userId, voiceId]);

  for (const row of affectedSessionIds) {
    touchSessionTtsMapping(row.session_id);
  }
}

export function getSelectedTtsVoiceReferenceId(userId: string): string | null {
  const row = db.query(`
    SELECT selected_voice_id FROM user_tts_settings WHERE user_id = ?
  `).get(userId) as { selected_voice_id: string | null } | null;
  return row?.selected_voice_id ?? null;
}

export function getSelectedTtsVoiceReference(userId: string): TtsVoiceReference | null {
  const selectedVoiceId = getSelectedTtsVoiceReferenceId(userId);
  if (!selectedVoiceId) return null;
  return getTtsVoiceReference(userId, selectedVoiceId);
}

export function setSelectedTtsVoiceReference(userId: string, voiceId: string | null) {
  const now = Math.floor(Date.now() / 1000);
  db.run(
    `INSERT INTO user_tts_settings (user_id, selected_voice_id, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET selected_voice_id = excluded.selected_voice_id, updated_at = excluded.updated_at`,
    [userId, voiceId, now]
  );
}

export function listSessionTtsSpeakerMappings(sessionId: string): SessionTtsSpeakerMapping[] {
  return db.query(`
    SELECT * FROM session_tts_speaker_mappings
    WHERE session_id = ?
    ORDER BY CASE WHEN speaker_key = 'narrator' THEN 0 ELSE 1 END, speaker_label COLLATE NOCASE ASC
  `).all(sessionId) as SessionTtsSpeakerMapping[];
}

export function getSessionTtsSpeakerMapping(sessionId: string, speakerKey: string): SessionTtsSpeakerMapping | null {
  return db.query(`
    SELECT * FROM session_tts_speaker_mappings
    WHERE session_id = ? AND speaker_key = ?
  `).get(sessionId, speakerKey) as SessionTtsSpeakerMapping | null;
}

export function upsertSessionTtsSpeakerMapping(sessionId: string, speakerKey: string, speakerLabel: string, voiceReferenceId: string | null = null) {
  const now = Math.floor(Date.now() / 1000);
  db.run(
    `INSERT INTO session_tts_speaker_mappings (session_id, speaker_key, speaker_label, voice_reference_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, speaker_key) DO UPDATE SET
       speaker_label = excluded.speaker_label,
       voice_reference_id = COALESCE(session_tts_speaker_mappings.voice_reference_id, excluded.voice_reference_id),
       updated_at = excluded.updated_at`,
    [sessionId, speakerKey, speakerLabel, voiceReferenceId, now, now]
  );

  touchSessionTtsMapping(sessionId, now);
  return getSessionTtsSpeakerMapping(sessionId, speakerKey);
}

export function updateSessionTtsSpeakerVoice(sessionId: string, speakerKey: string, voiceReferenceId: string | null) {
  const now = Math.floor(Date.now() / 1000);
  db.run(
    `UPDATE session_tts_speaker_mappings SET voice_reference_id = ?, updated_at = ? WHERE session_id = ? AND speaker_key = ?`,
    [voiceReferenceId, now, sessionId, speakerKey]
  );
  touchSessionTtsMapping(sessionId, now);
  return getSessionTtsSpeakerMapping(sessionId, speakerKey);
}

export function replaceSessionTtsSpeakerMappings(sessionId: string, nextMappings: Array<{ speakerKey: string; speakerLabel: string }>) {
  const now = Math.floor(Date.now() / 1000);
  const existing = listSessionTtsSpeakerMappings(sessionId);
  const existingVoiceByKey = new Map(existing.map((mapping) => [mapping.speaker_key, mapping.voice_reference_id]));
  const nextKeySet = new Set(nextMappings.map((mapping) => mapping.speakerKey));

  db.run(`DELETE FROM session_tts_speaker_mappings WHERE session_id = ? AND speaker_key NOT IN (${nextMappings.map(() => "?").join(", ") || "'__none__'"})`, [sessionId, ...nextKeySet]);

  for (const mapping of nextMappings) {
    db.run(
      `INSERT INTO session_tts_speaker_mappings (session_id, speaker_key, speaker_label, voice_reference_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, speaker_key) DO UPDATE SET
         speaker_label = excluded.speaker_label,
         voice_reference_id = COALESCE(session_tts_speaker_mappings.voice_reference_id, excluded.voice_reference_id),
         updated_at = excluded.updated_at`,
      [sessionId, mapping.speakerKey, mapping.speakerLabel, existingVoiceByKey.get(mapping.speakerKey) ?? null, now, now]
    );
  }

  touchSessionTtsMapping(sessionId, now);
}

function getTtsMessageSpeakerState(messageId: string): TtsMessageSpeakerState | null {
  return db.query(`SELECT * FROM tts_message_speaker_state WHERE message_id = ?`).get(messageId) as TtsMessageSpeakerState | null;
}

export function setTtsMessageSpeakerState(messageId: string, processedLength: number, pendingLine: string) {
  const now = Math.floor(Date.now() / 1000);
  db.run(
    `INSERT INTO tts_message_speaker_state (message_id, processed_length, pending_line, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET processed_length = excluded.processed_length, pending_line = excluded.pending_line, updated_at = excluded.updated_at`,
    [messageId, processedLength, pendingLine, now]
  );
}

export function deleteTtsMessageSpeakerState(messageId: string) {
  db.run(`DELETE FROM tts_message_speaker_state WHERE message_id = ?`, [messageId]);
}

function touchSessionTtsMapping(sessionId: string, now: number = Math.floor(Date.now() / 1000)) {
  const hasMappingColumn = ensureTableColumn(
    "chat_sessions",
    "tts_mapping_updated_at",
    `ALTER TABLE chat_sessions ADD COLUMN tts_mapping_updated_at INTEGER DEFAULT (unixepoch())`
  );

  if (hasMappingColumn) {
    db.run(`UPDATE chat_sessions SET tts_mapping_updated_at = ?, updated_at = ? WHERE id = ?`, [now, now, sessionId]);
    return;
  }

  db.run(`UPDATE chat_sessions SET updated_at = ? WHERE id = ?`, [now, sessionId]);
}

const SPEAKER_TAG_PATTERN = /["“]\[([^\]\n]+)\]\s*/g;
const SPEAKER_SCAN_TAIL_LENGTH = 128;

export function normalizeSpeakerKey(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return "narrator";
  return trimmed.toLowerCase().replace(/\s+/g, " ");
}

function extractSpeakersFromText(text: string) {
  const speakers: Array<{ speakerKey: string; speakerLabel: string }> = [];
  const seenKeys = new Set<string>();

  for (const match of text.matchAll(SPEAKER_TAG_PATTERN)) {
    const speakerLabel = match[1]?.trim() || "Narrator";
    if (!speakerLabel) continue;
    const speakerKey = normalizeSpeakerKey(speakerLabel);
    if (seenKeys.has(speakerKey)) continue;
    seenKeys.add(speakerKey);
    speakers.push({ speakerKey, speakerLabel });
  }

  return speakers;
}

export function ensureSessionNarratorSpeaker(sessionId: string) {
  return upsertSessionTtsSpeakerMapping(sessionId, "narrator", "Narrator", null);
}

export function syncStreamingMessageSpeakers(sessionId: string, messageId: string, content: string, finalize: boolean = false) {
  ensureSessionNarratorSpeaker(sessionId);

  const previousState = getTtsMessageSpeakerState(messageId) || {
    message_id: messageId,
    processed_length: 0,
    pending_line: "",
    updated_at: Math.floor(Date.now() / 1000),
  };

  const appendedContent = content.slice(previousState.processed_length);
  const workingText = `${previousState.pending_line}${appendedContent}`;

  for (const speaker of extractSpeakersFromText(workingText)) {
    upsertSessionTtsSpeakerMapping(sessionId, speaker.speakerKey, speaker.speakerLabel, null);
  }

  if (finalize) {
    deleteTtsMessageSpeakerState(messageId);
    return;
  }

  const nextPendingLine = workingText.slice(-Math.min(SPEAKER_SCAN_TAIL_LENGTH, workingText.length));
  setTtsMessageSpeakerState(messageId, content.length, nextPendingLine);
}

export function rebuildSessionTtsSpeakerMappings(sessionId: string) {
  const messages = getMessages(sessionId) as Array<{ id: string; content: string }>;
  const nextMappings = [{ speakerKey: "narrator", speakerLabel: "Narrator" }];
  const seenKeys = new Set(["narrator"]);

  for (const message of messages) {
    for (const speaker of extractSpeakersFromText(message.content)) {
      if (seenKeys.has(speaker.speakerKey)) continue;
      seenKeys.add(speaker.speakerKey);
      nextMappings.push({ speakerKey: speaker.speakerKey, speakerLabel: speaker.speakerLabel });
    }
  }

  replaceSessionTtsSpeakerMappings(sessionId, nextMappings);
}
