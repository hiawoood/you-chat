# BUILD NOW - Direct Instructions

Stop researching. Build the app now.

## Stack (use these exact packages)
- `bun` - runtime
- `hono` - backend framework  
- `better-auth` - authentication
- `@better-auth/sqlite` - SQLite adapter
- `react` + `vite` - frontend
- `tailwindcss` - styling
- `@shadcn/ui` components via CLI

## You.com API
Endpoint: `POST https://api.you.com/v1/agents/runs`
Headers: `Authorization: Bearer <key>`, `Content-Type: application/json`
Body: `{"agent": "express", "input": "user message", "stream": true}`
Response: SSE stream with `data: {"response": {"delta": "text"}}`

API Key: `<YOUR_YOU_API_KEY>`

## Build Order
1. `bun init -y` 
2. Install deps: `bun add hono better-auth @better-auth/sqlite react react-dom`
3. Install dev deps: `bun add -d vite @vitejs/plugin-react tailwindcss postcss autoprefixer typescript @types/react @types/react-dom`
4. Create basic Hono server with better-auth
5. Create SQLite schema
6. Create auth routes
7. Create chat session routes
8. Create SSE streaming endpoint for You.com
9. Create React frontend with login + chat UI
10. Add shadcn components: `bunx shadcn@latest init` then add button, input, card, scroll-area

## Initial Admin User
On first run, create: username=admin, password=admin123

## Port
Run on 3001

## NOW BUILD IT. No more fetching docs. Just code.
