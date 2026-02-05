import { betterAuth } from "better-auth";
import { db, getUserCount } from "./db";

export const auth = betterAuth({
  database: db,
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

// Create admin user if no users exist
// Credentials configurable via ADMIN_EMAIL and ADMIN_PASSWORD env vars
export async function createAdminIfNeeded() {
  const count = getUserCount();
  if (count === 0) {
    const email = process.env.ADMIN_EMAIL || "admin@local.dev";
    const password = process.env.ADMIN_PASSWORD || "change-me";
    try {
      const ctx = await auth.api.signUpEmail({
        body: {
          email,
          password,
          name: "admin",
        },
      });
      console.log(`Created admin user: ${email}`);
    } catch (e) {
      console.log("Admin user may already exist");
    }
  }
}
