import { Hono } from "hono";
import { getUserAgents, createUserAgent, updateUserAgent, deleteUserAgent } from "../db";

const agents = new Hono();

// List user's configured agents
agents.get("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const userAgents = getUserAgents(user.id);
  // Map to the format the frontend expects
  return c.json(userAgents.map((a: any) => ({
    id: a.agent_id,
    name: a.name,
    description: a.description,
    _id: a.id, // internal DB id for edit/delete
    position: a.position,
  })));
});

// Add a new agent
agents.post("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const { agent_id, name, description } = await c.req.json();
  if (!agent_id || !name) {
    return c.json({ error: "agent_id and name are required" }, 400);
  }

  const agent = createUserAgent(user.id, agent_id.trim(), name.trim(), (description || "").trim());
  return c.json({
    id: agent.agent_id,
    name: agent.name,
    description: agent.description,
    _id: agent.id,
    position: agent.position,
  }, 201);
});

// Update an agent
agents.patch("/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json();
  const updates: any = {};
  if (body.agent_id !== undefined) updates.agent_id = body.agent_id.trim();
  if (body.name !== undefined) updates.name = body.name.trim();
  if (body.description !== undefined) updates.description = (body.description || "").trim();
  if (body.position !== undefined) updates.position = body.position;

  const updated = updateUserAgent(c.req.param("id"), user.id, updates);
  if (!updated) return c.json({ error: "Not found" }, 404);

  const a = updated as any;
  return c.json({
    id: a.agent_id,
    name: a.name,
    description: a.description,
    _id: a.id,
    position: a.position,
  });
});

// Delete an agent
agents.delete("/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  deleteUserAgent(c.req.param("id"), user.id);
  return c.json({ success: true });
});

export default agents;
