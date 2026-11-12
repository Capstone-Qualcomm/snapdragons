import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createClusterServer, REFRESH } from "./server.ts";
import { ITEMS } from "./worker.ts";

// This machine's address on a network, if it has one.
const lan = Object.values(networkInterfaces()).flat().find((address) => address?.family === "IPv4" && !address.internal)?.address;

// These run the gateway with no nodes behind it. tests/integration starts real ones.
const servers = new Set<Server>();

async function startGateway(): Promise<string> {
  // A port range nothing else uses, so no stray node answers.
  const { server } = createClusterServer({ port: 0, nodePort: 4901 });
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return `http://localhost:${(server.address() as AddressInfo).port}`;
}

const post = (base: string, path: string, body: unknown = {}) => fetch(base + path, { method: "POST", body: JSON.stringify(body) });

afterEach(() => {
  for (const server of servers) server.close();
  servers.clear();
});

test("with no nodes running the state is empty and there is no orchestrator", async () => {
  const base = await startGateway();
  const state = await (await fetch(base + "/api/cluster/state")).json();
  assert.equal(state.orchestrator, null);
  assert.deepEqual(state.nodes, []);
  assert.deepEqual(state.tasks, []);
  assert.equal(state.maxNodes, 6);
  assert.equal(state.auto, false);
});

test("the refresh fetches from every source backend", () => {
  // Every backend folder with its own server, besides this one, is a source Today loads.
  const backend = fileURLToPath(new URL("..", import.meta.url));
  const sources = readdirSync(backend).filter((name) => name !== "cluster" && existsSync(join(backend, name, "server.ts")));
  const fetched = REFRESH.steps.map((step) => step.split(" ")[1].toLowerCase());
  assert.deepEqual([...fetched].sort(), [...sources].sort());
  // Each step's source sits at the same place, since the boards fetch by it.
  assert.deepEqual(REFRESH.sources, fetched);
  // And the boards know what each source's items are called, so a result reads "Loaded 4 Teams messages".
  assert.deepEqual(REFRESH.sources.filter((source) => !ITEMS[source]), []);
});

test("node routes only know the six node names", async () => {
  const base = await startGateway();
  assert.equal((await post(base, "/api/cluster/nodes/Q-07/start")).status, 404);
  assert.equal((await post(base, "/api/cluster/nodes/Q-01/kill")).status, 409);
  assert.equal((await post(base, "/api/cluster/nodes/Q-01/nope")).status, 404);
});

test("auto mode turns on and off", async () => {
  const base = await startGateway();
  assert.deepEqual(await (await post(base, "/api/cluster/auto", { on: true })).json(), { auto: true });
  assert.equal((await (await fetch(base + "/api/cluster/state")).json()).auto, true);
});

test("the Assistant lists its scenarios, and refuses one it does not have", async () => {
  const base = await startGateway();
  const { scenarios } = await (await fetch(base + "/api/assistant/scenarios")).json();
  assert.deepEqual(scenarios.map((scenario: { id: string }) => scenario.id), ["interviews", "ask", "student", "engineer", "business", "research"]);
  assert.ok(scenarios.every((scenario: { audience: string; prompt: string; stages: string[] }) => scenario.audience && scenario.prompt && scenario.stages.length >= 3));
  // Every scenario says plainly what it runs on: demo data, or the model live.
  assert.ok(scenarios.every((scenario: { id: string; data: { label: string } }) => (scenario.id === "ask" ? /^Live/ : /demo/i).test(scenario.data.label)));
  assert.equal((await post(base, "/api/assistant/run", { scenario: "nope" })).status, 400);
});

test("bad JSON gets a 400", async () => {
  const base = await startGateway();
  assert.equal((await fetch(base + "/api/cluster/auto", { method: "POST", body: "{nope" })).status, 400);
});

test("the gateway only listens on loopback", { skip: !lan && "no network address to try" }, async () => {
  const gateway = spawn(process.execPath, [fileURLToPath(new URL("./server.ts", import.meta.url))], {
    env: { ...process.env, CLUSTER_PORT: "4961", CLUSTER_NODE_PORT: "4971", CLUSTER_DATA: mkdtempSync(join(tmpdir(), "server-test-")) },
  });
  try {
    await once(gateway.stdout, "data");
    assert.equal((await fetch("http://127.0.0.1:4961/api/cluster/state")).status, 200);
    await assert.rejects(fetch(`http://${lan}:4961/api/cluster/state`, { signal: AbortSignal.timeout(1000) }));
  } finally {
    gateway.kill();
  }
});

test("with no cluster yet, only the first new board starts one and the next joins it", async () => {
  // Board names nothing answers to, so there are no members.
  const { server } = createClusterServer({ port: 0, boards: ["q-nobody-a"] });
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const ask = async (id: string) => (await fetch(`${base}/api/cluster/join?id=${id}`)).json();
  assert.deepEqual(await ask("q-nobody-a"), { bootstrap: true });
  assert.deepEqual(await ask("q-nobody-b"), { join: ["q-nobody-a"] });
  assert.deepEqual(await ask("q-nobody-a"), { bootstrap: true }, "the founder asking again is still told to start it");
  assert.equal((await fetch(`${base}/api/cluster/join?id=../etc`)).status, 400);
});

