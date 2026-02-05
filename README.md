# You-Chat

A full-stack web app for interacting with [You.com](https://you.com) AI agents. Multiple chat sessions, streaming responses, agent switching, message management, markdown rendering.

## Deploy to Railway

### One-Click (via Railway Template)

> If a published template exists, click the deploy button. Otherwise, follow the manual steps below.

### Manual Deploy

1. Go to [railway.com/new](https://railway.com/new) → **Deploy from GitHub repo**
2. Paste: `https://github.com/hiawoood/you-chat`
3. Once created, go to the service and configure:

**Variables tab** — add these:

| Variable | Required | Description |
|----------|----------|-------------|
| `YOU_API_KEY` | ✅ | Your [You.com API key](https://you.com/api) |
| `BETTER_AUTH_SECRET` | ✅ | Random secret (run `openssl rand -hex 32`) |
| `ADMIN_EMAIL` | | Login email (default: `admin@local.dev`) |
| `ADMIN_PASSWORD` | ✅ | Your login password |
| `PORT` | | Server port (default: `8080`) |
| `DATABASE_DIR` | | DB directory (default: `/data`) |

**Volume** — right-click service → Attach Volume → mount at `/data`

**Networking** — Settings tab → enable Public Networking (HTTP)

4. Railway auto-deploys. You'll get a stable `*.up.railway.app` URL.

### Creating a Railway Template (for one-click deploys)

1. Go to [railway.com/workspace/templates](https://railway.com/workspace/templates)
2. Click **New Template** → add service → select this repo
3. **Variables tab**:
   - `YOU_API_KEY` — leave empty (user provides)
   - `BETTER_AUTH_SECRET` — set to `${{ secret(32) }}` (auto-generates)
   - `ADMIN_EMAIL` — default `admin@local.dev`
   - `ADMIN_PASSWORD` — leave empty (user provides)
   - `PORT` — default `8080`
4. Right-click service → **Attach Volume** → mount path `/data`
5. **Settings** → enable Public Networking (HTTP)
6. Click **Create Template** → share the deploy link

## Local Development

```bash
# Install Bun (if needed)
curl -fsSL https://bun.sh/install | bash

# Install dependencies
bun install

# Create .env
cp .env.example .env
# Edit .env with your API key and secrets

# Dev mode (hot reload)
bun run dev

# Or frontend + backend separately
bun run dev:client  # Vite on :5173
bun run dev         # Server on :8080
```

## Stack

- **Runtime:** [Bun](https://bun.sh)
- **Backend:** [Hono](https://hono.dev)
- **Frontend:** React + Tailwind CSS v4
- **Auth:** [better-auth](https://better-auth.com) (email/password)
- **Database:** SQLite (bun:sqlite)
- **AI:** [You.com Agents API](https://you.com/api)

## Features

- Multiple chat sessions with auto-generated titles
- Streaming responses with resume on page refresh
- User-configurable AI agents via Settings page
- Edit, delete, copy, collapse, fork, regenerate messages
- Full markdown rendering
- Mobile-friendly responsive UI
- Dark mode
