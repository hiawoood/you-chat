# CLAUDE.md - You.com AI Agent Chat App

## IMPORTANT: Research & Planning First

**Before writing any code, spend significant time:**
1. Research Bun 1.3.x latest features and best practices (we have 1.3.8)
2. Research better-auth setup with Hono + Bun + SQLite
3. Research shadcn/ui setup with Vite + React
4. Research You.com Agent API streaming patterns
5. Research modern SSE streaming from backend to frontend
6. Plan the architecture thoroughly
7. Document your findings and plan before implementing

Take your time. Quality > speed.

## Project Overview

Build a full-stack web app for conversing with You.com AI agents.

### Core Features
- **Multi-session chat**: Users can have multiple chat sessions
- **Back-and-forth conversation**: Messages persist, continue conversations
- **Agent switching**: Change AI agent mid-conversation or per-session
- **Streaming responses**: Real-time SSE from You.com → backend → frontend
- **Authentication**: Secure login with username/password
- **Mobile-friendly**: Responsive UI that works on phones

## Tech Stack (MANDATORY)

| Component | Technology | Notes |
|-----------|------------|-------|
| Runtime | **Bun 1.3.8** | Use latest Bun features |
| Backend Framework | **Hono** | Lightweight, Bun-optimized |
| Frontend | **React + Vite** | Via Bun's bundler |
| UI Library | **shadcn/ui** | With Tailwind CSS |
| Auth | **better-auth** | Username/password only |
| Database | **SQLite** | Via `bun:sqlite` built-in |
| Streaming | **SSE** | Server-Sent Events |

## You.com API Details

**Endpoint:** `https://api.you.com/v1/agents/runs`

**Authentication:** Bearer token
```
Authorization: Bearer <API_KEY>
```

**Request:**
```json
{
  "agent": "express",  // or custom agent UUID
  "input": "user message",
  "stream": true
}
```

**Response (SSE stream):**
```
data: {"response": {"delta": "partial text"}}
data: {"response": {"delta": "more text"}}
data: [DONE]
```

**Available Agents:**
- `express` - Fast general-purpose queries, web search (DEFAULT)
- Custom agents via UUID (can be added later)

**API Key Location:** `/data/workspace/.you-api-env`
```bash
export YOU_API_KEY="<YOUR_YOU_API_KEY>"
```

Copy this key to your `.env` file.

## Database Schema

```sql
-- better-auth creates: user, session, account, verification tables

-- Our custom tables:
CREATE TABLE chat_sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  title TEXT DEFAULT 'New Chat',
  agent TEXT DEFAULT 'express',
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_messages_session ON messages(session_id);
CREATE INDEX idx_chat_sessions_user ON chat_sessions(user_id);
```

## API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `*` | `/api/auth/*` | No | better-auth handlers |
| `GET` | `/api/sessions` | Yes | List user's chat sessions |
| `POST` | `/api/sessions` | Yes | Create new chat session |
| `GET` | `/api/sessions/:id` | Yes | Get session details |
| `PATCH` | `/api/sessions/:id` | Yes | Update session (title, agent) |
| `DELETE` | `/api/sessions/:id` | Yes | Delete session + messages |
| `GET` | `/api/sessions/:id/messages` | Yes | Get messages for session |
| `POST` | `/api/chat` | Yes | Stream chat (SSE response) |
| `GET` | `/api/agents` | Yes | List available agents |

### POST /api/chat

**Request:**
```json
{
  "sessionId": "abc123",
  "message": "Hello, what's the weather?"
}
```

**Response:** SSE stream
```
data: {"delta": "The weather"}
data: {"delta": " today is"}
data: {"delta": " sunny..."}
data: {"done": true, "messageId": "xyz789"}
```

The backend should:
1. Save user message to DB immediately
2. Call You.com API with streaming
3. Stream deltas to frontend via SSE
4. Save complete assistant message to DB when done

## Initial Admin User

Create on first run if no users exist:
- **Username:** `admin`
- **Password:** `admin123` (user should change this)

## Environment Variables

```env
# .env
BETTER_AUTH_SECRET=<generate 32+ char random string>
BETTER_AUTH_URL=http://localhost:3001
YOU_API_KEY=<YOUR_YOU_API_KEY>
DATABASE_URL=./data/you-chat.db
PORT=3001
```

## Project Structure (Suggested)

