import { betterAuth } from "better-auth";
import { db, getUserCount } from "./db";

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
  try {
    await auth.api.signUpEmail({
      body: {
        email,
        password,
        name: "admin",
      },
    });
    console.log(`Created admin user: ${email}`);
  } catch (e: any) {
    // User already exists — that's fine
    if (e?.message?.includes("already") || e?.body?.code === "USER_ALREADY_EXISTS") {
      console.log(`Admin user exists: ${email}`);
    } else {
      console.log(`Admin setup note: ${e?.message || "user may already exist"}`);
    }
  }
}