test("a board that never answers holds up only the first read of the state, not every one after it", async () => {
  // Takes connections and never answers, like a board that lost its network.
  const silent = createServer(() => {});
  servers.add(silent);
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const { server } = createClusterServer({ port: 0, boards: ["127.0.0.1"], nodePort: (silent.address() as AddressInfo).port });
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const state = async () => {
    const started = Date.now();
    const response = await fetch(`http://localhost:${(server.address() as AddressInfo).port}/api/cluster/state`);
    await response.json();
    return Date.now() - started;
  };

  assert.ok(await state() >= 2000, "the first read waits for the board's status");
  const second = await state();
  assert.ok(second < 500, `the next read answers without waiting, took ${second} ms`);
});

// One node that answers as the orchestrator and fails every membership change, like a request that timed out.
// The add lands in its log only if logsTheAdd, as Raft keeps a change it could not commit in time.
async function addThatFails(logsTheAdd: boolean) {
  const members = ["Q-01"];
  const orchestrator = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/status") return res.end(JSON.stringify({ id: "Q-01", role: "orchestrator", term: 1, orchestrator: "Q-01", votedFor: "Q-01", votes: ["Q-01"], members, commitIndex: 1, lastIndex: 1 }));
    if (logsTheAdd && !members.includes("Q-02")) members.push("Q-02");
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "timed out" }));
  });
  servers.add(orchestrator);
  await new Promise<void>((resolve) => orchestrator.listen(4921, "127.0.0.1", resolve));
  const { server } = createClusterServer({ port: 0, nodePort: 4921, dataDir: mkdtempSync(join(tmpdir(), "add-node-")) });
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return `http://localhost:${(server.address() as AddressInfo).port}`;
}

test("a node whose add timed out but reached the log keeps running, since the cluster needs it to commit that add", async () => {
  const base = await addThatFails(true);
  const added = await post(base, "/api/cluster/nodes");
  assert.equal(added.status, 201);
  assert.deepEqual(await added.json(), { id: "Q-02" });
  assert.equal((await post(base, "/api/cluster/nodes/Q-02/kill")).status, 200, "the node is still running");
});

test("a node the orchestrator never added goes away again", async () => {
  const base = await addThatFails(false);
  assert.ok((await post(base, "/api/cluster/nodes")).status >= 400);
  assert.equal((await post(base, "/api/cluster/nodes/Q-02/kill")).status, 409, "the node is gone");
});

test("the services answer the boards' mail and calendar, and refuse the model without a key instead of calling themselves", async () => {
  const { server, servicesServer } = createClusterServer({ port: 0 });
  servers.add(server);
  servers.add(servicesServer);
  await new Promise<void>((resolve) => servicesServer.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(servicesServer.address() as AddressInfo).port}`;
  const inbox = await (await fetch(base + "/mail/inbox")).json();
  assert.ok(inbox.messages.length > 50 && !("body" in inbox.messages[0]), "the inbox lists emails without their bodies");
  assert.ok((await (await fetch(`${base}/mail/messages/${inbox.messages[0].id}`)).json()).body);
  const saved = { endpoint: process.env.GCP_AI_ENDPOINT, key: process.env.GCP_AI_KEY };
  delete process.env.GCP_AI_ENDPOINT;
  delete process.env.GCP_AI_KEY;
  try {
    const response = await fetch(base + "/llm", { method: "POST", body: JSON.stringify({ messages: [] }), signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 503);
  } finally {
    if (saved.endpoint) process.env.GCP_AI_ENDPOINT = saved.endpoint;
    if (saved.key) process.env.GCP_AI_KEY = saved.key;
  }
});

test("the services give no source list for an unknown source, or for a handle the gateway never gave a browser", async () => {
  // A source backend that would answer anyone, to show the gateway never gets as far as asking it.
  let asked = 0;
  const source = createServer((_req, res) => {
    asked++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ messages: [{ text: "secret" }] }));
  });
  servers.add(source);
  await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
  const sourceUrl = `http://127.0.0.1:${(source.address() as AddressInfo).port}`;
  const { server, servicesServer } = createClusterServer({ port: 0, sourceUrls: { slack: sourceUrl } });
  servers.add(server);
  servers.add(servicesServer);
  await new Promise<void>((resolve) => servicesServer.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(servicesServer.address() as AddressInfo).port}`;

  assert.equal((await fetch(`${base}/sources/dropbox?asker=x`)).status, 404);
  assert.equal((await fetch(`${base}/sources/constructor?asker=x`)).status, 404);
  const guessed = await fetch(`${base}/sources/slack?asker=00000000-0000-0000-0000-000000000000`);
  assert.equal(guessed.status, 410);
  assert.match((await guessed.json()).error, /no longer known/);
  assert.equal((await fetch(`${base}/sources/slack`)).status, 410);
  assert.equal(asked, 0);
});
