import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createClusterServer } from "../../backend/cluster/server.ts";

const workerFile = fileURLToPath(new URL("../../backend/cluster/worker.ts", import.meta.url));
const names = ["Q-01", "Q-02", "Q-03"];

type State = {
  tasks: Array<{ id: string; status: string; worker: string | null }>;
  workers: Array<{ id: string; done: number }>;
};

test("three worker processes split a shared queue, each task done once", async () => {
  const { server } = createClusterServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const url = `http://localhost:${(server.address() as AddressInfo).port}`;
  const workers: ChildProcess[] = [];

  async function state(): Promise<State> {
    return (await (await fetch(`${url}/api/cluster/state`)).json()) as State;
  }

  async function until(check: (current: State) => boolean): Promise<State> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = await state();
      if (check(current)) return current;
      await sleep(100);
    }
    throw new Error("Timed out waiting for the cluster.");
  }

  try {
    for (const name of names) {
      workers.push(spawn(process.execPath, [workerFile], { env: { ...process.env, WORKER_ID: name, CLUSTER_URL: url, WORK_MS: "100" }, stdio: "ignore" }));
    }
    // Queue the work only once all three have checked in, so none of them misses the start.
    await until((current) => current.workers.length === names.length);

    for (let n = 1; n <= 9; n++) {
      await fetch(`${url}/api/cluster/tasks`, { method: "POST", body: JSON.stringify({ input: `task ${n}` }) });
    }
    const done = await until((current) => current.tasks.length === 9 && current.tasks.every((task) => task.status === "done"));

    assert.equal(done.workers.reduce((total, worker) => total + worker.done, 0), 9);
    for (const name of names) {
      assert.ok(done.tasks.some((task) => task.worker === name), `${name} did no work`);
    }
  } finally {
    for (const worker of workers) worker.kill();
    server.close();
  }
});
