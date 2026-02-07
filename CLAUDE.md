# CLAUDE.md - You.com AI Agent Chat App

## Project Overview

Full-stack web app for conversing with You.com AI agents using cookie-based authentication.

### Core Features
- **Multi-session chat**: Multiple simultaneous conversations
- **Streaming responses**: Real-time SSE streaming
- **Agent switching**: Change AI agent per-session (custom agents + base models)
- **Message management**: Edit, delete, regenerate, fork conversations
- **Authentication**: Secure login with username/password
- **You.com Integration**: Per-user cookie-based auth (DS/DSR tokens)

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Bun 1.3.8 |
| Backend | Hono |
| Frontend | React + Vite |
| UI | Tailwind CSS |
| Auth | better-auth |
| Database | SQLite (bun:sqlite) |
| Streaming | SSE |

## Architecture

- Users authenticate to You-Chat via username/password
- Users provide their You.com cookies (DS/DSR) for AI access
- Agents and models are fetched live from the user's You.com account
- Chat history is owned locally (SQLite) — You.com is used as an LLM engine
- Edit/regenerate/fork operations create new You.com threads transparently

## Environment Variables

```env
BETTER_AUTH_SECRET=<random 32+ char string>
PORT=8080
ADMIN_EMAIL=admin@local.dev
ADMIN_PASSWORD=<your password>
# DATABASE_DIR=/data  (optional, defaults to /data if writable)
```

## Running

```bash
bun install
bun run build
bun run start
```

## Project Structure

```
src/
├── server/
│   ├── index.ts          # Hono app entry
│   ├── auth.ts           # better-auth config
│   ├── db.ts             # SQLite schema + helpers
│   ├── env.ts            # Environment validation
│   ├── routes/
│   │   ├── chat.ts       # SSE streaming chat
│   │   ├── sessions.ts   # Chat session CRUD
│   │   ├── agents.ts     # Agent/model listing
│   │   └── credentials.ts # You.com cookie management
│   └── lib/
│       └── you-client.ts # You.com API client
└── client/
    ├── App.tsx
    ├── pages/
    │   ├── Login.tsx
    │   ├── Chat.tsx
    │   ├── Settings.tsx
    │   └── CookieSetup.tsx
    ├── components/
    │   ├── ChatView.tsx
    │   ├── Sidebar.tsx
    │   ├── MessageList.tsx
    │   └── MessageInput.tsx
    └── hooks/
        └── useChat.ts
```
