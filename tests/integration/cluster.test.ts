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
  tasks: Array<{ id: string; status: string; worker: string | null; lostBy: string[] }>;
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

test("a worker killed mid-task has its task finished by another worker", async () => {
  const { server } = createClusterServer({ leaseMs: 1000 });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const url = `http://localhost:${(server.address() as AddressInfo).port}`;
  const workers = new Map<string, ChildProcess>();

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
      const env = { ...process.env, WORKER_ID: name, CLUSTER_URL: url, WORK_MS: "1500", HEARTBEAT_MS: "200" };
      workers.set(name, spawn(process.execPath, [workerFile], { env, stdio: "ignore" }));
    }
    await until((current) => current.workers.length === names.length);

    for (let n = 1; n <= 6; n++) {
      await fetch(`${url}/api/cluster/tasks`, { method: "POST", body: JSON.stringify({ input: `task ${n}` }) });
    }
    const busy = await until((current) => current.tasks.some((task) => task.worker === "Q-02" && task.status === "claimed"));
    const victim = busy.tasks.find((task) => task.worker === "Q-02" && task.status === "claimed")!;

    // SIGKILL, like pulling the power: no cleanup, no goodbye to the queue.
    workers.get("Q-02")!.kill("SIGKILL");

    const done = await until((current) => current.tasks.every((task) => task.status === "done"));
    const handedOver = done.tasks.find((task) => task.id === victim.id)!;
    assert.deepEqual(handedOver.lostBy, ["Q-02"]);
    assert.notEqual(handedOver.worker, "Q-02");
  } finally {
    for (const worker of workers.values()) worker.kill();
    server.close();
  }
});

test("nodes started from the queue server split a job, and a killed one's step is finished by another", async () => {
  const { server } = createClusterServer({ workMs: 1500 });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const url = `http://localhost:${(server.address() as AddressInfo).port}`;
  type Live = State & { workers: Array<{ id: string; alive: boolean }>; tasks: Array<{ input: string }> };

  async function until(check: (current: Live) => boolean): Promise<Live> {
    for (let attempt = 0; attempt < 150; attempt++) {
      const current = (await (await fetch(`${url}/api/cluster/state`)).json()) as Live;
      if (check(current)) return current;
      await sleep(100);
    }
    throw new Error("Timed out waiting for the cluster.");
  }

  function post(path: string, body: unknown = {}): Promise<Response> {
    return fetch(url + path, { method: "POST", body: JSON.stringify(body) });
  }

  try {
    for (const name of names) assert.equal((await (await post("/api/cluster/nodes")).json()).id, name);
    await until((current) => current.workers.length === names.length);

    await post("/api/cluster/jobs", { name: "Morning refresh", steps: ["Fetch Jira", "Fetch Slack", "Fetch GitHub"], then: "Rank" });
    const busy = await until((current) => current.tasks.some((task) => task.worker === "Q-02" && task.status === "claimed"));
    const victim = busy.tasks.find((task) => task.worker === "Q-02" && task.status === "claimed")!;
    assert.equal((await post("/api/cluster/nodes/Q-02/kill")).status, 200);

    const done = await until((current) => current.tasks.every((task) => task.status === "done"));
    const handedOver = done.tasks.find((task) => task.id === victim.id)!;
    assert.deepEqual(handedOver.lostBy, ["Q-02"]);
    assert.notEqual(handedOver.worker, "Q-02");
    assert.equal(done.tasks.at(-1)!.input, "Rank");
    assert.equal(done.workers.find((worker) => worker.id === "Q-02")!.alive, false);

    assert.equal((await post("/api/cluster/nodes/Q-02/start")).status, 200);
    await until((current) => current.workers.some((worker) => worker.id === "Q-02" && worker.alive));
  } finally {
    server.close();
  }
});
