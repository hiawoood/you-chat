import { betterAuth } from "better-auth";
import { db } from "./db";

// Determine base URL
const port = process.env.PORT || "8080";
const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
const baseURL = process.env.BETTER_AUTH_URL
  || (railwayDomain ? `https://${railwayDomain}` : `http://localhost:${port}`);

console.log(`Auth base URL: ${baseURL}`);

export const auth = betterAuth({
  database: db,
  baseURL,
  basePath: "/api/auth",
  emailAndPassword: {
    enabled: true,
    // Signup is enabled so the admin creation API works.
    // The frontend has no signup form, so it's effectively login-only.
  },
  trustedOrigins: [
    `http://localhost:${port}`,
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

  // Check if user already exists
  const existing = db.query("SELECT id FROM user WHERE email = ?").get(email) as any;
  if (existing) {
    console.log(`Admin user already exists: ${email}`);
    return;
  }

  // Create via better-auth API (handles password hashing correctly)
  try {
    await auth.api.signUpEmail({
      body: { email, password, name: "admin" },
    });
    console.log(`✅ Created admin user: ${email}`);
  } catch (e: any) {
    console.error(`❌ Failed to create admin: ${e?.message || e}`);
  }
}
