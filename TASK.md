# TASK: Refactor You-Chat to use Cookie-Based You.com API

Read `REFACTOR_PLAN.md` and `YOU_COM_API_SPEC.md` thoroughly before starting.

## What You're Building

Replace the official You.com API (`api.you.com/v1/agents/runs` + API key) with the undocumented browser API (`you.com/api/streamingSearch` + per-user cookies). The app treats You.com as a raw LLM engine — our local DB owns all conversation state.

## Implementation Steps (in order)

### Step 1: Rewrite `src/server/lib/you-client.ts`

Replace the entire file. New exports needed:

```typescript
// Core chat function - streams response tokens
streamChat(options: {
  query: string,
  chatHistory: Array<{question: string, answer: string}>,
  chatId: string,           // You.com thread UUID
  agentOrModel: string,     // e.g. "user_mode_xxx" or "claude_4_5_opus"
  dsCookie: string,
  dsrCookie: string,
  pastChatLength?: number,
}): AsyncGenerator<string>

// Non-streaming chat (for title generation etc)
callChat(options: {
  query: string,
  agentOrModel: string,
  dsCookie: string,
  dsrCookie: string,
}): Promise<string>

// Validate cookies - returns user info or throws
validateCookies(ds: string, dsr: string): Promise<{email: string, name: string, subscription?: string}>

// List custom agents
listAgents(ds: string, dsr: string): Promise<Array<{id: string, name: string, model: string, turnCount: number}>>

// List available AI models
listModels(ds: string, dsr: string): Promise<Array<{id: string, name: string, isProOnly: boolean}>>

// Delete a You.com thread
deleteThread(chatId: string, ds: string, dsr: string): Promise<void>

// Refresh cookies
refreshCookies(ds: string, dsr: string): Promise<{ds: string, dsr: string} | null>
```

Key implementation details from the spec:
- Endpoint: `POST https://you.com/api/streamingSearch`
- Content-Type: `text/plain;charset=UTF-8` (NOT application/json!)
- Body: `{"query": "...", "chat": "[]"}` — the `chat` field is a JSON STRING, not raw JSON
- Auth: only cookies `DS` and `DSR` needed (pass via Cookie header)
- Response: SSE stream with `youChatToken` events for clean tokens
- User-Agent: use a realistic browser UA string
- Each turn needs: new `conversationTurnId` (UUID), same `chatId`, increment `pastChatLength`
- Multi-turn `chat` format: `"[{\"question\":\"q1\",\"answer\":\"a1\"}]"`
- Delete thread: `DELETE https://you.com/api/chatThreads/{chatId}` (note: chatThreads not threads!)
- List agents: `GET https://you.com/api/custom_assistants/assistants?filter_type=all&page[size]=500&page[number]=1`
- List models: `GET https://you.com/api/get_ai_models`
- Validate: `GET https://you.com/api/user/me`

### Step 2: Update `src/server/db.ts`

1. Add `user_credentials` table:
```sql
CREATE TABLE IF NOT EXISTS user_credentials (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL UNIQUE,
  ds_cookie TEXT NOT NULL,
  dsr_cookie TEXT NOT NULL,
  you_email TEXT,
  you_name TEXT,
  subscription_type TEXT,
  validated_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
);
```

2. Add `you_chat_id` column to `chat_sessions`:
```sql
ALTER TABLE chat_sessions ADD COLUMN you_chat_id TEXT;
```

3. Add CRUD helpers:
- `getUserCredentials(userId)` → returns credentials or null
- `saveUserCredentials(userId, ds, dsr, youEmail?, youName?, subscription?)` → upsert
- `updateSessionYouChatId(sessionId, youChatId)` → update the You.com thread ID
- `getSessionYouChatId(sessionId)` → get current You.com thread ID

4. Keep `user_agents` table and functions for now (we'll keep them but they won't be used as the primary source — the API will be primary).

### Step 3: Create `src/server/routes/credentials.ts`

New route file:
- `POST /api/credentials` — save DS/DSR cookies (validates first via `validateCookies()`)
- `GET /api/credentials` — check if user has valid credentials (returns email, name, validated status — NOT the actual cookie values)
- `DELETE /api/credentials` — remove stored credentials

### Step 4: Refactor `src/server/routes/chat.ts`

