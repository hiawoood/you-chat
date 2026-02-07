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

const dbDir = resolveDbDir();
const dbPath = process.env.DATABASE_URL || `${dbDir}/you-chat.db`;

// Ensure directory exists
try { mkdirSync(dirname(dbPath), { recursive: true }); } catch {}

console.log(`Database path: ${dbPath}`);
export const db = new Database(dbPath, { create: true });

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

  // Indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_user_agents_user ON user_agents(user_id)`);

  console.log("Database initialized");
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
}

// Mark a streaming message as complete
export function completeStreamingMessage(messageId: string, content: string) {
  db.run(`UPDATE messages SET content = ?, status = 'complete' WHERE id = ?`, [content, messageId]);
}

export function updateMessage(messageId: string, sessionId: string, content: string) {
  db.run(`UPDATE messages SET content = ? WHERE id = ? AND session_id = ?`, [content, messageId, sessionId]);
  return db.query(`SELECT * FROM messages WHERE id = ? AND session_id = ?`).get(messageId, sessionId);
}

export function deleteMessage(messageId: string, sessionId: string) {
  db.run(`DELETE FROM messages WHERE id = ? AND session_id = ?`, [messageId, sessionId]);
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
