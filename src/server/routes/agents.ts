import { Hono } from "hono";
import { getUserCredentials } from "../db";
import { listAgents, listModels } from "../lib/you-client";

const agents = new Hono();

// List agents and models from You.com API
agents.get("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const creds = getUserCredentials(user.id);
  if (!creds) {
    return c.json({ error: "You.com credentials required" }, 403);
  }

  try {
    const [customAgents, models] = await Promise.all([
      listAgents(creds.ds_cookie, creds.dsr_cookie).catch(() => []),
      listModels(creds.ds_cookie, creds.dsr_cookie).catch(() => []),
    ]);

    // Format agents: custom agents first, then models
    const result = [
      ...customAgents.map(a => ({
        id: a.id,
        name: a.name,
        description: `Model: ${a.model}`,
        type: "agent" as const,
      })),
      ...models.map(m => ({
        id: m.id,
        name: m.name,
        description: m.isProOnly ? "Pro only" : "",
        type: "model" as const,
      })),
    ];

    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch agents";
    return c.json({ error: message }, 500);
  }
});

export default agents;
