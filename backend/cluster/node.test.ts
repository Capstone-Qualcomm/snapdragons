import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Each test runs a node as its own process, the way the gateway starts them.
function runNode(port: number, dataDir: string, env: Record<string, string> = {}) {
  return spawn(process.execPath, [fileURLToPath(new URL("./node.ts", import.meta.url)), "Q-01"], {
    env: { ...process.env, ...env, NODE_ID: "Q-01", CLUSTER_PEERS: `Q-01=http://127.0.0.1:${port}`, CLUSTER_DATA: dataDir, CLUSTER_BOOTSTRAP: "Q-01" },
  });
}

// This machine's address on a network, if it has one.
const lan = Object.values(networkInterfaces()).flat().find((address) => address?.family === "IPv4" && !address.internal)?.address;

test("a node only listens on loopback", { skip: !lan && "no network address to try" }, async () => {
  const node = runNode(4981, mkdtempSync(join(tmpdir(), "node-test-")));
  try {
    await sleep(500);
    assert.equal((await fetch("http://127.0.0.1:4981/status")).status, 200);
    await assert.rejects(fetch(`http://${lan}:4981/status`, { signal: AbortSignal.timeout(1000) }));
  } finally {
    node.kill();
  }
});

// The gateway passes its environment on to every node, HOST included.
test("a node stays on loopback, where its peers reach it, when HOST is set for the gateway", { skip: !lan && "no network address to try" }, async () => {
  const node = runNode(4983, mkdtempSync(join(tmpdir(), "node-test-")), { HOST: lan! });
  try {
    await sleep(500);
    assert.equal((await fetch("http://127.0.0.1:4983/status")).status, 200);
  } finally {
    node.kill();
  }
});

test("a node with a damaged log stops and names the file, leaving it as it was", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "node-test-"));
  writeFileSync(join(dataDir, "Q-01.json"), "{damaged");
  const node = runNode(4982, dataDir);
  let stderr = "";
  node.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = once(node, "exit");
  try {
    const [code] = await Promise.race([exited, sleep(3000).then(() => [null])]);
    assert.notEqual(code, null, "the node kept running");
    assert.notEqual(code, 0);
    assert.match(stderr, /Q-01\.json/);
  } finally {
    node.kill();
  }
  assert.equal(readFileSync(join(dataDir, "Q-01.json"), "utf8"), "{damaged");
});

test("a new node joins a running cluster by asking a member, and a powered-off node stops answering until powered on", async () => {
  const peers = "Q-01=http://127.0.0.1:4985,Q-02=http://127.0.0.1:4986";
  const start = (id: string, env: Record<string, string>) =>
    spawn(process.execPath, [fileURLToPath(new URL("./node.ts", import.meta.url)), id], { env: { ...process.env, NODE_ID: id, CLUSTER_PEERS: peers, CLUSTER_DATA: mkdtempSync(join(tmpdir(), "node-test-")), ...env } });
  const first = start("Q-01", { CLUSTER_BOOTSTRAP: "Q-01" });
  const second = start("Q-02", { CLUSTER_JOIN: "Q-01" });
  const status = async (port: number) => (await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1000) })).json();
  try {
    let members: string[] = [];
    for (let n = 0; n < 40 && members.length < 2; n++, await sleep(250)) members = (await status(4985).catch(() => ({ members: [] }))).members;
    assert.deepEqual(members.sort(), ["Q-01", "Q-02"]);
    await fetch("http://127.0.0.1:4986/power", { method: "POST", body: JSON.stringify({ on: false }) });
    await assert.rejects(status(4986));
    await fetch("http://127.0.0.1:4986/power", { method: "POST", body: JSON.stringify({ on: true }) });
    assert.deepEqual((await status(4986)).members.sort(), ["Q-01", "Q-02"]);
  } finally {
    first.kill();
    second.kill();
  }
});

test("a board that saved a log while waiting to be added, but never was, asks to join again after a restart", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "node-test-"));
  // What a waiting board saves when the orchestrator's first messages reach it: a term, no members.
  writeFileSync(join(dataDir, "q-late.json"), JSON.stringify({ term: 3, votedFor: null, log: [], snapshot: { index: 0, term: 0, members: [], state: null } }));
  const asked: string[] = [];
  const { createServer } = await import("node:http");
  const gateway = createServer((req, res) => {
    asked.push(req.url ?? "");
    res.end(JSON.stringify({ bootstrap: true }));
  });
  await new Promise<void>((resolve) => gateway.listen(4987, "127.0.0.1", resolve));
  const node = spawn(process.execPath, [fileURLToPath(new URL("./node.ts", import.meta.url)), "q-late"], {
    env: { ...process.env, NODE_ID: "q-late", NODE_PORT: "4988", CLUSTER_DATA: dataDir, CLUSTER_JOIN_URL: "http://127.0.0.1:4987/join" },
  });
  try {
    let members: string[] = [];
    for (let n = 0; n < 40 && !members.length; n++, await sleep(250)) members = (await (await fetch("http://127.0.0.1:4988/status").catch(() => null))?.json().catch(() => null))?.members ?? [];
    assert.ok(asked.some((url) => url.includes("id=q-late")), "it asked the gateway where to go");
    assert.deepEqual(members, ["q-late"], "told to start the cluster, it did, despite the old log");
  } finally {
    node.kill();
    gateway.close();
  }
});
