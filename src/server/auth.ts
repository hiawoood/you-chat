import { betterAuth } from "better-auth";
import { db, getUserCount, generateId } from "./db";

// Determine base URL: explicit env > Railway reference > Railway domain > localhost
const port = process.env.PORT || "8080";
const baseURL = process.env.BETTER_AUTH_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null)
  || `http://localhost:${port}`;

console.log(`Auth base URL: ${baseURL}`);
console.log(`RAILWAY_PUBLIC_DOMAIN: ${process.env.RAILWAY_PUBLIC_DOMAIN || "(not set)"}`);
console.log(`BETTER_AUTH_URL: ${process.env.BETTER_AUTH_URL || "(not set)"}`);

export const auth = betterAuth({
  database: db,
  baseURL,
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
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
export async function createAdminIfNeeded() {
  const email = process.env.ADMIN_EMAIL || "admin@local.dev";
  const password = process.env.ADMIN_PASSWORD || "change-me";

  console.log(`Admin setup: checking for ${email}...`);

  // Check if user with this email already exists
  const existing = db.query("SELECT id FROM user WHERE email = ?").get(email) as any;
  if (existing) {
    console.log(`Admin user already exists: ${email} (id: ${existing.id})`);
    return;
  }

  console.log(`Creating admin user: ${email}...`);

  // Create user directly in the DB — bypasses disableSignUp restriction
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
    console.log(`✅ Created admin user: ${email}`);
  } catch (e: any) {
    console.error(`❌ Failed to create admin: ${e?.message}`);
  }
}
