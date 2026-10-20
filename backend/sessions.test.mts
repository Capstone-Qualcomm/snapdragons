import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { createSessions } from "./sessions.mts";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "snapdragons-sessions-"));

type State = { connected: boolean };

// A request with an optional sid cookie, and a response that can finish.
function request(sid?: string) {
  const req = { headers: sid ? { cookie: `sid=${sid}` } : {} } as IncomingMessage;
  const res = Object.assign(new EventEmitter(), { setHeader() {} }) as unknown as ServerResponse;
  return { req, res, finish: () => res.emit("finish") };
}

test("browsers without a cookie don't pile up", () => {
  const sessions = createSessions<State, State>("idle", (saved) => saved ?? { connected: false }, (s) => s);
  const connected = "a".repeat(64);
  sessions.get(request(connected).req, request().res).connected = true;
  for (let i = 0; i < 1500; i++) sessions.get(request().req, request().res);
  assert.equal(sessions.size(), 1001);
  // The connected browser is never evicted.
  assert.equal(sessions.get(request(connected).req, request().res).connected, true);
});

test("only a change in connection writes to disk", () => {
  const file = join(process.env.DATA_DIR!, "save-sessions.json");
  const sessions = createSessions<State, State>("save", (saved) => saved ?? { connected: false }, (s) => s);
  const sid = "b".repeat(64);

  let r = request(sid);
  sessions.get(r.req, r.res);
  r.finish();
  assert.equal(existsSync(file), false);

  r = request(sid);
  sessions.get(r.req, r.res).connected = true;
  r.finish();
  const written = statSync(file).mtimeMs;

  r = request(sid);
  sessions.get(r.req, r.res);
  r.finish();
  assert.equal(statSync(file).mtimeMs, written);
});
