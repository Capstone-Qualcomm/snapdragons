import { createSign } from "node:crypto";

// One chat completion from the team's model on GCP (GCP_AI_MODEL). With GCP_AI_ENDPOINT, GCP_AI_KEY
// and GCP_AI_MODEL set it calls GCP itself. A board has no key, so it asks the gateway's services
// (SERVICES_URL), which call GCP for it.
// With onText, the reply streams in and onText gets all of it so far after each piece.
export type Message = { role: "system" | "user" | "assistant"; content: string };

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

// GCP's org policy forbids static API keys, so GCP_AI_KEY is a service account's JSON, base64-encoded,
// traded here for an hour-long token. No error may quote the key or the signed request.
async function mintToken(key: string): Promise<{ token: string; expiresAt: number }> {
  let assertion: string;
  let tokenUri: string;
  try {
    const account = JSON.parse(Buffer.from(key, "base64").toString("utf8")) as { client_email: string; private_key: string; token_uri: string };
    tokenUri = account.token_uri;
    const issuedAt = Math.floor(Date.now() / 1000);
    const claims = { iss: account.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: tokenUri, iat: issuedAt, exp: issuedAt + 3600 };
    const unsigned = `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url(claims)}`;
    assertion = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(account.private_key, "base64url")}`;
  } catch {
    throw new Error("GCP_AI_KEY is not a usable base64-encoded service account JSON.");
  }
  let response: Response;
  try {
    response = await fetch(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Could not reach GCP for a model token.");
  }
  const result = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!response.ok || !result.access_token) throw new Error(`GCP refused the model token (HTTP ${response.status}).`);
  return { token: result.access_token, expiresAt: Date.now() + Number(result.expires_in ?? 0) * 1000 };
}

let cached: { key: string; token: string; expiresAt: number } | null = null;
let refreshing: { key: string; token: Promise<string> } | null = null;

// One token per key, refreshed a minute before it expires, and callers during a refresh share it.
function accessToken(key: string): Promise<string> {
  if (cached?.key === key && Date.now() < cached.expiresAt - 60_000) return Promise.resolve(cached.token);
  if (refreshing?.key === key) return refreshing.token;
  const token = mintToken(key)
    .then((minted) => {
      cached = { key, ...minted };
      return minted.token;
    })
    .finally(() => {
      refreshing = null;
    });
  refreshing = { key, token };
  return token;
}

export async function complete(messages: Message[], maxTokens = 800, onText?: (text: string) => void, signal?: AbortSignal): Promise<string> {
  const { GCP_AI_ENDPOINT: endpoint, GCP_AI_KEY: key, GCP_AI_MODEL: model, SERVICES_URL: services } = process.env;
  const proxy = services && `${services.replace(/\/$/, "")}/llm`;
  const stream = Boolean(onText);
  if (!(endpoint && key && model)) {
    if (!proxy) throw new Error("The model is not configured. Set GCP_AI_ENDPOINT, GCP_AI_KEY and GCP_AI_MODEL, or SERVICES_URL on a board.");
    const response = await fetch(proxy, { method: "POST", body: JSON.stringify({ messages, maxTokens, stream }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) });
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
  const token = await accessToken(key);
  const response = await fetch(`${endpoint.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, stream }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
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
