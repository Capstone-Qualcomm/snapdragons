import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { createClusterServer } from "./server.ts";

const servers = new Set<Server>();

async function startServer(): Promise<string> {
  const { server } = createClusterServer({ port: 0 });
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return `http://localhost:${(server.address() as AddressInfo).port}`;
}

function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

afterEach(() => {
  for (const server of servers) server.close();
  servers.clear();
});

test("a task goes from queued to claimed to done over HTTP", async () => {
  const base = await startServer();

  const added = await post(base, "/api/cluster/tasks", { input: "summarize inbox" });
  assert.equal(added.status, 201);

  const claimed = await (await post(base, "/api/cluster/claim", { worker: "Q-01" })).json();
  assert.equal(claimed.task.id, "T-1");
  assert.equal(claimed.task.status, "claimed");

  const completed = await post(base, "/api/cluster/complete", { id: "T-1", worker: "Q-01", result: "done" });
  assert.equal(completed.status, 200);

  const state = await (await fetch(base + "/api/cluster/state")).json();
  assert.equal(state.tasks[0].status, "done");
  assert.equal(state.workers[0].done, 1);
});

test("claim returns a null task when the queue is empty", async () => {
  const base = await startServer();
  const claimed = await (await post(base, "/api/cluster/claim", { worker: "Q-01" })).json();
  assert.equal(claimed.task, null);
});

test("a worker cannot complete a task another worker claimed", async () => {
  const base = await startServer();
  await post(base, "/api/cluster/tasks", { input: "a" });
  await post(base, "/api/cluster/claim", { worker: "Q-01" });

  const completed = await post(base, "/api/cluster/complete", { id: "T-1", worker: "Q-02", result: "mine" });
  assert.equal(completed.status, 409);
});

test("bad requests get a 400", async () => {
  const base = await startServer();
  assert.equal((await post(base, "/api/cluster/tasks", {})).status, 400);
  assert.equal((await post(base, "/api/cluster/claim", { worker: 7 })).status, 400);
  const notJson = await fetch(base + "/api/cluster/claim", { method: "POST", body: "{nope" });
  assert.equal(notJson.status, 400);
});
