# You-Chat Refactor Plan: Cookie-Based You.com API

## Summary

Replace the official You.com API (`api.you.com/v1/agents/runs` + API key) with the undocumented browser API (`you.com/api/streamingSearch` + cookies). This turns You.com into a raw **LLM engine** — our app owns the conversation state, and You.com just processes prompts.

---

## Architecture: Current vs New

### Current
```
User → You-Chat → Official API (api.you.com/v1/agents/runs)
                   Auth: API key (shared, one key for all users)
                   Agents: hardcoded in user's local DB
                   Chats: local-only (SQLite)
```

### New
```
User → You-Chat → Browser API (you.com/api/streamingSearch)
                   Auth: per-user cookies (DS + DSR)
                   Agents: fetched live from user's You.com account
                   Chats: local DB is source of truth; You.com is just the LLM backend
                   Each turn creates/continues a You.com thread behind the scenes
```

---

## Key Design Decisions

### 1. You.com = Stateless LLM Engine
- Our local DB owns the conversation (messages, edits, forks, deletions)
- You.com threads are **disposable execution contexts** — we create them to get LLM responses
- Each You-Chat session has a corresponding `you_chat_id` (the You.com chatId)
- Any destructive edit (edit message, delete message, regenerate) → **creates a new You.com thread** with the corrected history packed as context into the first message

### 2. Cookie Onboarding Flow
After login, if the user has no stored cookies:
1. Show a **setup screen** with instructions
2. User needs to provide exactly **2 values** from their browser:
   - `DS` cookie value (from `you.com` domain)
   - `DSR` cookie value (from `you.com` domain)
3. Instructions: "Go to you.com → Open DevTools → Application → Cookies → Copy DS and DSR values"
4. Backend validates cookies by calling `GET /api/user/me`
5. Store encrypted in DB; user can update anytime from Settings
6. User cannot access chat until cookies are valid

### 3. Agent Discovery
- **Remove:** Local `user_agents` table and manual agent CRUD
- **Replace:** Fetch agents live from `GET /api/custom_assistants/assistants?filter_type=all`
- Cache briefly (5 min) to avoid hammering the API
- Show model info alongside each agent (the `ai_model` field)
- Also expose the base models (from `/api/get_ai_models`) as selectable options

### 4. Chat ↔ You.com Thread Mapping

#### Normal flow (new message):
```
User sends message in You-Chat session
  → Check if session has a you_chat_id
    → NO: Generate new UUID as you_chat_id, pastChatLength=0, chat="[]"
    → YES: Use existing you_chat_id, pastChatLength=N, chat=JSON history
  → POST /api/streamingSearch
  → Stream response back to user
  → Save both messages to local DB
```

#### Edit a message:
```
User edits message M in a session with N messages
  → Delete old You.com thread (DELETE /api/chatThreads/{old_you_chat_id})
  → Generate new you_chat_id
  → Build new history: all messages up to M (with M edited), pack into single context message
  → POST /api/streamingSearch with new chatId, pastChatLength=0
    Body: query = condensed history + "Continue from here: {edited message}"
  → Stream new response
  → Update local DB: replace messages from M onward
  → Update session's you_chat_id to the new one
```

#### Delete a message:
```
Same as edit — delete old You.com thread, create new one with corrected history
```

#### Regenerate from a message:
```
Same as edit — delete old thread, create new with history up to the user message before it
```

#### Fork from a message:
```
User forks at message M
  → Create new You-Chat session (copy messages up to M)
  → Generate new you_chat_id for the fork
  → DON'T delete the original You.com thread (it stays with the original session)
  → Next message in the fork creates a new You.com thread with the forked history
```

---

## Database Changes

### Remove
- `user_agents` table (agents now fetched from You.com API)

### New: `user_credentials` table
```sql
CREATE TABLE user_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  ds_cookie TEXT NOT NULL,          -- DS JWT value
  dsr_cookie TEXT NOT NULL,         -- DSR JWT value
  you_email TEXT,                   -- You.com account email (from /api/user/me)
  you_name TEXT,                    -- You.com account name
  subscription_type TEXT,           -- e.g. "pro_teams"
  validated_at INTEGER,             -- last successful validation timestamp
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
);
```

### Modify: `chat_sessions` table
```sql
-- Add column:
ALTER TABLE chat_sessions ADD COLUMN you_chat_id TEXT;
-- The UUID of the corresponding You.com thread (nullable — set on first message)
```

### Remove env vars
- `YOU_API_KEY` — no longer needed

---

## File Changes

### Backend

