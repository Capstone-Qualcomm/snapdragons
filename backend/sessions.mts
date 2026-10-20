import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Each browser gets a random "sid" cookie and its own connection state. The
// Jira, Slack and GitHub backends all read the same cookie because cookies
// ignore ports. Connected sessions are saved to disk so a restart keeps them.
// Browsers that never connected are dropped, oldest first, once there are more
// than MAX_IDLE, so requests without a cookie can't grow the map forever. One
// seen in the last SIGN_IN_MS may be on a provider's login page, so it stays.
const MAX_IDLE = 1000;
const SIGN_IN_MS = 10 * 60_000;
// ponytail: past MAX_SESSIONS even recent browsers go, so a flood can still cut off sign-ins in progress
const MAX_SESSIONS = 20_000;

export function createSessions<T, Saved extends { connected: boolean }>(
  name: string,
  create: (saved?: Saved) => T,
  toSaved: (state: T) => Saved,
) {
  const dataDir = process.env.DATA_DIR ?? fileURLToPath(new URL("../.data", import.meta.url));
  const file = join(dataDir, `${name}-sessions.json`);
  const secure = process.env.APP_URL?.startsWith("https") ? "; Secure" : "";
  const sessions = new Map<string, T>();
  const lastSeen = new Map<string, number>();
  // What the file holds for each connected browser, to tell when it is out of date.
  const onDisk = new Map<string, string>();
  const saveKey = (state: T) => (toSaved(state).connected ? JSON.stringify(toSaved(state)) : undefined);

  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, Saved>;
    for (const [sid, connection] of Object.entries(saved)) {
      sessions.set(sid, create(connection));
      onDisk.set(sid, JSON.stringify(connection));
    }
  }

  function save() {
    const connected: Record<string, Saved> = {};
    const next = new Map<string, string>();
    for (const [sid, state] of sessions) {
      const key = saveKey(state);
      if (key) {
        connected[sid] = toSaved(state);
        next.set(sid, key);
      }
    }
    try {
      mkdirSync(dataDir, { recursive: true });
      // Write a temp file and rename it, so a crash mid-write can't leave half a file.
      writeFileSync(`${file}.tmp`, JSON.stringify(connected), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
      // Only a write that landed counts, so a failed one is retried next request.
      onDisk.clear();
      for (const [sid, key] of next) onDisk.set(sid, key);
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
    lastSeen.set(sid, Date.now());
    if (!existing) evictIdle();
    // Write to disk only when this browser's connection differs from the file.
    const id = sid;
    res.on("finish", () => {
      if (saveKey(state) !== onDisk.get(id)) save();
    });
    return state;
  }

  function evictIdle() {
    let idle = 0;
    for (const state of sessions.values()) if (!toSaved(state).connected) idle++;
    const recent = Date.now() - SIGN_IN_MS;
    for (const [sid, state] of sessions) {
      if (idle <= MAX_IDLE) break;
      // The map runs oldest first, so every browser from here on was seen recently.
      if ((lastSeen.get(sid) ?? 0) > recent && sessions.size <= MAX_SESSIONS) break;
      if (!toSaved(state).connected) {
        sessions.delete(sid);
        lastSeen.delete(sid);
        idle--;
      }
    }
  }

  return { get, size: () => sessions.size };
}
