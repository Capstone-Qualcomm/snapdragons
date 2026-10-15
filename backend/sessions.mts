import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Each browser gets a random "sid" cookie and its own connection state. The
// Jira, Slack and GitHub backends all read the same cookie because cookies
// ignore ports. Connected sessions are saved to disk so a restart keeps them.
export function createSessions<T, S extends { connected: boolean }>(
  name: string,
  create: (saved?: S) => T,
  toSaved: (state: T) => S,
) {
  const dataDir = process.env.DATA_DIR ?? fileURLToPath(new URL("../.data", import.meta.url));
  const file = join(dataDir, `${name}-sessions.json`);
  const secure = process.env.APP_URL?.startsWith("https") ? "; Secure" : "";
  const sessions = new Map<string, T>();

  let lastSaved = "{}";
  try {
    lastSaved = readFileSync(file, "utf8");
  } catch {
    // Nothing saved yet.
  }
  for (const [sid, saved] of Object.entries(JSON.parse(lastSaved) as Record<string, S>)) {
    sessions.set(sid, create(saved));
  }

  function save() {
    const connected: Record<string, S> = {};
    for (const [sid, state] of sessions) {
      const saved = toSaved(state);
      if (saved.connected) connected[sid] = saved;
    }
    const json = JSON.stringify(connected);
    if (json === lastSaved) return;
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(`${file}.tmp`, json, { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
      lastSaved = json;
    } catch (error) {
      console.error(`Could not save ${name} sessions:`, error instanceof Error ? error.message : error);
    }
  }

  function get(req: IncomingMessage, res: ServerResponse): T {
    let sid = req.headers.cookie?.match(/(?:^|;\s*)sid=([0-9a-f]{64})(?:;|$)/)?.[1];
    if (!sid) {
      sid = randomBytes(32).toString("hex");
      res.setHeader("Set-Cookie", `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
    }
    let state = sessions.get(sid);
    if (!state) {
      state = create();
      sessions.set(sid, state);
    }
    res.on("finish", save);
    return state;
  }

  return { get };
}
