const YOU_API_URL = "https://api.you.com/v1/agents/runs";

export interface YouStreamChunk {
  response?: {
    delta?: string;
  };
}

// Non-streaming call for simple tasks like title generation
export async function callYouChat(input: string, agent: string = "express"): Promise<string> {
  const apiKey = process.env.YOU_API_KEY;
  if (!apiKey) {
    throw new Error("YOU_API_KEY is not set");
  }

  const response = await fetch(YOU_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      agent,
      input,
      stream: false,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`You.com API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  // Non-streaming response format: { output: [{ text: "...", type: "message.answer" }] }
  if (data.output && Array.isArray(data.output) && data.output.length > 0) {
    return data.output[0].text || "";
  }
  return data.response || "";
}

export async function* streamYouChat(
  input: string,
  agent: string = "express"
): AsyncGenerator<string, void, unknown> {
  const apiKey = process.env.YOU_API_KEY;
  if (!apiKey) {
    throw new Error("YOU_API_KEY is not set");
  }

  const response = await fetch(YOU_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      agent,
      input,
      stream: true,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`You.com API error: ${response.status} - ${error}`);
  }

  if (!response.body) {
    throw new Error("No response body");
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

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;

      const data = trimmed.slice(6);
      if (data === "[DONE]") {
        return;
      }

      try {
        const parsed: YouStreamChunk = JSON.parse(data);
        if (parsed.response?.delta) {
          yield parsed.response.delta;
        }
      } catch {
        // Skip non-JSON lines
      }
    }
  }
}
