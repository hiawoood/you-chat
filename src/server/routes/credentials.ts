import { Hono } from "hono";
import { getUserCredentials, saveUserCredentials, deleteUserCredentials } from "../db";
import { validateCookies } from "../lib/you-client";

const credentials = new Hono();

// Check if user has valid credentials
credentials.get("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const creds = getUserCredentials(user.id);
  if (!creds) {
    return c.json({ hasCredentials: false });
  }

  return c.json({
    hasCredentials: true,
    email: creds.you_email,
    name: creds.you_name,
    subscription: creds.subscription_type,
    validatedAt: creds.validated_at,
    hasFullCookies: !!(creds.all_cookies && creds.all_cookies.length > 10),
  });
});

// Save cookies (validates first)
credentials.post("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const { ds, dsr, allCookies } = await c.req.json();
  if (!ds || !dsr) {
    return c.json({ error: "Both DS and DSR cookie values are required" }, 400);
  }

  try {
    const info = await validateCookies(ds, dsr);
    saveUserCredentials(user.id, ds, dsr, info.email, info.name, info.subscription, allCookies || "");
    return c.json({
      email: info.email,
      name: info.name,
      subscription: info.subscription,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Validation failed";
    return c.json({ error: `Invalid cookies: ${message}` }, 400);
  }
});

// Remove stored credentials
credentials.delete("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  deleteUserCredentials(user.id);
  return c.json({ success: true });
});

export default credentials;
