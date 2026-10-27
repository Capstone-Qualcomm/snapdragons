import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createClusterServer } from "./server.ts";

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
