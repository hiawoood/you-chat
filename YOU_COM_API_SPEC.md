# You.com Undocumented API Specification

> Reverse-engineered from browser traffic analysis (2026-02-07)

## Authentication

**Method:** Cookie-based only. No `Authorization` header or CSRF token required.

### Required Cookies
| Cookie | Source | Purpose |
|--------|--------|---------|
| `DS` | `auth.you.com` | Descope session JWT (primary auth) |
| `DSR` | `auth.you.com` | Descope refresh token |

Other cookies (`cf_clearance`, `uuid_guest`, `youpro_subscription`, etc.) are set automatically but the two above are the minimum needed.

### Required Headers
```
Content-Type: text/plain;charset=UTF-8
User-Agent: <any modern browser UA>
```

### Token Refresh
```http
POST https://auth.you.com/v1/auth/refresh?dcs=t&dcr=f
Cookie: DS=<jwt>; DSR=<jwt>
```
Returns refreshed session. Response sets new `DS`/`DSR` cookies.

---

## Endpoints

### 1. Chat (New Message / Continue Conversation)

```http
POST https://you.com/api/streamingSearch
Content-Type: text/plain;charset=UTF-8
Cookie: DS=...; DSR=...
```

**Query Parameters:**
| Parameter | Required | Description |
|-----------|----------|-------------|
| `chatId` | ✅ | UUID for the chat session (generate new for new chats) |
| `conversationTurnId` | ✅ | UUID per turn (generate new each turn) |
| `pastChatLength` | ✅ | Number of previous turns (0 for first) |
| `selectedChatMode` | ✅ | Agent/model ID (e.g. `user_mode_xxx` for custom agent, or `gpt_5_2_thinking`) |
| `domain` | ✅ | Always `youchat` |
| `page` | | `1` |
| `count` | | `10` |
| `safeSearch` | | `off` |
| `use_nested_youchat_updates` | | `true` (recommended) |

**Body (stringified JSON, NOT `application/json`):**
```json
{
  "query": "Your message here",
  "chat": "[]"
}
```

**Multi-turn `chat` field format** (JSON string, not raw JSON):
```
"[{\"question\":\"first question\",\"answer\":\"first answer\"},{\"question\":\"second\",\"answer\":\"second ans\"}]"
```

**Response:** Server-Sent Events (SSE) stream.

#### SSE Event Types

| Event | Purpose | Key Fields |
|-------|---------|------------|
| `youChatUpdate` | Status + thinking tokens | `msg`, `t` (token), `done` |
| `youChatToken` | Clean answer tokens | `youChatToken` (string) |
| `youChatSources` | Source references | Array of source objects |
| `thirdPartySearchResults` | Web search results | Search result objects |
| `youChatIntent` | Query classification | `llm_intent`, `is_search_required_intent` |
| `youChatCachedChat` | Cached conversation | `chat` array (for saved chats) |
| `done` | Stream complete | `{"done": true}` |

**Token parsing example:**
```
event: youChatToken
data: {"youChatToken": "Hello"}

event: youChatToken
data: {"youChatToken": " world"}
```

---

### 2. Load Saved Chat

```http
POST https://you.com/api/streamingSavedChat
Content-Type: text/plain;charset=UTF-8
Cookie: DS=...; DSR=...
```

**Query Parameters:** Same as streamingSearch, plus:
| Parameter | Required | Description |
|-----------|----------|-------------|
| `cachedChatId` | ✅ | `c0_` prefix + chatId (e.g. `c0_934b4895-...`) |

**Response:** Returns `youChatCachedChat` SSE event with full `chat` array containing all Q&A pairs, sources, and metadata.

---

### 3. List Threads (Chats)

```http
GET https://you.com/api/threads?shouldFetchFavorites=false&count=30
Cookie: DS=...; DSR=...
```

**Pagination:** Add `&lastFetchedThreadId=<id>` for next page.

**Response:**
```json
[
  {
    "id": "uuid",
    "type": "threads",
    "attributes": {
      "title": "Chat Title",
      "starred": false,
      "date_created": "ISO timestamp",
      "date_updated": "ISO timestamp"
    }
  }
]
```

**Starred threads:** Use `?shouldFetchFavorites=true&count=200`

---

### 4. Thread Management

#### Rename / Star
```http
PATCH https://you.com/api/threads/{chatId}
Content-Type: application/json
Cookie: DS=...; DSR=...

{
  "data": {
    "type": "threads",
    "id": "{chatId}",
    "attributes": {
      "title": "New Title",
      "starred": true
    }
  }
}
```

