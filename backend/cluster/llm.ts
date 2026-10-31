// One chat completion from the team's model on Azure AI Foundry (DeepSeek-V4.1-Flash unless
// AZURE_AI_MODEL says otherwise). With AZURE_AI_ENDPOINT and AZURE_AI_KEY set it calls Azure
// itself. A board has no key, so it asks the gateway's services (SERVICES_URL), which call Azure for it.
// With onText, the reply streams in and onText gets all of it so far after each piece.
export type Message = { role: "system" | "user" | "assistant"; content: string };

export async function complete(messages: Message[], maxTokens = 800, onText?: (text: string) => void): Promise<string> {
  const { AZURE_AI_ENDPOINT: endpoint, AZURE_AI_KEY: key, SERVICES_URL: services } = process.env;
  const proxy = services && `${services.replace(/\/$/, "")}/llm`;
  const stream = Boolean(onText);
  if (!(endpoint && key)) {
    if (!proxy) throw new Error("The model is not configured. Set AZURE_AI_ENDPOINT and AZURE_AI_KEY, or SERVICES_URL on a board.");
    const response = await fetch(proxy, { method: "POST", body: JSON.stringify({ messages, maxTokens, stream }), signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `The model call failed (HTTP ${response.status}).`);
    if (!stream) return ((await response.json()) as { text?: string }).text ?? "";
    // The gateway streams the reply as plain text.
    let text = "";
    const decoder = new TextDecoder();
    for await (const chunk of response.body!) {
      text += decoder.decode(chunk, { stream: true });
      onText!(text);
    }
    return text;
  }
  const response = await fetch(`${endpoint.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ model: process.env.AZURE_AI_MODEL ?? "DeepSeek-V4.1-Flash", messages, max_tokens: maxTokens, stream }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`The model call failed (HTTP ${response.status}).`);
  if (!stream) {
    const result = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return result.choices?.[0]?.message?.content ?? "";
  }
  // Server-sent events: one "data: {json}" line per piece, then "data: [DONE]".
  let text = "";
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body!) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const piece = (JSON.parse(line.slice(6)) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content;
      if (piece) {
        text += piece;
        onText!(text);
      }
    }
  }
  return text;
}

// The first JSON object in a reply, since models sometimes wrap it in prose or a code fence.
export function jsonFrom<T>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("The model did not answer in JSON.");
  return JSON.parse(text.slice(start, end + 1)) as T;
}