```
you-chat/
├── package.json
├── bunfig.toml
├── tsconfig.json
├── .env.example
├── .env                 # gitignored
├── .gitignore
├── CLAUDE.md
│
├── src/
│   ├── server/
│   │   ├── index.ts         # Hono app entry
│   │   ├── auth.ts          # better-auth config
│   │   ├── db.ts            # SQLite via bun:sqlite
│   │   ├── schema.sql       # DB schema
│   │   ├── routes/
│   │   │   ├── sessions.ts
│   │   │   └── chat.ts      # SSE streaming
│   │   └── lib/
│   │       └── you-client.ts  # You.com API client
│   │
│   └── client/
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx
│       ├── vite.config.ts   # if needed
│       ├── lib/
│       │   └── auth.ts      # better-auth client
│       ├── hooks/
│       │   └── useChat.ts   # Chat streaming hook
│       ├── components/
│       │   ├── ui/          # shadcn components
│       │   ├── Layout.tsx
│       │   ├── Sidebar.tsx
│       │   ├── ChatView.tsx
│       │   ├── MessageList.tsx
│       │   ├── MessageInput.tsx
│       │   └── AgentSelector.tsx
│       └── pages/
│           ├── Login.tsx
│           └── Chat.tsx
│
└── data/                    # SQLite DB location (gitignored)
```

## UI/UX Requirements

### Layout
- **Desktop**: Sidebar (sessions list) + Main chat area
- **Mobile**: Collapsible sidebar, full-width chat

### Components
1. **Sidebar**
   - List of chat sessions (newest first)
   - "New Chat" button
   - Session title (auto-generated or editable)
   - Delete session option
   - Current agent indicator

2. **Chat View**
   - Message list (scrollable, auto-scroll to bottom)
   - User messages (right-aligned, colored)
   - Assistant messages (left-aligned, different color)
   - Streaming indicator while receiving
   - Markdown rendering for assistant messages

3. **Message Input**
   - Text input (auto-resize textarea)
   - Send button
   - Disabled while streaming

4. **Agent Selector**
   - Dropdown in chat header
   - Shows current agent
   - Switch updates the session

5. **Login/Register**
   - Single page with tabs
   - Username + password fields
   - Error messages
   - Redirect to chat on success

### Styling
- Use shadcn/ui components
- Dark mode support (optional but nice)
- Clean, modern look
- Mobile-first responsive

## Running the App

```bash
# Install dependencies
bun install

# Run database migrations (or auto-run on start)
bun run db:setup

# Development (hot reload)
bun run dev

# Production
bun run build
bun run start
```

## Port Configuration

Run on port **3001** (to avoid conflicts).

The server should serve:
- `/api/*` - API routes
- `/*` - Static frontend files (production) or proxy to Vite (dev)

## Git Workflow

1. Make atomic commits with clear messages
2. Push to origin/main regularly
3. Include .env.example (not .env)

## Checklist

### Phase 1: Setup & Research
- [ ] Research Bun 1.3.x features (bun:sqlite, Bun.serve, bundling)
- [ ] Research better-auth + Hono integration
- [ ] Research shadcn/ui + Vite setup
- [ ] Initialize project with bun init
- [ ] Setup TypeScript config
- [ ] Setup .env handling
- [ ] Git initial commit

### Phase 2: Backend
- [ ] Setup Hono server
- [ ] Setup bun:sqlite database
- [ ] Create schema and migrations
- [ ] Integrate better-auth
- [ ] Create initial admin user
- [ ] Implement session routes
- [ ] Implement chat SSE streaming
- [ ] Test with curl

### Phase 3: Frontend
- [ ] Setup React + Vite with Bun
- [ ] Install and configure shadcn/ui
- [ ] Setup Tailwind CSS
- [ ] Create auth client
- [ ] Build Login page
- [ ] Build Chat layout
- [ ] Build Sidebar component
- [ ] Build ChatView with streaming
- [ ] Build MessageInput
- [ ] Build AgentSelector

### Phase 4: Integration & Polish
- [ ] Connect frontend to backend
- [ ] Test full flow
- [ ] Mobile responsiveness
- [ ] Error handling
- [ ] Loading states
- [ ] Final testing

## Notes

- Bun 1.3.8 has built-in `bun:sqlite` - no external SQLite package needed
- Use `Bun.serve()` for the HTTP server (fast, native)
- Hono works great with Bun - use `@hono/node-server` or direct Bun adapter
- better-auth has a Hono adapter
- For frontend dev, you can use Bun's built-in bundler or Vite (both work)
- shadcn/ui is not a package - it's a CLI that copies components into your project

## Reference Links

- Bun docs: https://bun.sh/docs
- Hono docs: https://hono.dev
- better-auth docs: https://better-auth.com/docs
- shadcn/ui docs: https://ui.shadcn.com
- You.com API: https://docs.you.com

---

**Remember: Research thoroughly, plan carefully, then implement. Quality matters more than speed.**
