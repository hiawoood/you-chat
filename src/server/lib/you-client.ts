// Cookie-based You.com API client
// Uses the undocumented browser API (you.com/api/streamingSearch) with per-user cookies

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function commonHeaders(ds: string, dsr: string): Record<string, string> {
  return {
    "User-Agent": BROWSER_UA,
    Cookie: `DS=${ds}; DSR=${dsr}`,
  };
}

/** Parse claims from DS JWT (base64url-decoded payload) */
function parseDsClaims(ds: string): Record<string, unknown> {
  try {
    const payload = ds.split(".")[1];
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(padded));
  } catch {
    return {};
  }
}

/**
 * Build the full cookie string needed for delete operations.
 * The delete endpoint requires DS + DSR + uuid_guest + ld_context.
 * We construct ld_context from the DS JWT claims + uuid_guest.
 */
function deleteCookieHeader(ds: string, dsr: string, uuidGuest: string): string {
  if (!uuidGuest) return `DS=${ds}; DSR=${dsr}`;

  const claims = parseDsClaims(ds);
  const ldContext = {
    kind: "user",
    key: uuidGuest,
    email: claims.email || "",
    country: "US",
    userAgent: BROWSER_UA,
    secUserAgent: "UNKNOWN",
    tenantId: claims.tenants ? Object.keys(claims.tenants as Record<string, unknown>)[0] || "" : "",
    subscriptionTier: claims.subscriptionTier || "",
  };
  const ldEncoded = encodeURIComponent(JSON.stringify(ldContext));
  return `DS=${ds}; DSR=${dsr}; uuid_guest=${uuidGuest}; ld_context=${ldEncoded}`;
}

// ─── Stream Chat ────────────────────────────────────────────

export type StreamEvent =
  | { type: "thinking"; message: string }
  | { type: "token"; text: string }
  | { type: "done" };

export interface StreamChatOptions {
  query: string;
  chatHistory: Array<{ question: string; answer: string }>;
  chatId: string;
  agentOrModel: string; // e.g. "user_mode_xxx" or "claude_4_5_opus"
  dsCookie: string;
  dsrCookie: string;
  pastChatLength?: number;
}

export async function* streamChat(
  options: StreamChatOptions
): AsyncGenerator<StreamEvent, void, unknown> {
  const {
    query,
    chatHistory,
    chatId,
    agentOrModel,
    dsCookie,
    dsrCookie,
    pastChatLength = 0,
  } = options;

  const conversationTurnId = crypto.randomUUID();
  const chatString = JSON.stringify(chatHistory);

  const params = new URLSearchParams({
    chatId,
    conversationTurnId,
    pastChatLength: String(pastChatLength),
    selectedChatMode: agentOrModel,
    domain: "youchat",
    use_nested_youchat_updates: "true",
    page: "1",
    count: "10",
    safeSearch: "off",
  });

  const body = JSON.stringify({ query, chat: chatString });

  const response = await fetch(
    `https://you.com/api/streamingSearch?${params}`,
    {
      method: "POST",
      headers: {
        ...commonHeaders(dsCookie, dsrCookie),
        "Content-Type": "text/plain;charset=UTF-8",
      },
      body,
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `You.com API error: ${response.status} - ${errorText.slice(0, 200)}`
    );
  }

  if (!response.body) {
    throw new Error("No response body from You.com");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    let currentEvent = "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("event: ")) {
        currentEvent = trimmed.slice(7);
      } else if (trimmed.startsWith("data: ")) {
        const data = trimmed.slice(6);
        if (currentEvent === "youChatUpdate") {
          try {
            const parsed = JSON.parse(data);
            // Thinking status: {"msg": "Thinking", "done": false}
            if (parsed.msg && !parsed.done) {
              yield { type: "thinking", message: parsed.msg };
            }
          } catch {
            // skip
          }
        } else if (currentEvent === "youChatToken") {
          try {
            const parsed = JSON.parse(data);
            if (parsed.youChatToken) {
              yield { type: "token", text: parsed.youChatToken };
            }
          } catch {
            // skip malformed JSON
          }
        } else if (currentEvent === "done") {
          yield { type: "done" };
          return;
        }
      }
    }
  }
}

// ─── Non-streaming Chat ─────────────────────────────────────

export interface CallChatOptions {
  query: string;
  agentOrModel: string;
  dsCookie: string;
  dsrCookie: string;
  _chatId?: string; // optional: pass a known chatId so caller can delete the thread after
}

export async function callChat(options: CallChatOptions): Promise<string> {
  const { query, agentOrModel, dsCookie, dsrCookie, _chatId } = options;

  let result = "";
  for await (const event of streamChat({
    query,
    chatHistory: [],
    chatId: _chatId || crypto.randomUUID(),
    agentOrModel,
    dsCookie,
    dsrCookie,
    pastChatLength: 0,
  })) {
    if (event.type === "token") {
      result += event.text;
    }
  }
  return result;
}

// ─── Validate Cookies ───────────────────────────────────────

