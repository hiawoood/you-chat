import "./env";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { auth, createAdminIfNeeded } from "./auth";
import { initDb } from "./db";
import sessions from "./routes/sessions";
import chat from "./routes/chat";
import agentsRoute from "./routes/agents";
import credentials from "./routes/credentials";

// Initialize database
initDb();

const app = new Hono();

// CORS - allow localhost and cloudflare tunnels
app.use(
  "/api/*",
  cors({
    origin: (origin) => {
      if (!origin) return true; // Allow same-origin
      if (origin.includes("localhost")) return true;
      if (origin.includes("trycloudflare.com")) return true;
      if (origin.includes("ngrok-free.app")) return true;
      if (origin.includes("ngrok-free.dev")) return true;
      if (origin.includes("ngrok.io")) return true;
      if (origin.includes("up.railway.app")) return true;
      return false;
    },
    credentials: true,
  })
);

// Health check (public, used by Railway healthcheck)
app.get("/api/health", (c) => c.json({ ok: true }));

// Block public signup — only internal API (createAdminIfNeeded) can create users
app.post("/api/auth/sign-up/*", (c) => {
  return c.json({ error: "Signup is disabled" }, 403);
});

// Auth routes - must be before the auth middleware
app.on(["POST", "GET"], "/api/auth/*", async (c) => {
  return auth.handler(c.req.raw);
});

// Auth middleware for protected routes
app.use("/api/*", async (c, next) => {
  // Skip auth check for auth routes
  if (c.req.path.startsWith("/api/auth")) {
    return next();
  }

  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });

  if (!session?.user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("user", session.user);
  c.set("session", session.session);
  return next();
});

// API routes (protected)
app.route("/api/credentials", credentials);
app.route("/api/sessions", sessions);
app.route("/api/chat", chat);
app.route("/api/agents", agentsRoute);

// Serve static files in production
app.use("/*", serveStatic({ root: "./dist" }));
app.use("/*", serveStatic({ path: "./dist/index.html" }));

// Create admin user on startup
await createAdminIfNeeded();

const port = parseInt(process.env.PORT || "8080");

// Start server directly
const server = Bun.serve({
  port,
  fetch: app.fetch,
  // SSE streams can take 30s+ during thinking phase — increase from default 10s
  idleTimeout: 255, // max allowed by Bun (seconds)
});

console.log(`Server running at http://localhost:${server.port}`);
