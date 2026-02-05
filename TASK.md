## You.com AI Agent Chat App - Full Build

**Working Directory:** `/tmp/you-chat`

**CRITICAL: Spend significant time on research and planning BEFORE writing code.**

### Phase 1: Research (Do This First!)

Before writing any code, thoroughly research:

1. **Bun 1.3.8 Features** - Read https://bun.sh/docs
   - `bun:sqlite` - How to use the built-in SQLite
   - `Bun.serve()` - Native HTTP server with streaming
   - Bundling React apps with Bun
   - Hot reload / dev server capabilities

2. **better-auth with Hono + Bun** - Read https://better-auth.com/docs and https://hono.dev/examples/better-auth
   - Setup with Hono
   - SQLite adapter configuration
   - Username/password authentication
   - Session management
   - Client-side integration with React

3. **shadcn/ui Setup** - Read https://ui.shadcn.com/docs/installation
   - Installation with Vite
   - Tailwind CSS configuration
   - Component installation (button, input, card, dialog, dropdown-menu, scroll-area, avatar, separator)

4. **SSE Streaming Patterns**
   - How to stream from Hono to frontend
   - How to consume SSE in React with proper cleanup
   - Error handling during streams

5. **You.com API** - Details in CLAUDE.md
   - Streaming response format
   - Error handling

Document your research findings in a RESEARCH.md file before proceeding.

### Phase 2: Architecture Plan

Create ARCHITECTURE.md with:
- Detailed component tree
- Data flow diagrams (text-based)
- API contract details
- State management approach
- Error handling strategy

### Phase 3: Implementation

Follow the CLAUDE.md spec exactly:

**Backend:**
- Hono server on port 3001
- bun:sqlite database
- better-auth with username/password
- Initial admin user (admin/admin123)
- Session CRUD routes
- Chat SSE streaming endpoint
- You.com API integration

**Frontend:**
- React with Vite (via Bun)
- shadcn/ui components
- Mobile-responsive layout
- Sidebar with sessions list
- Chat view with streaming messages
- Agent selector dropdown
- Login/Register page

### Phase 4: Testing & Polish

- Test all flows manually
- Ensure mobile responsiveness
- Error states and loading indicators
- Commit and push frequently

### Environment Setup

Create .env from .env.example with:
- BETTER_AUTH_SECRET=<generate a random 32+ char string>
- BETTER_AUTH_URL=http://localhost:3001
- YOU_API_KEY=<YOUR_YOU_API_KEY>
- DATABASE_URL=./data/you-chat.db
- PORT=3001

### Commands

Make sure these work:
- bun install - Install deps
- bun run dev - Development with hot reload
- bun run build - Production build
- bun run start - Production server

### Git

- Commit after each major milestone
- Push to origin/main regularly
- Clear commit messages

### Key Constraints

- Use ONLY Bun (not npm/yarn)
- Use bun:sqlite (not external sqlite packages)
- All code in TypeScript
- shadcn/ui for all UI components
- Must work on mobile

**Take your time. Research thoroughly. Plan carefully. Build quality.**

When completely finished, run this command to notify me:
