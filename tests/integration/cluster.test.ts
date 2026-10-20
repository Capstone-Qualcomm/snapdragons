import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { createClusterServer } from "../../backend/cluster/server.ts";

// Real node processes behind the gateway, with fast timings so each test takes seconds.
type Run = { worker: string; from: number; outcome: string };
type State = {
  orchestrator: string | null;
  term: number | null;
  members: string[];
  nodes: Array<{ id: string; up: boolean }>;
  tasks: Array<{ id: string; status: string; worker: string | null; job: string; progress: number; lostBy: string[]; runs: Run[] }>;
  jobs: Array<{ id: string; doneAt: number | null; nodes: number | null }>;
};

async function startCluster(nodePort: number, size = 3, dataDir = mkdtempSync(join(tmpdir(), "cluster-test-"))) {
  const { server, startCluster: startNodes, stopNodes } = createClusterServer({
    port: 0,
    nodePort,
    dataDir,
    nodeEnv: { WORK_MS: "1500", LEASE_MS: "1000", RAFT_HEARTBEAT_MS: "100", RAFT_ELECTION_MIN_MS: "500", RAFT_ELECTION_MAX_MS: "1000" },
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  startNodes(size);

  const state = async () => (await (await fetch(`${base}/api/cluster/state`)).json()) as State;
  async function until(check: (current: State) => boolean, what: string): Promise<State> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const current = await state();
      if (check(current)) return current;
      await sleep(100);
    }
    throw new Error(`Timed out waiting until ${what}.`);
  }
  const post = (path: string, body: unknown = {}) => fetch(base + path, { method: "POST", body: JSON.stringify(body) });
  const refresh = async () => ((await (await post("/api/cluster/refresh")).json()) as { job: { id: string } }).job.id;
  const jobDone = (job: string) => (current: State) => current.jobs.some((entry) => entry.id === job && entry.doneAt !== null);

  const close = () => {
    server.close();
    stopNodes();
  };
  try {
    await until((current) => current.orchestrator !== null && current.nodes.filter((node) => node.up).length >= size, "an orchestrator is elected");
  } catch (cause) {
    close();
    throw cause;
  }
  return { state, until, post, refresh, jobDone, close };
}

test("three nodes elect an orchestrator and split a refresh, each step done once", async () => {
  const cluster = await startCluster(4601);
  try {
    const job = await cluster.refresh();
    const done = await cluster.until(cluster.jobDone(job), "the refresh is done");
    const steps = done.tasks.filter((task) => task.job === job);

    assert.equal(steps.length, 7);
    for (const step of steps) assert.deepEqual(step.runs.map((run) => run.outcome), ["done"]);
    assert.equal(done.jobs.find((entry) => entry.id === job)!.nodes, 3);
  } finally {
    cluster.close();
  }
});

test("killing the orchestrator mid-step: a new one is elected and the step resumes from its checkpoint", async () => {
  const cluster = await startCluster(4611);
  try {
    const job = await cluster.refresh();
    const busy = await cluster.until((current) => current.tasks.some((task) => task.worker === current.orchestrator && task.status === "claimed" && task.progress >= 0.3), "the orchestrator is partway through a step");
    const old = { id: busy.orchestrator!, term: busy.term! };
    const victim = busy.tasks.find((task) => task.worker === old.id && task.status === "claimed")!;

    // SIGKILL, like pulling the power on the board that holds the queue.
    assert.equal((await cluster.post(`/api/cluster/nodes/${old.id}/kill`)).status, 200);
    const after = await cluster.until((current) => current.orchestrator !== null && current.orchestrator !== old.id, "a new orchestrator is elected");
    assert.ok(after.term! > old.term);

    const done = await cluster.until(cluster.jobDone(job), "the refresh is done");
    const resumed = done.tasks.find((task) => task.id === victim.id)!;
    assert.deepEqual(resumed.lostBy, [old.id]);
    assert.equal(resumed.runs[0].outcome, "lost");
    assert.ok(resumed.runs[1].from >= 0.3, `resumed from ${resumed.runs[1].from}`);
    assert.ok(done.tasks.filter((task) => task.job === job).every((task) => task.status === "done"));
  } finally {
    cluster.close();
  }
});

test("every node restarts at once and the queue comes back from disk", async () => {
  const cluster = await startCluster(4621);
  try {
    const job = await cluster.refresh();
    await cluster.until(cluster.jobDone(job), "the refresh is done");

    await cluster.post("/api/cluster/restart");
    await cluster.until((current) => current.nodes.every((node) => !node.up), "every node is down");
    // A new orchestrator replays the saved log once its first entry commits.
    const back = await cluster.until((current) => current.orchestrator !== null && cluster.jobDone(job)(current), "the queue is back");
    assert.equal(back.nodes.filter((node) => node.up).length, 3);
    assert.equal(back.tasks.filter((task) => task.job === job).length, 7);
  } finally {
    cluster.close();
  }
});

test("a node is added, then removed after it finishes its step", async () => {
  const cluster = await startCluster(4631, 2);
  try {
    assert.deepEqual(await (await cluster.post("/api/cluster/nodes")).json(), { id: "Q-03" });
    await cluster.until((current) => current.members.includes("Q-03") && current.nodes.some((node) => node.id === "Q-03" && node.up), "Q-03 joins");

    const job = await cluster.refresh();
    await cluster.until((current) => current.tasks.some((task) => task.worker === "Q-03" && task.status === "claimed"), "Q-03 works on a step");
    assert.equal((await cluster.post("/api/cluster/nodes/Q-03/remove")).status, 200);

    const gone = await cluster.until((current) => !current.members.includes("Q-03") && !current.nodes.some((node) => node.id === "Q-03"), "Q-03 leaves");
    const step = gone.tasks.find((task) => task.runs.some((run) => run.worker === "Q-03"))!;
    assert.deepEqual(step.runs.map((run) => [run.worker, run.outcome]), [["Q-03", "done"]]);
    await cluster.until(cluster.jobDone(job), "the refresh is done");
  } finally {
    cluster.close();
  }
});

test("a cluster grown to six nodes comes back as six when the gateway starts again", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cluster-test-"));
  const first = await startCluster(4641, 3, dataDir);
  try {
    for (const id of ["Q-04", "Q-05", "Q-06"]) {
      assert.deepEqual(await (await first.post("/api/cluster/nodes")).json(), { id });
      await first.until((current) => current.members.includes(id) && current.nodes.some((node) => node.id === id && node.up), `${id} joins`);
    }
  } finally {
    first.close();
  }
  await sleep(500);

  // The same command as before: three nodes, but the saved logs say there are six.
  const again = await startCluster(4641, 3, dataDir);
  try {
    const back = await again.state();
    assert.equal(back.members.length, 6);
    assert.equal(back.nodes.filter((node) => node.up).length, 6);
  } finally {
    again.close();
  }
});

test("Add with every node dead brings the saved members back instead of starting a new cluster", async () => {
  const cluster = await startCluster(4651);
  try {
    const job = await cluster.refresh();
    await cluster.until(cluster.jobDone(job), "the refresh is done");
    for (const id of ["Q-01", "Q-02", "Q-03"]) assert.equal((await cluster.post(`/api/cluster/nodes/${id}/kill`)).status, 200);
    await cluster.until((current) => current.nodes.every((node) => !node.up), "every node is down");

    assert.equal((await cluster.post("/api/cluster/nodes")).status, 201);
    const back = await cluster.until((current) => current.orchestrator !== null && cluster.jobDone(job)(current), "the saved cluster is back");
    assert.deepEqual(back.members, ["Q-01", "Q-02", "Q-03"]);
  } finally {
    cluster.close();
  }
});
