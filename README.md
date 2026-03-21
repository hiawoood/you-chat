# You-Chat

A full-stack web app for interacting with [You.com](https://you.com) AI agents and models. Multiple chat sessions, streaming responses, agent/model switching, message management, markdown rendering.

## How It Works

Each user connects their own You.com account by providing session cookies (DS and DSR). The app uses You.com's browser API to access all available AI models and custom agents from the user's account.

## Deploy to Railway

### Manual Deploy

1. Go to [railway.com/new](https://railway.com/new) → **Deploy from GitHub repo**
2. Paste: `https://github.com/hiawoood/you-chat`
3. Once created, go to the service and configure:

**Variables tab** — add these:

| Variable | Required | Description |
|----------|----------|-------------|
| `BETTER_AUTH_SECRET` | Yes | Random secret (run `openssl rand -hex 32`) |
| `ADMIN_EMAIL` | | Login email (default: `admin@local.dev`) |
| `ADMIN_PASSWORD` | Yes | Your login password |
| `PORT` | | Server port (default: `8080`) |
| `DATABASE_DIR` | | DB directory (default: `/data`) |

**Volume** — right-click service → Attach Volume → mount at `/data`

**Networking** — Settings tab → enable Public Networking (HTTP)

4. Railway auto-deploys. You'll get a stable `*.up.railway.app` URL.

## Local Development

```bash
# Install Bun (if needed)
curl -fsSL https://bun.sh/install | bash

# Install dependencies
bun install

# Create .env
cp .env.example .env
# Edit .env with your secrets

# Dev mode (hot reload)
bun run dev

# Or frontend + backend separately
bun run dev:client  # Vite on :5173
bun run dev         # Server on :8080
```

## First-Time Setup

1. Log in with the admin credentials
2. You'll be prompted to connect your You.com account
3. Go to [you.com](https://you.com), sign in, open DevTools (F12)
4. Go to Application → Cookies → you.com
5. Copy the `DS` and `DSR` cookie values
6. Paste them into the setup form

## Android Wrapper (Capacitor)

This repo now includes a Capacitor Android shell app. It does not replace the web deployment flow; the web app still builds and deploys normally.

The Android app can either:

- load the bundled `dist` build, or
- act as a thin wrapper around your deployed site so it always shows the latest version

For the live-wrapper setup, point Capacitor at your deployed URL before syncing Android:

```bash
bun install
bun run build
CAPACITOR_SERVER_URL=https://your-live-url.example.com bun run cap:sync
```

Then open Android Studio and build an APK:

```bash
bun run cap:open:android
```

Useful scripts:

- `bun run cap:copy`
- `bun run cap:sync`
- `bun run cap:open:android`
- `bun run cap:run:android`

Notes:

- `CAPACITOR_SERVER_URL` is only needed when you want the APK to load your deployed site instead of bundled static files.
- Re-run `CAPACITOR_SERVER_URL=... bun run cap:sync` whenever you change the wrapper configuration.
- The wrapper keeps the existing web deployment path untouched.

## Stack

- **Runtime:** [Bun](https://bun.sh)
- **Backend:** [Hono](https://hono.dev)
- **Frontend:** React + Tailwind CSS v4
- **Auth:** [better-auth](https://better-auth.com) (email/password)
- **Database:** SQLite (bun:sqlite)
- **AI:** [You.com](https://you.com) browser API (cookie-based, per-user)

## Features

- Multiple chat sessions with auto-generated titles
- Streaming responses with resume on page refresh
- Access to all You.com models and custom agents from your account
- Edit, delete, copy, collapse, fork, regenerate messages
- Full markdown rendering
- Mobile-friendly responsive UI
- Dark mode
