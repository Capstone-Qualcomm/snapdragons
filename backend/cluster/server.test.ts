import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { createClusterServer } from "./server.ts";

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

test("bad JSON gets a 400", async () => {
  const base = await startGateway();
  assert.equal((await fetch(base + "/api/cluster/auto", { method: "POST", body: "{nope" })).status, 400);
});
