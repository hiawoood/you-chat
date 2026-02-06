import { betterAuth } from "better-auth";
import { db, getUserCount, generateId } from "./db";

// Determine base URL: explicit env > Railway public domain > localhost
const port = process.env.PORT || "8080";
const baseURL = process.env.BETTER_AUTH_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null)
  || `http://localhost:${port}`;

console.log(`Auth base URL: ${baseURL}`);

export const auth = betterAuth({
  database: db,
  baseURL,
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,  // Only allow login, no public registration
  },
  trustedOrigins: [
    "http://localhost:8080",
    "http://localhost:5173",
    "https://*.trycloudflare.com",
    "https://*.ngrok-free.app",
    "https://*.ngrok-free.dev",
    "https://*.ngrok.io",
    "https://*.up.railway.app",
  ],
  secret: process.env.BETTER_AUTH_SECRET,
});

// Ensure admin user exists on every startup
// Credentials configurable via ADMIN_EMAIL and ADMIN_PASSWORD env vars
export async function createAdminIfNeeded() {
  const email = process.env.ADMIN_EMAIL || "admin@local.dev";
  const password = process.env.ADMIN_PASSWORD || "change-me";

  // Check if user with this email already exists
  const existing = db.query("SELECT id FROM user WHERE email = ?").get(email);
  if (existing) {
    console.log(`Admin user exists: ${email}`);
    return;
  }

  // Use better-auth's internal API to create user (handles password hashing)
  try {
    const result = await auth.api.signUpEmail({
      body: { email, password, name: "admin" },
    });
    console.log(`Created admin user: ${email}`);
  } catch (e: any) {
    console.error(`Failed to create admin via API: ${e?.message}`);
    // Fallback: try creating directly with Bun's password hash
    try {
      const hashedPassword = await Bun.password.hash(password, { algorithm: "bcrypt" });
      const userId = generateId();
      const now = Date.now();
      db.run(
        "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
        [userId, "admin", email, 0, now, now]
      );
      db.run(
        "INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [generateId(), userId, "credential", userId, hashedPassword, now, now]
      );
      console.log(`Created admin user (direct): ${email}`);
    } catch (e2: any) {
      console.error(`Failed to create admin (direct): ${e2?.message}`);
    }
  }
}