| File | Action | Details |
|------|--------|---------|
| `src/server/lib/you-client.ts` | **Rewrite** | Replace official API with cookie-based `streamingSearch`. New functions: `streamChat()`, `loadSavedChat()`, `listAgents()`, `listModels()`, `deleteThread()`, `validateCookies()`, `refreshCookies()` |
| `src/server/routes/chat.ts` | **Modify** | Use new you-client; handle thread lifecycle (create/delete on edits); pass cookies per-user |
| `src/server/routes/agents.ts` | **Rewrite** | Proxy to You.com's agent listing API instead of local CRUD |
| `src/server/routes/sessions.ts` | **Modify** | Delete You.com thread when deleting a session; handle fork correctly |
| `src/server/db.ts` | **Modify** | Add `user_credentials` table, add `you_chat_id` to `chat_sessions`, remove `user_agents`, add credential CRUD helpers |
| `src/server/env.ts` | **Modify** | Remove `YOU_API_KEY` requirement |
| `src/server/routes/credentials.ts` | **New** | CRUD for user's You.com cookies + validation endpoint |
| `src/server/index.ts` | **Modify** | Add credentials routes, add middleware to check cookie setup |

### Frontend

| File | Action | Details |
|------|--------|---------|
| `src/client/pages/Settings.tsx` | **Rewrite** | Replace agent CRUD with cookie management UI (enter DS/DSR, show validation status, show You.com account info) |
| `src/client/pages/CookieSetup.tsx` | **New** | First-time setup page with instructions for getting cookies |
| `src/client/lib/api.ts` | **Modify** | Update agent endpoints, add credential endpoints |
| `src/client/components/Sidebar.tsx` | **Modify** | Agent selector uses live-fetched agents |
| `src/client/hooks/useChat.ts` | **Minor** | No changes needed (SSE format from our backend stays the same) |
| `src/client/App.tsx` | **Modify** | Add cookie setup gate (redirect to setup if no credentials) |

---

## Implementation Order

### Phase 1: Backend Core (you-client rewrite)
1. Write `YOU_COM_API_SPEC.md` ✅ (done)
2. Rewrite `you-client.ts` with cookie-based API
3. Add `user_credentials` table + CRUD
4. Add credential validation route
5. Add `you_chat_id` column to `chat_sessions`

### Phase 2: Chat Route Refactor
6. Refactor `chat.ts` to use new you-client (per-user cookies)
7. Implement thread lifecycle: create on first message, delete+recreate on edits
8. Refactor `sessions.ts` for You.com thread cleanup on delete

### Phase 3: Agents Route Refactor  
9. Rewrite `agents.ts` to proxy You.com's agent listing
10. Add model listing endpoint

### Phase 4: Frontend
11. Cookie setup page + gate
12. Settings page rewrite
13. Agent selector using live data
14. Remove `YOU_API_KEY` from env/docs

### Phase 5: Polish
15. Cookie refresh handling (auto-refresh when DS expires)
16. Error handling for expired/invalid cookies
17. Update README, CLAUDE.md, Dockerfile
18. Test full flow end-to-end

---

## How Edit/Regenerate/Delete Works (Detailed)

### The "Rebase" Operation

When history needs to change (edit, delete, regenerate), we perform a **rebase**:

1. **Build corrected history** from local DB (with the edit applied)
2. **Format as context prompt:**
   ```
   [Previous conversation context]
   
   User: first message
   Assistant: first response
   
   User: second message (edited)
   
   [Continue the conversation from here]
   ```
3. **Create new You.com thread** with this as the first message
4. **Delete old You.com thread** (cleanup)
5. **Stream the new response** back
6. **Update local DB** with the new `you_chat_id` and new assistant response

This way You.com always sees a clean, linear conversation — it never knows about edits.

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Cookies expire mid-conversation | Attempt refresh via `/v1/auth/refresh`; if fails, prompt user to update cookies |
| You.com rate limit | Backoff + retry with user notification |
| User has no custom agents | Show base models only (from `/api/get_ai_models`) |
| Multiple users, same You.com account | Works fine — each user stores their own cookies; they could be the same account |
| You.com thread gets deleted externally | No impact — we don't rely on You.com history; local DB is truth |
| First message in a fork | Create new You.com thread with forked history as context |

---

## Security Notes

- DS/DSR cookies stored in SQLite — **encrypt at rest** if possible (or at minimum, the DB file should be on a mounted volume with restricted access)
- Never expose cookie values to the frontend after initial setup
- Validate cookies server-side before storing
- Cookie values should be treated like passwords