#### Delete
```http
DELETE https://you.com/api/chatThreads/{chatId}
Cookie: DS=...; DSR=...
```

**Response:** `{"deleted_chats": 1}`

> ⚠️ Note: Delete uses `/api/chatThreads/` (different from `/api/threads/` for CRUD)

---

### 5. List Available AI Models

```http
GET https://you.com/api/get_ai_models
Cookie: DS=...; DSR=...
```

**Response:** Array of 31 models including:
- GPT-5.2 Thinking, GPT-5.1, GPT-5, GPT-5 mini, GPT-4.1
- Claude Opus 4.5 (Extended), Claude Opus 4.1, Claude Sonnet 4.5, Claude Sonnet 4, Claude Haiku 4.5
- Gemini 3 Pro/Flash, Gemini 2.5 Pro/Flash
- Grok 4.1 Fast (Reasoning), Grok 4
- DeepSeek-R1, DeepSeek-V3
- Llama 4 Maverick/Scout, Qwen3 235B, Mistral Large 2

Each model has: `name`, `id` (used as `selectedChatMode`), `isProOnly`

---

### 6. Custom Agents

#### List All Custom Agents
```http
GET https://you.com/api/custom_assistants/assistants?filter_type=all&page[size]=500&page[number]=1
Cookie: DS=...; DSR=...
```

**Response:**
```json
{
  "user_chat_modes": [
    {
      "chat_mode_id": "user_mode_xxx",
      "chat_mode_name": "Agent Name",
      "ai_model": "claude_4_5_opus_thinking",
      "visibility": "private",
      "chat_turn_count": 232,
      "conversation_count": 179
    }
  ]
}
```

#### Get Agent Details
```http
GET https://you.com/api/custom_assistants/assistants?agent_id={agent_id}
Cookie: DS=...; DSR=...
```

#### Filter Types
- `filter_type=all` — all user's agents
- `filter_type=others` — shared/public agents
- `filter_type=recent` — recently used (combine with `sort=-agent_activity`)

---

### 7. User Info

```http
GET https://you.com/api/user/me
Cookie: DS=...; DSR=...
```

```http
GET https://you.com/api/user/getYouProState
Cookie: DS=...; DSR=...
```

```http
GET https://you.com/api/subscriptions/user
Cookie: DS=...; DSR=...
```

---

## Quick Reference

| Action | Method | Endpoint |
|--------|--------|----------|
| New/continue chat | POST | `/api/streamingSearch` |
| Load saved chat | POST | `/api/streamingSavedChat` |
| List threads | GET | `/api/threads?count=30` |
| Rename/star thread | PATCH | `/api/threads/{id}` |
| Delete thread | DELETE | `/api/chatThreads/{id}` |
| List models | GET | `/api/get_ai_models` |
| List agents | GET | `/api/custom_assistants/assistants?filter_type=all` |
| Get agent | GET | `/api/custom_assistants/assistants?agent_id=...` |
| Refresh auth | POST | `auth.you.com/v1/auth/refresh` |
| User info | GET | `/api/user/me` |

## Minimal Working Example (curl)

```bash
CHAT_ID=$(uuidgen)
TURN_ID=$(uuidgen)

curl -sN \
  -X POST \
  -H "Content-Type: text/plain;charset=UTF-8" \
  -H "User-Agent: Mozilla/5.0 ..." \
  -b cookies.txt \
  -d '{"query":"Hello!","chat":"[]"}' \
  "https://you.com/api/streamingSearch?chatId=${CHAT_ID}&conversationTurnId=${TURN_ID}&pastChatLength=0&selectedChatMode=claude_4_5_opus&domain=youchat&use_nested_youchat_updates=true"
```

## Multi-Turn Conversation Flow

1. **Turn 1:** `pastChatLength=0`, `chat="[]"`
2. **Turn 2:** `pastChatLength=1`, `chat="[{\"question\":\"q1\",\"answer\":\"a1\"}]"`
3. **Turn N:** `pastChatLength=N-1`, pass all previous Q&A pairs in `chat`

Keep the same `chatId` across turns. Generate a new `conversationTurnId` each turn.

## Key Gotchas

1. **Content-Type must be `text/plain;charset=UTF-8`** — not `application/json`
2. **`chat` field is a JSON string**, not raw JSON — double-encoded
3. **Delete uses `/api/chatThreads/`**, not `/api/threads/`
4. **Thread PATCH uses JSON:API format** with `data.type`, `data.id`, `data.attributes`
5. **Only DS + DSR cookies are truly required** for auth
