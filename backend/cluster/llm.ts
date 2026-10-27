// One chat completion from the team's model on Azure AI Foundry (DeepSeek-V4.1-Flash unless
// AZURE_AI_MODEL says otherwise). With AZURE_AI_ENDPOINT and AZURE_AI_KEY set it calls Azure
// itself. A board has no key, so it asks the gateway at LLM_URL, which calls Azure for it.
export type Message = { role: "system" | "user" | "assistant"; content: string };

export async function complete(messages: Message[], maxTokens = 800): Promise<string> {
  const { AZURE_AI_ENDPOINT: endpoint, AZURE_AI_KEY: key, LLM_URL: proxy } = process.env;
  if (!(endpoint && key)) {
    if (!proxy) throw new Error("The model is not configured. Set AZURE_AI_ENDPOINT and AZURE_AI_KEY, or LLM_URL on a board.");
    const response = await fetch(proxy, { method: "POST", body: JSON.stringify({ messages, maxTokens }), signal: AbortSignal.timeout(90_000) });
    const data = (await response.json()) as { text?: string; error?: string };
    if (!response.ok) throw new Error(data.error ?? `The model call failed (HTTP ${response.status}).`);
    return data.text ?? "";
  }
  const response = await fetch(`${endpoint.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ model: process.env.AZURE_AI_MODEL ?? "DeepSeek-V4.1-Flash", messages, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`The model call failed (HTTP ${response.status}).`);
  const result = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return result.choices?.[0]?.message?.content ?? "";
}

// The first JSON object in a reply, since models sometimes wrap it in prose or a code fence.
export function jsonFrom<T>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("The model did not answer in JSON.");
  return JSON.parse(text.slice(start, end + 1)) as T;
}
