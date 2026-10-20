import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Each browser gets a random "sid" cookie and its own connection state. The
// Jira, Slack and GitHub backends all read the same cookie because cookies
// ignore ports. Connected sessions are saved to disk so a restart keeps them.
// Only the most recent MAX_IDLE browsers that never connected stay in memory,
// so requests without a cookie can't grow the map forever.
const MAX_IDLE = 1000;

export function createSessions<T, Saved extends { connected: boolean }>(
  name: string,
  create: (saved?: Saved) => T,
  toSaved: (state: T) => Saved,
) {
  const dataDir = process.env.DATA_DIR ?? fileURLToPath(new URL("../.data", import.meta.url));
  const file = join(dataDir, `${name}-sessions.json`);
  const secure = process.env.APP_URL?.startsWith("https") ? "; Secure" : "";
  const sessions = new Map<string, T>();

  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, Saved>;
    for (const [sid, connection] of Object.entries(saved)) sessions.set(sid, create(connection));
  }

  function save() {
    const connected: Record<string, Saved> = {};
    for (const [sid, state] of sessions) {
      if (toSaved(state).connected) connected[sid] = toSaved(state);
    }
    try {
      mkdirSync(dataDir, { recursive: true });
      // Write a temp file and rename it, so a crash mid-write can't leave half a file.
      writeFileSync(`${file}.tmp`, JSON.stringify(connected), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch (error) {
      console.error(`Could not save ${name} sessions:`, error);
    }
  }

  function get(req: IncomingMessage, res: ServerResponse): T {
    let sid = req.headers.cookie?.match(/(?:^|;\s*)sid=([0-9a-f]{64})/)?.[1];
    if (!sid) {
      sid = randomBytes(32).toString("hex");
      res.setHeader("Set-Cookie", `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
    }
    const existing = sessions.get(sid);
    const state = existing ?? create();
    // Re-insert so the map runs from least to most recently used.
    sessions.delete(sid);
    sessions.set(sid, state);
    if (!existing) evictIdle();
    // Write to disk only when this request changed what gets saved.
    const before = JSON.stringify(toSaved(state));
    res.on("finish", () => {
      if (JSON.stringify(toSaved(state)) !== before) save();
    });
    return state;
  }

  function evictIdle() {
    let idle = 0;
    for (const state of sessions.values()) if (!toSaved(state).connected) idle++;
    for (const [sid, state] of sessions) {
      if (idle <= MAX_IDLE) break;
      if (!toSaved(state).connected) {
        sessions.delete(sid);
        idle--;
      }
    }
  }

  return { get, size: () => sessions.size };
}
