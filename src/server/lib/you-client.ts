// Cookie-based You.com API client
// Uses the undocumented browser API (you.com/api/streamingSearch) with per-user cookies

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function cookieHeader(ds: string, dsr: string): string {
  return `DS=${ds}; DSR=${dsr}`;
}

function commonHeaders(ds: string, dsr: string): Record<string, string> {
  return {
    "User-Agent": BROWSER_UA,
    Cookie: cookieHeader(ds, dsr),
  };
}

// ─── Stream Chat ────────────────────────────────────────────

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
): AsyncGenerator<string, void, unknown> {
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
        if (currentEvent === "youChatToken") {
          try {
            const parsed = JSON.parse(data);
            if (parsed.youChatToken) {
              yield parsed.youChatToken;
            }
          } catch {
            // skip malformed JSON
          }
        } else if (currentEvent === "done") {
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
}

export async function callChat(options: CallChatOptions): Promise<string> {
  const { query, agentOrModel, dsCookie, dsrCookie } = options;

  let result = "";
  for await (const token of streamChat({
    query,
    chatHistory: [],
    chatId: crypto.randomUUID(),
    agentOrModel,
    dsCookie,
    dsrCookie,
    pastChatLength: 0,
  })) {
    result += token;
  }
  return result;
}

// ─── Validate Cookies ───────────────────────────────────────

export async function validateCookies(
  ds: string,
  dsr: string
): Promise<{ email: string; name: string; subscription?: string }> {
  const response = await fetch("https://you.com/api/user/me", {
    headers: commonHeaders(ds, dsr),
  });

  if (!response.ok) {
    throw new Error(`Cookie validation failed: ${response.status}`);
  }

  const data = await response.json();

  // Try to get subscription info
  let subscription: string | undefined;
  try {
    const subRes = await fetch("https://you.com/api/subscriptions/user", {
      headers: commonHeaders(ds, dsr),
    });
    if (subRes.ok) {
      const subData = await subRes.json();
      subscription = subData.subscription_type || subData.plan || undefined;
    }
  } catch {
    // subscription info is optional
  }

  return {
    email: data.email || data.data?.email || "",
    name: data.name || data.data?.name || data.username || "",
    subscription,
  };
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
  dsr: string
): Promise<void> {
  const response = await fetch(
    `https://you.com/api/chatThreads/${chatId}`,
    {
      method: "DELETE",
      headers: commonHeaders(ds, dsr),
    }
  );

  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to delete thread: ${response.status}`);
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
          Cookie: cookieHeader(ds, dsr),
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
