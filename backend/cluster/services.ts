import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";

// The demo company's systems: mail, calendar and the hiring req, as small HTTP APIs.
// The gateway serves them next to the model, on the boards' tailnet, so no board holds the
// data: every board asks for what it needs, the way it would ask a real mail or calendar server.
// The data is made up (scenarios/data/interviews.json).

export type Email = { id: number; from: { name: string; email: string }; date: string; subject: string; body: string; attachments?: Array<{ name: string; text: string }> };
export type Busy = { who: string; day: string; start: string; end: string; what: string };
export type Role = { company: string; role: string; job: string; deadline: string; manager: { name: string; email: string; title: string }; panel: string[]; week: string[] };
type Data = Role & { busy: Busy[]; emails: Email[] };

let data: Data | null = null;
// Read on first use, so a board, which never serves these, does not need the file.
const demo = () => (data ??= JSON.parse(readFileSync(new URL("./scenarios/data/interviews.json", import.meta.url), "utf8")) as Data);

// The routes, for the gateway's service port. Returns false for a path that is not one of them.
export function serveDemo(path: string, query: URLSearchParams, send: (res: ServerResponse, status: number, body: unknown) => void, res: ServerResponse): boolean {
  const { emails, busy, ...role } = demo();
  if (path === "/hiring/role") return send(res, 200, role), true;
  // The inbox as a mail client lists it: newest first, without bodies.
  if (path === "/mail/inbox") return send(res, 200, { owner: role.manager, messages: emails.map(({ body: _body, attachments, ...head }) => ({ ...head, attachments: attachments?.map((file) => file.name) ?? [] })) }), true;
  const message = path.match(/^\/mail\/messages\/(\d+)$/);
  if (message) {
    const email = emails.find((entry) => entry.id === Number(message[1]));
    return send(res, email ? 200 : 404, email ?? { error: "No such message." }), true;
  }
  if (path === "/calendar/events") {
    const who = query.get("who");
    return send(res, 200, { events: busy.filter((block) => !who || block.who === who) }), true;
  }
  return false;
}

// Everything at once, for a person looking through the demo data on the page.
export const demoSample = () => ({ emails: demo().emails, busy: demo().busy, week: demo().week });

// A board's (or a node's) request to those systems, at SERVICES_URL.
export async function query<T>(path: string): Promise<T> {
  const base = process.env.SERVICES_URL;
  if (!base) throw new Error("SERVICES_URL is not set, so this node cannot reach mail or calendar.");
  const response = await fetch(base.replace(/\/$/, "") + path, { signal: AbortSignal.timeout(15_000) });
  const body = await response.json();
  if (!response.ok) throw new Error((body as { error?: string }).error ?? `${path} returned ${response.status}`);
  return body as T;
}
