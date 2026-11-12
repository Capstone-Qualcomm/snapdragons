import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { createSourceActivity } from "./source-activity.mts";

export function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

const maxBodyLength = 1024 * 1024;

// Throws when the body is not a JSON object or is over 1 MB, so callers can answer 400.
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  // Past the limit, keep reading but drop the rest, so the client finishes sending and gets the answer.
  for await (const chunk of req) if (body.length <= maxBodyLength) body += chunk;
  if (body.length > maxBodyLength) throw new Error("Request body is too large.");
  const value: unknown = JSON.parse(body);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request body must be a JSON object.");
  return value as Record<string, unknown>;
}

// OAuth state values handed out by /auth/<source>/start. Each one works once,
// for ten minutes, and expired ones are dropped when a new sign-in starts.
export function createPendingStates<T extends object = object>() {
  const pending = new Map<string, T & { expiresAt: number }>();

  function add(data: T): string {
    const now = Date.now();
    for (const [state, entry] of pending) {
      if (entry.expiresAt < now) pending.delete(state);
    }
    const state = randomBytes(32).toString("hex");
    pending.set(state, { ...data, expiresAt: now + 10 * 60 * 1000 });
    return state;
  }

  function take(state: string): T | undefined {
    const entry = pending.get(state);
    pending.delete(state);
    return entry && entry.expiresAt >= Date.now() ? entry : undefined;
  }

  return { add, take };
}

type Session = {
  connection: { connected: boolean; enabled: boolean };
  auth: { reset: () => void };
  activity: ReturnType<typeof createSourceActivity>;
};

type SourceServerOptions<S extends Session> = {
  name: string;
  title: string;
  port: number;
  appUrl: string;
  session: (req: IncomingMessage, res: ServerResponse) => S;
  status: (session: S) => Record<string, unknown>;
  // The list Today shows, served at GET /api/<name>/<items>.
  items: string;
  loadItems: (session: S) => Promise<unknown[]>;
  // Sign-in and anything else the source needs. Returns false when it has no such route.
  routes: (req: IncomingMessage, res: ServerResponse, url: URL, session: S) => Promise<boolean>;
};

// What the Jira, Slack, GitHub, Outlook and Teams backends have in common: connection status,
// turning a source on or off, disconnecting, the items list with its activity
// log, and only taking POSTs from the app's own pages.
export function createSourceServer<S extends Session>({ name, title, port, appUrl, session, status, items, loadItems, routes }: SourceServerOptions<S>) {
  const appOrigin = new URL(appUrl).origin;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const current = session(req, res);
      const { connection, auth, activity } = current;
      const route = `${req.method} ${url.pathname}`;

      if (req.method === "POST" && req.headers.origin !== appOrigin) {
        send(res, 403, { error: "This request must come from the application." });
        return;
      }

      if (route === `GET /api/${name}/connection`) {
        send(res, 200, { [name]: status(current) });
        return;
      }

      if (route === `GET /api/${name}/activity`) {
        send(res, 200, { events: activity.list() });
        return;
      }

      if (route === `GET /api/${name}/${items}`) {
        if (!connection.connected) {
          activity.add(401);
          send(res, 401, { error: `${title} is not connected. Connect ${title}.` });
          return;
        }
        if (!connection.enabled) {
          activity.add(403);
          send(res, 403, { error: `${title} is turned off. Turn it on.` });
          return;
        }
        try {
          const list = await loadItems(current);
          activity.add(200, list.length);
          send(res, 200, { [items]: list });
        } catch (error) {
          const message = error instanceof Error ? error.message : `${title} could not load ${items}.`;
          const failed = message.includes(`Reconnect ${title}`) || message.includes("not connected") ? 401 : 502;
          activity.add(failed);
          send(res, failed, { error: message });
        }
        return;
      }

      if (route === `POST /api/${name}/connection/disconnect`) {
        auth.reset();
        send(res, 200, { [name]: status(current) });
        return;
      }

      if (route === `POST /api/${name}/connection/enabled`) {
        let enabled: unknown;
        try {
          enabled = (await readJson(req)).enabled;
        } catch {
          send(res, 400, { error: "Invalid request body" });
          return;
        }
        if (typeof enabled !== "boolean" || (enabled && !connection.connected)) {
          send(res, 400, { error: `${title} must be connected before it can be turned on.` });
          return;
        }
        connection.enabled = enabled;
        send(res, 200, { [name]: status(current) });
        return;
      }

      // The source's own API routes (reading a thread, posting a comment, editing an issue) need it
      // connected and turned on, like the items list. Sign-in routes don't.
      if (url.pathname.startsWith(`/api/${name}/`)) {
        if (!connection.connected) {
          send(res, 401, { error: `${title} is not connected. Connect ${title}.` });
          return;
        }
        if (!connection.enabled) {
          send(res, 403, { error: `${title} is turned off. Turn it on.` });
          return;
        }
      }

      if (!(await routes(req, res, url, current))) send(res, 404, { error: "Not found" });
    } catch (error) {
      if (!res.headersSent) send(res, 500, { error: error instanceof Error ? error.message : "Internal server error" });
    }
  });

  // Caddy runs in the same container and proxies to localhost, so loopback is
  // enough. Set HOST to listen somewhere else.
  const host = process.env.HOST ?? "127.0.0.1";
  server.listen(port, host, () => {
    console.log(`${title} backend listening on http://${host}:${(server.address() as AddressInfo).port}`);
  });
  return server;
}