export async function validateCookies(
  ds: string,
  dsr: string
): Promise<{ email: string; name: string; subscription?: string }> {
  // /api/user/me returns 500 — use custom_assistants endpoint instead,
  // which includes creator info (name, email) in the response
  const response = await fetch(
    "https://you.com/api/custom_assistants/assistants?filter_type=all&page[size]=1&page[number]=1",
    { headers: commonHeaders(ds, dsr) }
  );

  if (!response.ok) {
    throw new Error(`Cookie validation failed: ${response.status}`);
  }

  const data = await response.json();

  // Extract user info from the first agent's creator_info
  let email = "";
  let name = "";
  const agents = data.user_chat_modes || [];
  if (agents.length > 0 && agents[0].creator_info) {
    const info = agents[0].creator_info;
    email = info.email || "";
    name = info.name || `${info.first_name || ""} ${info.last_name || ""}`.trim();
  }

  // If no agents exist, try the org tenant endpoint for the name
  if (!name) {
    try {
      const tenantRes = await fetch("https://you.com/api/organization/tenant", {
        headers: commonHeaders(ds, dsr),
      });
      if (tenantRes.ok) {
        const tenants = await tenantRes.json();
        if (Array.isArray(tenants) && tenants.length > 0) {
          name = tenants[0].name || "";
        }
      }
    } catch {
      // optional
    }
  }

  // Get subscription info
  let subscription: string | undefined;
  try {
    const subRes = await fetch("https://you.com/api/user/getYouProState", {
      headers: commonHeaders(ds, dsr),
    });
    if (subRes.ok) {
      const subData = await subRes.json();
      const orgSubs = subData.org_subscriptions || [];
      if (orgSubs.length > 0) {
        subscription = orgSubs[0].plan_name || orgSubs[0].service || undefined;
      }
    }
  } catch {
    // subscription info is optional
  }

  return { email, name, subscription };
}

// ─── List Custom Agents ─────────────────────────────────────

export async function listAgents(
  ds: string,
  dsr: string
): Promise<
  Array<{ id: string; name: string; model: string; turnCount: number }>
> {
  const url =
    "https://you.com/api/custom_assistants/assistants?filter_type=all&page[size]=500&page[number]=1";
  const response = await fetch(url, {
    headers: commonHeaders(ds, dsr),
  });

  if (!response.ok) {
    throw new Error(`Failed to list agents: ${response.status}`);
  }

  const data = await response.json();
  const agents = data.user_chat_modes || [];

  return agents.map(
    (a: {
      chat_mode_id: string;
      chat_mode_name: string;
      ai_model: string;
      chat_turn_count: number;
    }) => ({
      id: a.chat_mode_id,
      name: a.chat_mode_name,
      model: a.ai_model || "",
      turnCount: a.chat_turn_count || 0,
    })
  );
}

// ─── List Available Models ──────────────────────────────────

export async function listModels(
  ds: string,
  dsr: string
): Promise<Array<{ id: string; name: string; isProOnly: boolean }>> {
  const response = await fetch("https://you.com/api/get_ai_models", {
    headers: commonHeaders(ds, dsr),
  });

  if (!response.ok) {
    throw new Error(`Failed to list models: ${response.status}`);
  }

  const data = await response.json();
  const models = Array.isArray(data) ? data : data.models || [];

  return models.map(
    (m: { id: string; name: string; isProOnly?: boolean }) => ({
      id: m.id,
      name: m.name,
      isProOnly: m.isProOnly || false,
    })
  );
}

// ─── Delete Thread ──────────────────────────────────────────

export async function deleteThread(
  chatId: string,
  ds: string,
  dsr: string,
  uuidGuest?: string
): Promise<void> {
  const cookieStr = deleteCookieHeader(ds, dsr, uuidGuest || "");
  const response = await fetch(
    `https://you.com/api/chatThreads/${chatId}`,
    {
      method: "DELETE",
      headers: {
        "User-Agent": BROWSER_UA,
        Cookie: cookieStr,
      },
    }
  );

  if (!response.ok && response.status !== 404) {
    console.warn(`[deleteThread] Failed: HTTP ${response.status} for ${chatId} (has uuid_guest: ${!!uuidGuest})`);
  }
}

// ─── Refresh Cookies ────────────────────────────────────────

export async function refreshCookies(
  ds: string,
  dsr: string
): Promise<{ ds: string; dsr: string } | null> {
  try {
    const response = await fetch(
      "https://auth.you.com/v1/auth/refresh?dcs=t&dcr=f",
      {
        method: "POST",
        headers: {
          Cookie: `DS=${ds}; DSR=${dsr}`,
          "User-Agent": BROWSER_UA,
        },
      }
    );

    if (!response.ok) return null;

    const setCookies = response.headers.getSetCookie?.() || [];
    let newDs: string | null = null;
    let newDsr: string | null = null;

    for (const cookie of setCookies) {
      if (cookie.startsWith("DS=")) {
        newDs = cookie.split(";")[0]!.slice(3);
      } else if (cookie.startsWith("DSR=")) {
        newDsr = cookie.split(";")[0]!.slice(4);
      }
    }

    if (newDs && newDsr) {
      return { ds: newDs, dsr: newDsr };
    }
    return null;
  } catch {
    return null;
  }
}
