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
function runNode(port: number, dataDir: string) {
  return spawn(process.execPath, [fileURLToPath(new URL("./node.ts", import.meta.url)), "Q-01"], {
    env: { ...process.env, NODE_ID: "Q-01", CLUSTER_PEERS: `Q-01=http://127.0.0.1:${port}`, CLUSTER_DATA: dataDir, CLUSTER_BOOTSTRAP: "Q-01" },
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
