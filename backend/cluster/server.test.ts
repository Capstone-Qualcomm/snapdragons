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

const morning = { name: "Morning refresh", steps: ["Fetch Jira", "Fetch Slack", "Fetch GitHub", "Fetch Outlook"], then: "Rank" };

test("a job is queued as steps, the last one waiting for the rest", async () => {
  const base = await startServer();
  const created = await post(base, "/api/cluster/jobs", morning);
  assert.equal(created.status, 201);

  const { job, tasks } = await created.json();
  assert.deepEqual(job, { id: "J-1", name: "Morning refresh" });
  assert.deepEqual(tasks.map((task: { input: string }) => task.input), [...morning.steps, "Rank"]);
  assert.deepEqual(tasks.at(-1).after, ["T-1", "T-2", "T-3", "T-4"]);
});

test("bad jobs and oversized input get a 400", async () => {
  const base = await startServer();
  const long = "x".repeat(81);
  assert.equal((await post(base, "/api/cluster/jobs", { name: "a" })).status, 400);
  assert.equal((await post(base, "/api/cluster/jobs", { name: "a", steps: [] })).status, 400);
  assert.equal((await post(base, "/api/cluster/jobs", { name: "a", steps: [1] })).status, 400);
  assert.equal((await post(base, "/api/cluster/jobs", { name: "a", steps: Array(9).fill("b") })).status, 400);
  assert.equal((await post(base, "/api/cluster/jobs", { name: long, steps: ["b"] })).status, 400);
  assert.equal((await post(base, "/api/cluster/jobs", { name: "a", steps: ["b"], then: "" })).status, 400);
  assert.equal((await post(base, "/api/cluster/tasks", { input: long })).status, 400);
});

test("the queue turns work away past 30 waiting tasks", async () => {
  const base = await startServer();
  for (let n = 0; n < 6; n++) assert.equal((await post(base, "/api/cluster/jobs", morning)).status, 201);

  assert.equal((await post(base, "/api/cluster/jobs", morning)).status, 429);
  assert.equal((await post(base, "/api/cluster/tasks", { input: "one more" })).status, 429);
  const state = await (await fetch(base + "/api/cluster/state")).json();
  assert.equal(state.tasks.length, 30);
});

test("only the six known node names can talk to the queue", async () => {
  const base = await startServer();
  assert.equal((await post(base, "/api/cluster/claim", { worker: "Q-07" })).status, 400);
  assert.equal((await post(base, "/api/cluster/heartbeat", { worker: "anything" })).status, 400);
  assert.equal((await post(base, "/api/cluster/claim", { worker: "Q-06" })).status, 200);
});

test("node routes only act on known nodes the server started", async () => {
  const base = await startServer();
  assert.equal((await post(base, "/api/cluster/nodes/Q-07/start", {})).status, 404);
  assert.equal((await post(base, "/api/cluster/nodes/..%2Fx/kill", {})).status, 404);
  assert.equal((await post(base, "/api/cluster/nodes/Q-01/kill", {})).status, 409);

  // Six nodes checked in from elsewhere, so there is no name left to add and none to start again.
  for (let n = 1; n <= 6; n++) await post(base, "/api/cluster/claim", { worker: `Q-0${n}` });
  assert.equal((await post(base, "/api/cluster/nodes", {})).status, 409);
  assert.equal((await post(base, "/api/cluster/nodes/Q-03/start", {})).status, 409);
  const state = await (await fetch(base + "/api/cluster/state")).json();
  assert.equal(state.maxNodes, 6);
});

test("a request body over 4 KB gets a 413", async () => {
  const base = await startServer();
  assert.equal((await post(base, "/api/cluster/tasks", { input: "x".repeat(5000) })).status, 413);
});