Major changes:
1. Before any chat operation, fetch user's credentials from DB
2. If no credentials → return 403 with `{error: "You.com credentials required"}`
3. **Normal message flow:**
   - Get or create `you_chat_id` for the session
   - Build chat history from local messages as `[{question, answer}]` pairs
   - Call `streamChat()` with user's cookies
   - Stream response back via SSE (same format as before for frontend compatibility)
   - Save messages to local DB
4. **Regenerate flow:**
   - Delete old You.com thread (`deleteThread()`)
   - Generate new `you_chat_id`
   - Build history up to the message being regenerated
   - Pack history into context and send to new thread
   - Update session's `you_chat_id`
5. **Title generation:** Use `callChat()` with a cheap model like `claude_4_5_haiku` (it's free)

### Step 5: Refactor `src/server/routes/agents.ts`

Replace the local CRUD with:
- `GET /api/agents` — fetch live from You.com API using user's cookies
  - Returns combined list: user's custom agents + available base models
  - Custom agents first, then a separator, then models
- Remove POST/PATCH/DELETE routes (agents are managed on you.com, not here)

### Step 6: Refactor `src/server/routes/sessions.ts`

- On `DELETE /api/sessions/:id` — also delete the You.com thread if the session has a `you_chat_id`
- On fork — DON'T delete the original You.com thread
- The fork's new session gets no `you_chat_id` initially (created on first message)

### Step 7: Update `src/server/index.ts`

- Import and mount credentials routes at `/api/credentials`
- Remove YOU_API_KEY from env validation
- Add middleware: for protected routes (except `/api/credentials` and `/api/auth/*`), optionally check if user has credentials and add a header hint

### Step 8: Update `src/server/env.ts`

- Remove `YOU_API_KEY` requirement
- Add `BETTER_AUTH_SECRET` if not already required

### Step 9: Frontend — `src/client/pages/CookieSetup.tsx` (NEW)

Create a setup page shown when user has no credentials:
- Title: "Connect Your You.com Account"
- Clear instructions:
  1. Go to you.com and sign in
  2. Open Developer Tools (F12)
  3. Go to Application → Cookies → you.com
  4. Copy the value of the `DS` cookie
  5. Copy the value of the `DSR` cookie
- Two input fields (password-type for security): DS, DSR
- "Connect" button that POSTs to `/api/credentials`
- Show validation status (loading → success/error)
- On success, show You.com account info (name, email) and proceed to chat

### Step 10: Frontend — Update `src/client/App.tsx`

- After auth check, also check `GET /api/credentials`
- If no credentials → show CookieSetup page instead of Chat
- Once credentials saved → navigate to Chat

### Step 11: Frontend — Update `src/client/pages/Settings.tsx`

Replace agent management with:
- **You.com Connection** section:
  - Show connected account info (email, name, subscription)
  - "Update Cookies" button (reopens the cookie input form)
  - "Disconnect" button (deletes credentials)
- Remove all the agent CRUD UI

### Step 12: Frontend — Update `src/client/lib/api.ts`

Add:
```typescript
// Credentials
getCredentials(): Promise<{hasCredentials: boolean, email?: string, name?: string}>
saveCredentials(ds: string, dsr: string): Promise<{email: string, name: string}>
deleteCredentials(): Promise<void>
```

Update agents endpoint to expect the new response format (live agents + models).

### Step 13: Frontend — Update agent selector

In `Sidebar.tsx` or wherever the agent dropdown is:
- Fetch agents from the updated `/api/agents` endpoint
- Group by: "Custom Agents" and "Models"
- Show model name alongside agent name

### Step 14: Cleanup

- Remove `YOU_API_KEY` from `README.md`, `CLAUDE.md`, `.env.example`, `Dockerfile`
- Update README with new setup instructions
- Update CLAUDE.md to reflect new architecture
- `git add -A && git commit`

## IMPORTANT NOTES

- **Do NOT break the frontend SSE format** — the `useChat` hook expects `{delta}`, `{done, messageId, generatedTitle}`, `{error}`. Keep this contract.
- **The `chat` parameter is a JSON STRING** — `"[]"` not `[]`. Double-encode it.
- **Content-Type for You.com requests is `text/plain;charset=UTF-8`** — NOT `application/json`
- **Test by building:** Run `bun run build` to verify TypeScript compiles
- **Commit after each major step** with clear messages

When completely finished, run this command to notify:
```
openclaw gateway wake --text "Done: Refactored you-chat to use cookie-based You.com API" --mode now
```
