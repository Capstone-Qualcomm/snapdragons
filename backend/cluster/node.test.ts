import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs, { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { fileStorage, setAsideDamagedLog } from "./node.ts";

// Each test runs a node as its own process, the way the gateway starts them.
function runNode(port: number, dataDir: string, env: Record<string, string> = {}) {
  return spawn(process.execPath, [fileURLToPath(new URL("./node.ts", import.meta.url)), "Q-01"], {
    env: { ...process.env, ...env, NODE_ID: "Q-01", CLUSTER_PEERS: `Q-01=http://127.0.0.1:${port}`, CLUSTER_DATA: dataDir, CLUSTER_BOOTSTRAP: "Q-01" },
  });
}

// This machine's address on a network, if it has one.
const lan = Object.values(networkInterfaces()).flat().find((address) => address?.family === "IPv4" && !address.internal)?.address;

test("a save reaches the disk before the rename, and the rename after it", () => {
  const file = join(mkdtempSync(join(tmpdir(), "node-test-")), "Q-01.json");
  const data = { term: 3, votedFor: "Q-02", log: [], snapshot: { index: 0, term: 0, state: null, members: ["Q-01"] } };
  const steps: string[] = [];
  const realFsync = fs.fsyncSync;
  const realRename = fs.renameSync;
  mock.method(fs, "fsyncSync", (fd: number) => {
    steps.push(fs.fstatSync(fd).isDirectory() ? "fsync directory" : "fsync file");
    realFsync(fd);
  });
  mock.method(fs, "renameSync", (from: string, to: string) => {
    steps.push("rename");
    realRename(from, to);
  });
  syncBuiltinESMExports();
  try {
    fileStorage(file).save(data as never);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.deepEqual(steps, process.platform === "win32" ? ["fsync file", "rename"] : ["fsync file", "rename", "fsync directory"]);
  assert.deepEqual(fileStorage(file).load(), data);
  assert.equal(existsSync(`${file}.tmp`), false);
});

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

test("a board with a damaged log rejoins only once a majority of the other members answer, and keeps the damaged file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "damaged-"));
  const file = join(dir, "q-a.json");
  writeFileSync(file, Buffer.alloc(32));
  const errors = mock.method(console, "error", () => {});
  let up = ["q-b"];
  let waits = 0;
  const others = async () => ["q-b", "q-c", "q-d"];
  const answers = async (member: string) => up.includes(member);
  await setAsideDamagedLog(file, others, answers, async () => {
    waits++;
    // One of three is not a majority, so the file stays until a second answers.
    assert.ok(existsSync(file));
    up = ["q-b", "q-c"];
  });
  errors.mock.restore();
  assert.equal(waits, 1);
  assert.equal(existsSync(file), false);
  const kept = readdirSync(dir).filter((name) => name.startsWith("q-a.json.damaged-"));
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(join(dir, kept[0])).length, 32);
});

test("a good or missing log is left alone, and an unreachable gateway does not count as a majority", async () => {
  const dir = mkdtempSync(join(tmpdir(), "damaged-"));
  const file = join(dir, "q-a.json");
  const never = async () => {
    throw new Error("nothing should be asked");
  };
  await setAsideDamagedLog(file, never, never, never);
  assert.equal(existsSync(file), false);
  fileStorage(file).save({ term: 1, votedFor: null, log: [], snapshot: { index: 0, term: 0, members: ["q-a"], state: null } } as never);
  await setAsideDamagedLog(file, never, never, never);
  assert.ok(existsSync(file));

  writeFileSync(file, "{damaged");
  const errors = mock.method(console, "error", () => {});
  await assert.rejects(setAsideDamagedLog(file, () => Promise.reject(new Error("offline")), never, async () => {
    assert.ok(existsSync(file));
    throw new Error("stop");
  }), /stop/);
  errors.mock.restore();
  assert.equal(readFileSync(file, "utf8"), "{damaged");
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

test("an orchestrator powered off past the lease does not expire its workers when powered on", async () => {
  const node = runNode(4989, mkdtempSync(join(tmpdir(), "node-test-")), { LEASE_MS: "1500" });
  const state = async () => (await fetch("http://127.0.0.1:4989/state", { signal: AbortSignal.timeout(1000) })).json();
  try {
    let workers: Array<{ alive: boolean }> = [];
    for (let n = 0; n < 40 && !workers.length; n++, await sleep(250)) workers = (await state().catch(() => ({ workers: [] }))).workers;
    assert.equal(workers.length, 1);
    await fetch("http://127.0.0.1:4989/power", { method: "POST", body: JSON.stringify({ on: false }) });
    await sleep(2500);
    await fetch("http://127.0.0.1:4989/power", { method: "POST", body: JSON.stringify({ on: true }) });
    await sleep(1000);
    const { events } = await state();
    assert.ok(!events.some((event: { text: string }) => event.text.includes("stopped responding")), JSON.stringify(events));
  } finally {
    node.kill();
  }
});
