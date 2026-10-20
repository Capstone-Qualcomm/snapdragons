import { apiPath } from "./urls";

// GETs, or POSTs body as JSON, to one of the backends. Any failure becomes an
// Error whose message can be shown on the page as it is.
export async function api<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiPath(path), body === undefined ? { cache: "no-store" } : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Could not reach the app server. Check that it is running.");
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || result === null) throw new Error(result?.error ?? `The app server answered with HTTP ${response.status}.`);
  return result as T;
}
