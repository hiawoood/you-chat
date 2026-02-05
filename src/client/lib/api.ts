// Use relative URL to work with both local and tunnel
const API_BASE = "/api";

async function fetchAPI(path: string, options: RequestInit = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(error.error || "Request failed");
  }

  return res.json();
}

export interface ChatSession {
  id: string;
  user_id: string;
  title: string;
  agent: string;
  created_at: number;
  updated_at: number;
}

export interface Message {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: number;
  status?: "complete" | "streaming";
}

export interface Agent {
  id: string;       // the You.com agent ID (e.g. "express" or a UUID)
  name: string;
  description: string;
  _id: string;      // internal DB row id for edit/delete
  position: number;
}

export const api = {
  getSessions: (): Promise<ChatSession[]> => fetchAPI("/sessions"),
  createSession: (data?: { title?: string; agent?: string }): Promise<ChatSession> =>
    fetchAPI("/sessions", { method: "POST", body: JSON.stringify(data || {}) }),
  getSession: (id: string): Promise<ChatSession> => fetchAPI(`/sessions/${id}`),
  updateSession: (id: string, data: { title?: string; agent?: string }): Promise<ChatSession> =>
    fetchAPI(`/sessions/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteSession: (id: string): Promise<void> =>
    fetchAPI(`/sessions/${id}`, { method: "DELETE" }),
  getMessages: (sessionId: string): Promise<Message[]> =>
    fetchAPI(`/sessions/${sessionId}/messages`),
  editMessage: (sessionId: string, messageId: string, content: string): Promise<Message> =>
    fetchAPI(`/sessions/${sessionId}/messages/${messageId}`, { method: "PATCH", body: JSON.stringify({ content }) }),
  getMessage: (sessionId: string, messageId: string): Promise<Message & { status?: string }> =>
    fetchAPI(`/sessions/${sessionId}/messages/${messageId}`),
  deleteMessage: (sessionId: string, messageId: string): Promise<void> =>
    fetchAPI(`/sessions/${sessionId}/messages/${messageId}`, { method: "DELETE" }),
  forkSession: (sessionId: string, messageId: string): Promise<ChatSession> =>
    fetchAPI(`/sessions/${sessionId}/fork`, { method: "POST", body: JSON.stringify({ messageId }) }),
  // Agents CRUD
  getAgents: (): Promise<Agent[]> => fetchAPI("/agents"),
  addAgent: (agent_id: string, name: string, description?: string): Promise<Agent> =>
    fetchAPI("/agents", { method: "POST", body: JSON.stringify({ agent_id, name, description }) }),
  updateAgent: (dbId: string, updates: { agent_id?: string; name?: string; description?: string }): Promise<Agent> =>
    fetchAPI(`/agents/${dbId}`, { method: "PATCH", body: JSON.stringify(updates) }),
  deleteAgent: (dbId: string): Promise<void> =>
    fetchAPI(`/agents/${dbId}`, { method: "DELETE" }),
};
